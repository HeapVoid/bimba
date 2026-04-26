import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { theme } from './utils.js';

const require = createRequire(import.meta.url);

const SKIP_DIRS = new Set([
    '.bimba',
    '.cache',
    '.git',
    'build',
    'dist',
    'node_modules',
    'public',
]);

function canResolve(request, from) {
    try {
        return require.resolve(request, { paths: [from] });
    }
    catch {
        return null;
    }
}

function findTypeScript(cwd) {
    const tsserver = canResolve('typescript/lib/tsserver.js', cwd);
    if (tsserver) return tsserver;

    throw new Error('Could not find TypeScript. Install it in this project: bun add -d typescript');
}

function findPluginProbe(cwd) {
    const localProbe = path.join(cwd, 'node_modules');
    if (canResolve('typescript-imba-plugin', localProbe)) return localProbe;

    const extensionRoots = [
        path.join(os.homedir(), '.vscode', 'extensions'),
        path.join(os.homedir(), '.cursor', 'extensions'),
        path.join(os.homedir(), '.windsurf', 'extensions'),
        path.join(os.homedir(), '.kiro', 'extensions'),
    ];

    for (const root of extensionRoots) {
        if (!fs.existsSync(root)) continue;

        for (const entry of fs.readdirSync(root)) {
            const probe = path.join(root, entry, 'node_modules');
            if (canResolve('typescript-imba-plugin', probe)) return probe;
        }
    }

    throw new Error('Could not find typescript-imba-plugin. Install the Imba VSCode extension or add the plugin to node_modules.');
}

function getScanRoot(entrypoint, cwd) {
    if (!entrypoint) {
        const src = path.join(cwd, 'src');
        return fs.existsSync(src) ? src : cwd;
    }

    const resolved = path.resolve(cwd, entrypoint);
    if (!fs.existsSync(resolved)) {
        throw new Error(`The specified typecheck path does not exist: ${entrypoint}`);
    }

    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? resolved : path.dirname(resolved);
}

function collectImbaFiles(root) {
    const files = [];

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
            }
            else if (entry.isFile() && entry.name.endsWith('.imba')) {
                files.push(path.join(dir, entry.name));
            }
        }
    }

    walk(root);
    files.sort();
    return files;
}

function parseMessages(buffer, onMessage) {
    while (true) {
        const text = buffer.toString('utf8');
        const headerEnd = text.indexOf('\r\n\r\n');
        if (headerEnd < 0) return buffer;

        const match = /Content-Length: (\d+)/i.exec(text.slice(0, headerEnd));
        if (!match) return buffer;

        const length = Number(match[1]);
        const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4));
        if (buffer.length < bodyStart + length) return buffer;

        const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
        buffer = buffer.slice(bodyStart + length);

        try {
            onMessage(JSON.parse(body));
        }
        catch {}
    }
}

function flattenMessage(text) {
    if (typeof text == 'string') return text;
    if (!text) return '';
    if (text.messageText) {
        const next = Array.isArray(text.next) ? text.next.map(flattenMessage) : [];
        return [flattenMessage(text.messageText), ...next].filter(Boolean).join(' ');
    }
    return String(text);
}

function uniqueDiagnostics(diagnostics) {
    const unique = Array.from(new Map(diagnostics.map(item => [item.key, item])).values());
    unique.sort((a, b) => {
        return a.file.localeCompare(b.file)
            || (a.start?.line || 0) - (b.start?.line || 0)
            || (a.start?.offset || 0) - (b.start?.offset || 0)
            || String(a.code).localeCompare(String(b.code));
    });
    return unique;
}

function printDiagnostics(cwd, diagnostics) {
    for (const item of diagnostics) {
        const rel = path.relative(cwd, item.file);
        const line = item.start?.line || 0;
        const offset = item.start?.offset || 0;
        const code = item.code ? `TS${item.code}` : 'TS';
        const category = item.category || 'error';
        const text = flattenMessage(item.text);

        console.log(`${theme.filedir(rel)}:${line}:${offset} ${theme.action(item.kind)} ${theme.failure(` ${code} `)} ${category}: ${text}`);
    }
}

function send(server, seq, command, args) {
    server.stdin.write(JSON.stringify({ seq: seq.value++, type: 'request', command, arguments: args }) + '\n');
}

export async function checkImbaTypes(entrypoint, options = {}) {
    const cwd = options.cwd || process.cwd();
    const timeout = Number(options.timeout || process.env.BIMBA_TYPECHECK_TIMEOUT || process.env.IMBA_TS_CHECK_TIMEOUT || 12000);
    const scanRoot = getScanRoot(entrypoint, cwd);
    const files = collectImbaFiles(scanRoot);

    if (!files.length) {
        console.log(theme.success('Success') + ` No Imba files found in ${theme.filedir(path.relative(cwd, scanRoot) || '.')}`);
        return true;
    }

    const tsserver = findTypeScript(cwd);
    const pluginProbe = findPluginProbe(cwd);
    const runner = process.env.BIMBA_NODE || process.env.NODE || 'node';

    console.log(theme.folder('──────────────────────────────────────────────────────────────────────'));
    console.log(theme.start(`Start checking TypeScript diagnostics for ${theme.count(files.length)} Imba file${files.length > 1 ? 's' : ''}`));

    return await new Promise((resolve) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        const seq = { value: 1 };
        const diagnostics = [];

        const server = spawn(runner, [
            tsserver,
            '--globalPlugins',
            'typescript-imba-plugin',
            '--pluginProbeLocations',
            pluginProbe,
        ], { cwd });

        function finish(success) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            server.kill();
            resolve(success);
        }

        const timer = setTimeout(() => {
            const unique = uniqueDiagnostics(diagnostics);

            if (!unique.length) {
                console.log(theme.success('Success') + ' No Imba TypeScript diagnostics');
                finish(true);
                return;
            }

            printDiagnostics(cwd, unique);
            console.log(theme.failure(' Failure ') + ` TypeScript found ${theme.count(unique.length)} diagnostic${unique.length > 1 ? 's' : ''}`);
            finish(false);
        }, timeout);

        server.on('error', (error) => {
            console.log(theme.failure(' Failure ') + ` Could not start ${runner}: ${error.message}`);
            finish(false);
        });

        server.stderr.on('data', chunk => process.stderr.write(chunk));

        server.stdout.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            buffer = parseMessages(buffer, msg => {
                if (msg.type != 'event' || !/Diag$/.test(msg.event)) return;
                if (!msg.body?.diagnostics?.length) return;

                for (const diagnostic of msg.body.diagnostics) {
                    const key = [
                        msg.event,
                        msg.body.file,
                        diagnostic.start?.line,
                        diagnostic.start?.offset,
                        diagnostic.code,
                        flattenMessage(diagnostic.text),
                    ].join('\0');

                    diagnostics.push({
                        key,
                        kind: msg.event,
                        file: msg.body.file,
                        ...diagnostic,
                    });
                }
            });
        });

        setTimeout(() => {
            if (settled) return;
            send(server, seq, 'configure', { preferences: {}, hostInfo: 'bimba-typecheck' });
            for (const file of files) send(server, seq, 'open', { file, projectRootPath: cwd });
            send(server, seq, 'geterr', { files, delay: 0 });
        }, 100);
    });
}
