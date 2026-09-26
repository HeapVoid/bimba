import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonPath = fileURLToPath(new URL('./typecheck-daemon.js', import.meta.url));
const packagePath = fileURLToPath(new URL('./package.json', import.meta.url));

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

function socketFor({ cwd, tsserver, pluginProbe, runner }) {
    const directory = path.join(os.homedir(), '.cache', 'bimba');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    const revision = fs.statSync(daemonPath).mtimeMs;
    const identity = [fs.realpathSync(cwd), tsserver, pluginProbe, runner, version, revision].join('\0');
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
    const socketPath = socketFor(args);
    const existing = await connectTypecheckServer(args);
    if (existing) {
        existing.kill();
        return null;
    }
    try { fs.unlinkSync(socketPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const child = spawn('node', [
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
