import { startTypecheckWorker } from './typecheck-worker.js';
import fs from 'node:fs';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { TypecheckProject } from './typecheck-project.js';
import { parseMessages, encodeMessage } from './typecheck-protocol.js';

const [socketPath, tsserverPath, pluginProbe, runner, cwd, parentArg] = process.argv.slice(2);
const parentPid = Number(parentArg);
const clients = [];
const pending = new Map();
const openedFiles = new Set();
const project = new TypecheckProject(cwd, tsserverPath);
let active = null;
let worker = null;
let sequence = 0;
let unhealthy = false;
let closing = false;
let ownsSocket = false;

function send(message, client = null) {
    const seq = ++sequence;
    if (client) pending.set(seq, { client, seq: message.seq, command: message.command });
    if (!worker.stdin.write(JSON.stringify({ ...message, seq }) + '\n')) client?.pause();
}

function startWorker() {
    const previous = worker;
    worker = null;
    previous?.kill();
    pending.clear();
    openedFiles.clear();
    unhealthy = false;
    const child = worker = startTypecheckWorker({ cwd, tsserver: tsserverPath, pluginProbe, runner,
        stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', chunk => {
        if (worker !== child) return;
        try { buffer = parseMessages(Buffer.concat([buffer, chunk]), receive); }
        catch { unhealthy = true; active?.destroy(); }
    });
    const exited = () => {
        if (worker !== child) return;
        worker = null;
        pending.clear();
        active?.destroy();
    };
    child.on('error', exited);
    child.on('exit', exited);
    child.stdin.on('error', exited);
    child.stdin.on('drain', () => active?.resume());
    send({ type: 'request', command: 'configure', arguments: {
        preferences: {}, hostInfo: 'bimba-typecheck',
        extraFileExtensions: [{ extension: '.imba', isMixedContent: false, scriptKind: 7 }],
    } });
}

function receive(message) {
    if (message.type === 'response' || message.event === 'requestCompleted') {
        const request = pending.get(message.request_seq ?? message.body?.request_seq);
        if (!request) return;
        if (message.type !== 'response' || request.command !== 'geterr') {
            pending.delete(message.request_seq ?? message.body?.request_seq);
        }
        if (message.type === 'response' && message.success === false) unhealthy = true;
        if (message.command === 'projectInfo' && message.success && message.body?.fileNames) {
            project.remember(message.body.fileNames);
        }
        if (!request.client || request.client !== active || request.client.destroyed) return;
        const mapped = message.type === 'response'
            ? { ...message, request_seq: request.seq }
            : { ...message, body: { ...message.body, request_seq: request.seq } };
        request.client.write(encodeMessage(mapped));
        return;
    }
    // Diagnostic events have no request ID. Only the active, serialized batch
    // can own them; an interrupted batch discards its worker before handoff.
    if (/^(syntax|semantic|suggestion)Diag$/.test(message.event)
        && ![...pending.values()].some(request => request.client === active && request.command === 'geterr')) return;
    active?.write(encodeMessage(message));
}

function stop() {
    if (closing) return;
    closing = true;
    clearInterval(parentTimer);
    active?.destroy();
    for (const client of clients) client.destroy();
    server.close();
    worker?.kill();
    if (ownsSocket) {
        try { fs.unlinkSync(socketPath); } catch {}
    }
}

function handle(client, line) {
    let message;
    try { message = JSON.parse(line); }
    catch { client.destroy(); return; }
    if (message.command === 'bimbaSync') {
        try {
            const selected = new Map(message.arguments.files.map(({ file, content }) => [file, content]));
            const state = project.sync(selected);
            // Legacy explicit refresh remains a recovery operation, never a default.
            if (message.arguments.refresh) { state.reset = true; state.reasons.push('explicit refresh'); }
            const reset = state.reset || !worker || unhealthy;
            if (reset) startWorker();
            if (!reset) for (const { file, previous, content } of state.changes) {
                if (!openedFiles.has(file)) {
                    send({ type: 'request', command: 'open', arguments: { file, fileContent: previous, projectRootPath: cwd } });
                    openedFiles.add(file);
                }
                const lines = previous.split('\n');
                send({ type: 'request', command: 'change', arguments: {
                    file, line: 1, offset: 1, endLine: lines.length, endOffset: lines.at(-1).length + 1, insertString: content,
                } });
            }
            client.write(encodeMessage({ type: 'response', command: 'bimbaSync', request_seq: message.seq,
                success: true, body: { changed: reset || state.changes.length > 0, imbaChanged: state.changes.some(change => change.file.endsWith('.imba')), reset, reasons: state.reasons, workerPid: worker.pid } }));
        } catch (error) {
            client.write(encodeMessage({ type: 'response', command: 'bimbaSync', request_seq: message.seq,
                success: false, message: error.message }));
        }
        return;
    }
    if (!worker) startWorker();
    if (message.command === 'open') openedFiles.add(message.arguments.file);
    if (message.command === 'close') openedFiles.delete(message.arguments.file);
    if (message.command === 'updateOpen') {
        for (const file of message.arguments.openFiles || []) openedFiles.add(file.file);
        for (const file of message.arguments.closedFiles || []) openedFiles.delete(file);
    }
    send(message, client);
}

function drain(client) {
    try {
        while (active === client && client.bimbaLines.length && !client.destroyed) handle(client, client.bimbaLines.shift());
    } catch {
        unhealthy = true;
        client.destroy();
    }
}

function serveNext() {
    if (active || closing) return;
    active = clients.shift() || null;
    if (active) drain(active);
}

const server = net.createServer(client => {
    client.bimbaLines = [];
    clients.push(client);
    const decoder = new StringDecoder('utf8');
    let input = '';
    client.on('data', chunk => {
        input += decoder.write(chunk);
        while (true) {
            const end = input.indexOf('\n');
            if (end < 0) break;
            const line = input.slice(0, end);
            input = input.slice(end + 1);
            if (line) client.bimbaLines.push(line);
        }
        if (active === client) drain(client);
    });
    client.on('error', () => client.destroy());
    const release = () => {
        const index = clients.indexOf(client);
        if (index >= 0) clients.splice(index, 1);
        if (active !== client) return;
        // Never deliver late responses/diagnostics to a subsequent socket.
        const interrupted = [...pending.values()].some(request => request.client === client);
        if (interrupted || unhealthy) {
            const previous = worker;
            worker = null;
            previous?.kill();
            pending.clear();
        }
        active = null;
        serveNext();
    };
    client.on('end', release);
    client.on('close', release);
    serveNext();
});

server.on('error', stop);
server.listen(socketPath, () => { ownsSocket = true; fs.chmodSync(socketPath, 0o600); });
const parentTimer = setInterval(() => { if (process.ppid !== parentPid) stop(); }, 1000);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
