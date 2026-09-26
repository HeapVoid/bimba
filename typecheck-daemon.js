import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const [socketPath, tsserverPath, pluginProbe, runner, cwd, parentArg] = process.argv.slice(2);
const parentPid = Number(parentArg);
const clients = [];
const sourceByFile = new Map();
const openedFiles = new Set();
const skipDirs = new Set(['.bimba', '.cache', '.git', '.worktrees', 'build', 'dist', 'node_modules', 'public']);
let active = null;
let closing = false;
let ownsSocket = false;

const tsserver = spawn(runner, [
    tsserverPath,
    '--globalPlugins', 'typescript-imba-plugin',
    '--pluginProbeLocations', pluginProbe,
], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
tsserver.stdin.write(JSON.stringify({
    seq: 0,
    type: 'request',
    command: 'configure',
    arguments: {
        preferences: {}, hostInfo: 'bimba-typecheck',
        extraFileExtensions: [{ extension: '.imba', isMixedContent: false, scriptKind: 7 }],
    },
}) + '\n');

function stop() {
    if (closing) return;
    closing = true;
    clearInterval(parentTimer);
    active?.destroy();
    for (const client of clients) client.destroy();
    try { server.close(); } catch {}
    tsserver.kill();
    if (ownsSocket) {
        try { fs.unlinkSync(socketPath); } catch {}
    }
}

function scanImbaFiles(directory, files) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !skipDirs.has(entry.name)) scanImbaFiles(file, files);
        else if (entry.isFile() && entry.name.endsWith('.imba')) files.push(file);
    }
}

function syncSources(selected) {
    const files = [];
    scanImbaFiles(cwd, files);
    for (const file of selected.keys()) if (!files.includes(file)) files.push(file);
    let changed = false;
    let structureChanged = false;
    const hadSnapshot = sourceByFile.size > 0;
    const currentFiles = new Set(files);
    for (const file of sourceByFile.keys()) {
        if (!currentFiles.has(file)) {
            sourceByFile.delete(file);
            openedFiles.delete(file);
            structureChanged = true;
        }
    }
    for (const file of files) {
        let content;
        try { content = selected.has(file) ? selected.get(file) : fs.readFileSync(file, 'utf8'); }
        catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        const previous = sourceByFile.get(file);
        sourceByFile.set(file, content);
        if (previous === undefined && hadSnapshot) structureChanged = true;
        if (previous === undefined || previous === content) continue;
        changed = true;
        if (!openedFiles.has(file)) {
            tsserver.stdin.write(JSON.stringify({
                seq: 0, type: 'request', command: 'open',
                arguments: { file, fileContent: previous, projectRootPath: cwd },
            }) + '\n');
            openedFiles.add(file);
        }
        const lines = previous.split('\n');
        tsserver.stdin.write(JSON.stringify({
            seq: 0, type: 'request', command: 'change',
            arguments: {
                file, line: 1, offset: 1,
                endLine: lines.length, endOffset: lines.at(-1).length + 1,
                insertString: content,
            },
        }) + '\n');
    }
    if (structureChanged) tsserver.stdin.write(JSON.stringify({
        seq: 0, type: 'request', command: 'reloadProjects', arguments: {},
    }) + '\n');
    return changed || structureChanged;
}

function handleLine(client, line) {
    let message;
    try { message = JSON.parse(line); }
    catch { client.destroy(); return; }

    if (message.command === 'bimbaSync') {
        const selected = new Map(message.arguments.files.map(({ file, content }) => [file, content]));
        const changed = syncSources(selected);

        const response = JSON.stringify({
            seq: 0, type: 'response', command: 'bimbaSync',
            request_seq: message.seq, success: true, body: { changed },
        });
        client.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
    }
    else {
        if (message.command === 'open') openedFiles.add(message.arguments.file);
        if (!tsserver.stdin.write(line + '\n')) client.pause();
    }
}

function drain(client) {
    while (active === client && client.bimbaLines.length) {
        handleLine(client, client.bimbaLines.shift());
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
        if (active === client) {
            active = null;
            serveNext();
        }
    };
    client.on('end', release);
    client.on('close', release);
    serveNext();
});

tsserver.stdin.on('drain', () => active?.resume());
tsserver.stdout.on('data', chunk => active?.write(chunk));
tsserver.on('error', stop);
tsserver.on('exit', stop);
server.on('error', stop);
server.listen(socketPath, () => {
    ownsSocket = true;
    fs.chmodSync(socketPath, 0o600);
});

const parentTimer = setInterval(() => {
    if (process.ppid !== parentPid) stop();
}, 1000);

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
