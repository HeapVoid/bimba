import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTypecheckPlugin } from './typecheck-worker.js';
import { parseMessages } from './typecheck-protocol.js';

const daemonPath = fileURLToPath(new URL('./typecheck-daemon.js', import.meta.url));

function canonical(args) {
    return { ...args, cwd: fs.realpathSync(args.cwd),
        ...(args.tsserver ? { tsserver: fs.realpathSync(args.tsserver) } : {}),
        ...(args.pluginProbe ? { pluginProbe: fs.realpathSync(args.pluginProbe) } : {}) };
}

export function typecheckRuntime() {
    return process.env.BIMBA_NODE || process.execPath;
}

function connect(socketPath) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => {
            socket.setNoDelay(true);
            resolve(socket);
        });
        socket.once('error', error => {
            socket.destroy();
            reject(error);
        });
    });
}

function transport(socket) {
    const session = new EventEmitter();
    session.stdin = socket;
    session.stdout = socket;
    session.stderr = new EventEmitter();
    session.kill = () => socket.destroy();
    socket.on('error', error => session.emit('error', error));
    socket.on('close', () => session.emit('exit', null, 'disconnect'));
    return session;
}

export function typecheckEngine() {
    const implementation = ['package.json', 'typecheck.js', 'typecheck-transport.js',
        'typecheck-daemon.js', 'typecheck-project.js', 'typecheck-protocol.js',
        'typecheck-worker.js', 'compile-cache.js', 'compilation-store.cjs', 'plugin-compiler.cjs',
        'typecheck-plugin/index.cjs', 'typecheck-plugin/cache.cjs'];
    const engine = createHash('sha256');
    for (const file of implementation) engine.update(fs.readFileSync(new URL(file, import.meta.url)));
    return engine.digest('hex');
}

export function typecheckRevisions(args) {
    const { tsserver, pluginProbe, runner } = canonical(args);
    const plugin = resolveTypecheckPlugin(pluginProbe);
    const worker = createHash('sha256').update(JSON.stringify([tsserver, pluginProbe, plugin, runner]));
    for (const file of [tsserver, path.join(path.dirname(tsserver), '_tsserver.js'),
        path.join(path.dirname(tsserver), 'typescript.js'), plugin]) {
        if (fs.existsSync(file)) worker.update(fs.readFileSync(file));
    }
    return { engine: typecheckEngine(), worker: worker.digest('hex') };
}

function socketFor(args) {
    const { cwd, tsserver, pluginProbe, runner, session } = canonical(args);
    const directory = path.join(os.homedir(), '.cache', 'bimba');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (session) {
        // Session identity survives dependency updates. The daemon negotiates
        // the actual toolchain before each batch instead of losing its address.
        const identity = [fs.realpathSync(cwd), session, runner,
            process.env.NODE_OPTIONS || '', process.env.NODE_PATH || ''].join('\0');
        const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
        return path.join(directory, `session-${key}.sock`);
    }
    const revisions = typecheckRevisions({ cwd, tsserver, pluginProbe, runner });
    const identity = [cwd, tsserver, pluginProbe, runner, revisions.engine, revisions.worker,
        process.env.NODE_OPTIONS || '', process.env.NODE_PATH || ''].join('\0');
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    return path.join(directory, `${key}.sock`);
}

export async function connectTypecheckServer(args) {
    if (process.env.CI || process.env.BIMBA_NO_TYPECHECK_DAEMON === '1') return null;
    const socketPath = socketFor(args);

    try {
        return transport(await connect(socketPath));
    }
    catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error;
        return null;
    }
}

export async function launchDevTypecheckServer(args) {
    args = canonical(args);
    const socketPath = socketFor(args);
    const existing = await connectTypecheckServer(args);
    if (existing) {
        existing.kill();
        return null;
    }
    try { fs.unlinkSync(socketPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const child = spawn(process.execPath, [
        daemonPath, socketPath, args.tsserver, args.pluginProbe, args.runner, args.cwd, String(process.pid),
    ], { cwd: args.cwd, stdio: 'ignore' });
    process.once('exit', () => child.kill());

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        try {
            const socket = await connect(socketPath);
            socket.destroy();
            return child;
        }
        catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    throw new Error('Could not start the Bimba typecheck server');
}

// Explicit sessions are detached from individual CLI clients. Unnamed Dev
// servers above retain their existing parent-owned lifecycle.
export class TypecheckSession {
    constructor(args) {
        if (typeof args.session !== 'string' || !args.session.trim() || args.session.length > 128) {
            throw new Error('A typecheck session requires a nonempty name (up to 128 characters).');
        }
        this.args = canonical(args);
        this.socket = socketFor(this.args);
    }
    async request(action, parameters = {}) {
        const socket = await connect(this.socket);
        return new Promise((resolve, reject) => {
            let buffer = Buffer.alloc(0), complete = false;
            const finish = (error, body) => {
                if (complete) return;
                complete = true;
                clearTimeout(timer);
                socket.destroy();
                error ? reject(error) : resolve(body);
            };
            const timer = setTimeout(() => finish(new Error(`Typecheck session ${action} timed out`)), 130000);
            socket.on('error', error => finish(error));
            socket.on('close', () => finish(Object.assign(new Error('Typecheck session closed before replying'), { code: 'BIMBA_SESSION_CLOSED' })));
            socket.on('data', chunk => {
                try {
                    buffer = parseMessages(Buffer.concat([buffer, chunk]), message => {
                        if (message.type !== 'response' || message.request_seq !== 1) return;
                        finish(message.success ? null : new Error(message.message), message.body);
                    });
                } catch (error) { finish(error); }
            });
            socket.write(JSON.stringify({ seq: 1, type: 'request', command: 'bimbaSession',
                arguments: { action, ...parameters } }) + '\n');
        });
    }
    async status() {
        try { return await this.request('status'); }
        catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') return null;
            throw error;
        }
    }
    async start({ ownerPid = null, idleMs = 600000 } = {}) {
        if (process.env.CI || process.env.BIMBA_NO_TYPECHECK_DAEMON === '1') {
            throw new Error('Typecheck sessions are disabled in CI or BIMBA_NO_TYPECHECK_DAEMON mode.');
        }
        if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 2147483647) throw new Error('Session idle timeout must be an integer from 0 to 2147483647 milliseconds.');
        if (ownerPid !== null && (!Number.isSafeInteger(ownerPid) || ownerPid < 1)) throw new Error('Session owner must be a positive process ID.');
        if (idleMs === 0 && ownerPid === null) throw new Error('A session without an idle timeout requires an owner process.');
        const engine = typecheckRevisions(this.args).engine;
        const lock = this.socket + '.lock', token = randomUUID();
        const contender = lock + '.' + token;
        const deadline = Date.now() + 10000;
        let owned = false, child;
        // A fully written hard link is the atomic election; contenders never
        // observe an empty lock or unlink a newly listening peer's socket.
        fs.writeFileSync(contender, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
        try {
            while (Date.now() < deadline) {
                const existing = await this.status();
                if (existing) {
                    if (existing.engine !== engine) {
                        await this.stop();
                        await new Promise(resolve => setTimeout(resolve, 20));
                        continue;
                    }
                    return { ...existing, started: !!child };
                }
                if (!owned) {
                    try { fs.linkSync(contender, lock); owned = true; }
                    catch (error) {
                        if (error.code !== 'EEXIST') throw error;
                        let owner;
                        try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); }
                        catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
                        try { process.kill(owner.pid, 0); }
                        catch (probe) {
                            if (probe.code !== 'ESRCH') throw probe;
                            // Recheck the exact lock before removing a dead owner.
                            if (fs.readFileSync(lock, 'utf8') === JSON.stringify(owner)) fs.unlinkSync(lock);
                        }
                    }
                }
                if (owned && !child) {
                    // Recheck under the startup lock before removing a stale socket.
                    if (await this.status()) continue;
                    try { fs.unlinkSync(this.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                    const { cwd, tsserver, pluginProbe, runner, session } = this.args;
                    child = spawn(process.execPath, [daemonPath, this.socket, tsserver, pluginProbe, runner, cwd,
                        JSON.stringify({ session, ownerPid, idleMs, engine })], { cwd, stdio: 'ignore', detached: true });
                    child.unref();
                }
                await new Promise(resolve => setTimeout(resolve, 20));
                const ready = await this.status();
                if (ready) return { ...ready, started: true };
            }
            child?.kill();
            throw new Error('Could not start the named typecheck session');
        } finally {
            fs.rmSync(contender, { force: true });
            if (owned) fs.rmSync(lock, { force: true });
        }
    }
    async warm(files, { wait = false } = {}) {
        return this.request('warm', { files, wait, engine: typecheckEngine() });
    }
    async stop() {
        try { return await this.request('stop'); }
        catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
                || error.code === 'BIMBA_SESSION_CLOSED' && !fs.existsSync(this.socket)) {
                return { session: this.args.session, stopped: false };
            }
            throw error;
        }
    }
}
