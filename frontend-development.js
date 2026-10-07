import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FrontendProject } from './frontend-project.js';
import { startDevTypecheckServer } from './typecheck.js';

// Saves coalesce into one background job. Native TypeScript maintains the
// affected type graph; complete diagnostic coverage includes implicit Imba
// tag/global consumers, which cannot safely be inferred from JS imports.
export async function startFrontendDevelopment(entrypoint, { cwd = process.cwd() } = {}) {
    await startDevTypecheckServer(entrypoint, { cwd });
    let child = null, timer = null, queued = false, stopped = false;
    const project = new FrontendProject({ cwd });
    project.affected(entrypoint);
    const cli = fileURLToPath(new URL('./index.js', import.meta.url));
    function run() {
        if (stopped) return;
        if (child) { queued = true; return; }
        const args = [process.execPath, cli, '--frontend-check'];
        const command = process.platform === 'darwin' ? 'taskpolicy' : args.shift();
        const argv = process.platform === 'darwin' ? ['-b', '-c', 'background', ...args] : args;
        child = spawn(command, argv, { cwd, env: process.env, stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' });
        child.on('error', error => console.error('Frontend check could not start: ' + error.message));
        child.on('exit', () => { child = null; if (queued && !stopped) { queued = false; run(); } });
    }
    function changed(file) {
        if (!file) return;
        const relative = String(file).replaceAll('\\', '/');
        if (relative.split('/').some(part => ['.git', '.cache', '.bimba', '.check-build', 'node_modules', 'public', 'dist', 'build', 'coverage'].includes(part))) return;
        if (!/\.(?:imba|[cm]?[jt]sx?|json|toml)$/.test(relative) && !['bun.lock', '.env', '.env.local', '.env.test'].includes(relative)) return;
        if (!project.affected(relative)) return;
        clearTimeout(timer); timer = setTimeout(run, 350);
    }
    const watcher = fs.watch(cwd, { recursive: true }, (_event, file) => changed(file));
    const stop = () => { stopped = true; clearTimeout(timer); watcher.close(); if (child) { if (process.platform === 'win32') child.kill(); else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } } };
    process.once('exit', stop);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(); process.exit(0); });
    run();
    return stop;
}
