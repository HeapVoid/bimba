import { startTypecheckWorker } from './typecheck-worker.js';
import fs from 'node:fs';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { TypecheckProject } from './typecheck-project.js';
import { parseMessages, encodeMessage } from './typecheck-protocol.js';
import { typecheckRevisions } from './typecheck-transport.js';

const [socketPath, tsserverPath, pluginProbe, runner, cwd, parentArg] = process.argv.slice(2);
const lifetime = parentArg.startsWith('{') ? JSON.parse(parentArg) : { parentPid: Number(parentArg) };
const session = lifetime.session;
let workerArgs = { cwd, tsserver: tsserverPath, pluginProbe, runner };
let workerRevision = session ? typecheckRevisions(workerArgs).worker : null;
const clients = [];
const pending = new Map();
const openedFiles = new Set();
const pluginProjects = new Set();
let project = new TypecheckProject(cwd, tsserverPath);
let active = null;
let worker = null;
let sequence = 0;
let unhealthy = false;
let closing = false;
let ownsSocket = false;
let idleTimer;
const warming = new Map();
let lastWarmup = null;

function idle() {
    clearTimeout(idleTimer);
    if (session && lifetime.idleMs > 0 && !closing && !active && !clients.length && !warming.size) {
        idleTimer = setTimeout(stop, lifetime.idleMs);
    }
}

function status() {
    return { session, engine: lifetime.engine, daemonPid: process.pid, workerPid: worker?.pid ?? null,
        warming: warming.size, lastWarmup };
}

async function control(client, message) {
    const reply = (body, error) => client.end(encodeMessage({ type: 'response', command: 'bimbaSession',
        request_seq: message.seq, success: !error, ...(error ? { message: error.message } : { body }) }));
    try {
        if (!session) throw new Error('This server is not a named typecheck session');
        const { action, files, wait } = message.arguments;
        if (action === 'status') { reply(status()); return; }
        if (action === 'stop') {
            // Flush the control response, then cancel any unfinished work. Its
            // clients receive disconnect, never an incomplete successful result.
            client.end(encodeMessage({ type: 'response', command: 'bimbaSession', request_seq: message.seq,
                success: true, body: { session, stopped: true } }), stop);
            return;
        }
        if (action !== 'warm') throw new Error('Unknown typecheck session operation');
        if (message.arguments.engine !== lifetime.engine) throw new Error('Typecheck session implementation changed; start the session again');
        if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string')) {
            throw new Error('Session warmup requires a nonempty source selection');
        }
        clearTimeout(idleTimer);
        const selection = [...new Set(files)].sort();
        const key = JSON.stringify(selection);
        let job = warming.get(key);
        if (!job) {
            const started = Date.now();
            // This uses the same real checker as the CLI. It connects back to
            // the ordinary serialized work queue; the control channel is separate.
            job = Promise.resolve().then(async () => {
                const { checkImbaTypes } = await import('./typecheck.js');
                const passed = await checkImbaTypes(selection, { cwd, session });
                return { passed, files: selection.length, elapsedMs: Date.now() - started, completedAt: Date.now() };
            }).catch(error => ({ passed: false, files: selection.length, error: error.message, completedAt: Date.now() }))
                .then(result => { lastWarmup = result; return result; })
                .finally(() => { warming.delete(key); idle(); });
            warming.set(key, job);
        }
        if (wait) {
            const completed = await job;
            reply({ ...status(), lastWarmup: completed });
        } else reply(status());
    } catch (error) { reply(null, error); }
}

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
    pluginProjects.clear();
    unhealthy = false;
    const child = worker = startTypecheckWorker({ ...workerArgs,
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
    if (message.event === 'bimbaPluginReady') pluginProjects.add(message.body.project);
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
    clearTimeout(idleTimer);
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
    if (message.command === 'bimbaInvalidate') {
        unhealthy = true;
        client.write(encodeMessage({ type: 'response', command: 'bimbaInvalidate', request_seq: message.seq,
            success: true, body: {} }));
        return;
    }
    if (message.command === 'bimbaSync') {
        try {
            let toolchainChanged = false;
            if (session) {
                if (message.arguments.engine !== lifetime.engine) throw new Error('Typecheck session implementation changed; start the session again');
                const toolchain = message.arguments.toolchain;
                if (toolchain.revision !== workerRevision) {
                    workerArgs = { cwd, tsserver: toolchain.tsserver, pluginProbe: toolchain.pluginProbe, runner: toolchain.runner };
                    workerRevision = toolchain.revision;
                    project = new TypecheckProject(cwd, toolchain.tsserver);
                    toolchainChanged = true;
                }
            }
            const selected = new Map(message.arguments.files.map(({ file, content }) => [file, content]));
            const state = project.sync(selected);
            if (toolchainChanged) { state.reset = true; state.reasons.push('toolchain'); }
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
                success: true, body: { changed: reset || state.changes.length > 0, imbaChanged: state.changes.some(change => change.file.endsWith('.imba')), reset, reasons: state.reasons, workerPid: worker.pid, pluginProjects: [...pluginProjects] } }));
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
    if (active) { clearTimeout(idleTimer); drain(active); }
    else idle();
}

const server = net.createServer(client => {
    client.bimbaLines = [];
    const decoder = new StringDecoder('utf8');
    let input = '';
    client.on('data', chunk => {
        input += decoder.write(chunk);
        while (true) {
            const end = input.indexOf('\n');
            if (end < 0) break;
            const line = input.slice(0, end);
            input = input.slice(end + 1);
            if (!line) continue;
            if (!client.bimbaMode) {
                let message;
                try { message = JSON.parse(line); } catch { client.destroy(); return; }
                if (message.command === 'bimbaSession') {
                    client.bimbaMode = 'control';
                    control(client, message);
                    continue;
                }
                client.bimbaMode = 'work';
                clearTimeout(idleTimer);
                clients.push(client);
            }
            if (client.bimbaMode === 'work') client.bimbaLines.push(line);
        }
        if (active === client) drain(client);
        else serveNext();
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
});

server.on('error', stop);
server.listen(socketPath, () => { ownsSocket = true; fs.chmodSync(socketPath, 0o600); idle(); });
const parentTimer = setInterval(() => {
    if (lifetime.parentPid && process.ppid !== lifetime.parentPid) stop();
    if (lifetime.ownerPid) {
        try { process.kill(lifetime.ownerPid, 0); }
        catch (error) { if (error.code === 'ESRCH') stop(); }
    }
}, 250);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
