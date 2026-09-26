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

function hasPackage(root, name) {
    return fs.existsSync(path.join(root, name, 'package.json'));
}

function findTypeScript(cwd) {
    const tsserver = canResolve('typescript/lib/tsserver.js', cwd);
    if (tsserver) return tsserver;

    throw new Error('Could not find TypeScript. Install it in this project: bun add -d typescript');
}

function findPluginProbe(cwd) {
    const localProbe = path.join(cwd, 'node_modules');
    if (hasPackage(localProbe, 'typescript-imba-plugin')) return localProbe;

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
            if (hasPackage(probe, 'typescript-imba-plugin')) return probe;
        }
    }

    throw new Error('Could not find typescript-imba-plugin. Install the Imba VSCode extension or add the plugin to node_modules.');
}

function collectImbaFiles(entrypoints, cwd) {
    const targets = entrypoints.length ? entrypoints : [fs.existsSync(path.join(cwd, 'src')) ? 'src' : '.'];
    const files = new Set();

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
            }
            else if (entry.isFile() && entry.name.endsWith('.imba')) {
                files.add(path.join(dir, entry.name));
            }
        }
    }

    for (const target of targets) {
        const resolved = path.resolve(cwd, target);
        if (!fs.existsSync(resolved)) throw new Error(`The specified typecheck path does not exist: ${target}`);
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) walk(resolved);
        else if (stat.isFile() && resolved.endsWith('.imba')) files.add(resolved);
        else throw new Error(`The specified typecheck path is not an Imba file or directory: ${target}`);
    }
    return { files: [...files].sort(), targets };
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

        onMessage(JSON.parse(body));
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
    const timeout = Number(options.timeout || process.env.BIMBA_TYPECHECK_TIMEOUT || process.env.IMBA_TS_CHECK_TIMEOUT || 120000);
    const entrypoints = Array.isArray(entrypoint) ? entrypoint : (entrypoint ? [entrypoint] : []);
    const { files, targets } = collectImbaFiles(entrypoints, cwd);

    if (!files.length) {
        console.log(theme.success('Success') + ` No Imba files found in ${theme.filedir(targets.join(', '))}`);
        return true;
    }

    const tsserver = findTypeScript(cwd);
    const pluginProbe = findPluginProbe(cwd);
    const runner = process.env.BIMBA_NODE || process.env.NODE || 'node';

    console.log(theme.folder('──────────────────────────────────────────────────────────────────────'));
    console.log(theme.start(`Start checking TypeScript diagnostics for ${theme.count(files.length)} Imba file${files.length > 1 ? 's' : ''}`));

    // The language-service plugin can return no diagnostics when Imba cannot
    // produce a virtual TypeScript file. Validate syntax with the project compiler
    // first so a broken source file cannot be reported as a successful typecheck.
    const compilerPath = canResolve('imba/compiler', cwd);
    if (!compilerPath) throw new Error('Could not find the Imba compiler. Install it in this project: bun add -d imba');
    const compiler = require(compilerPath);
    let syntaxErrors = 0;
    for (const file of files) {
        let errors;
        try {
            errors = compiler.compile(fs.readFileSync(file, 'utf8'), { sourcePath: file, platform: 'browser', comments: false }).errors || [];
        }
        catch (error) { errors = [error]; }
        for (const error of errors) {
            syntaxErrors++;
            const line = (error.range?.start?.line || 0) + 1;
            const column = (error.range?.start?.character || 0) + 1;
            console.log(`${theme.filedir(path.relative(cwd, file))}:${line}:${column} ${theme.failure(' Imba ')} ${error.message}`);
        }
    }
    if (syntaxErrors) {
        console.log(theme.failure(' Failure ') + ` Imba compiler found ${syntaxErrors} error(s)`);
        return false;
    }

    return await new Promise((resolve) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        const seq = { value: 1 };
        const diagnostics = new Map();
        const pending = new Map();
        const checked = new Set();
        let geterrSeq = null;

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
            for (const request of pending.values()) request.reject(new Error('TypeScript session ended'));
            pending.clear();
            resolve(success);
        }

        function finishWithDiagnostics() {
            const unique = uniqueDiagnostics([...diagnostics.values()].flat());

            if (!unique.length) {
                console.log(theme.success('Success') + ' No Imba TypeScript diagnostics');
                finish(true);
                return;
            }

            printDiagnostics(cwd, unique);
            console.log(theme.failure(' Failure ') + ` TypeScript found ${theme.count(unique.length)} diagnostic${unique.length > 1 ? 's' : ''}`);
            finish(false);
        }

        const timer = setTimeout(() => {
            console.log(theme.failure(' Failure ') + ` Timed out waiting for TypeScript diagnostics after ${theme.time(timeout)} ms`);
            finish(false);
        }, timeout);

        function fail(error) {
            if (settled) return;
            console.log(theme.failure(' Failure ') + ` ${error.message}`);
            finish(false);
        }

        function request(command, args) {
            if (settled) return Promise.reject(new Error('TypeScript session ended'));
            const id = seq.value;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                send(server, seq, command, args);
            });
        }

        server.on('error', fail);
        server.on('exit', (code, signal) => fail(new Error(`TypeScript exited before diagnostics completed (${signal || code})`)));
        server.stdin.on('error', fail);
        server.stderr.on('data', chunk => process.stderr.write(chunk));

        // Config diagnostics name their file differently and can be cleared after
        // the plugin refreshes the project. Keep the latest result per file/kind.
        function receive(msg) {
            if (settled) return;
            if (msg.type == 'response') {
                const waiting = pending.get(msg.request_seq);
                if (!waiting) return;
                pending.delete(msg.request_seq);
                if (msg.success) waiting.resolve(msg.body);
                else waiting.reject(new Error(`${msg.command}: ${msg.message || 'TypeScript request failed'}`));
                return;
            }
            if (msg.type != 'event') return;

            if (msg.event == 'requestCompleted' && msg.body?.request_seq == geterrSeq) {
                const missing = files.filter(file => ['syntaxDiag', 'semanticDiag', 'suggestionDiag']
                    .some(kind => !checked.has(`${kind}\0${file}`)));
                if (missing.length) requestDiagnostics(missing);
                else finishWithDiagnostics();
                return;
            }
            if (!/Diag$/.test(msg.event) || !msg.body?.diagnostics) return;

            const file = msg.body.file || msg.body.configFile;
            if (!file) throw new Error(`TypeScript ${msg.event} did not identify its file`);
            if (geterrSeq !== null) checked.add(`${msg.event}\0${file}`);
            recordDiagnostics(msg.event, file, msg.body.diagnostics);
        }

        function recordDiagnostics(kind, file, result) {
            if (!Array.isArray(result)) throw new Error(`TypeScript did not return ${kind} diagnostics for ${file}`);
            const items = result.map(diagnostic => ({
                ...diagnostic,
                file,
                kind,
                key: [kind, file, diagnostic.start?.line, diagnostic.start?.offset,
                    diagnostic.code, flattenMessage(diagnostic.text)].join('\0'),
            }));
            diagnostics.set(`${kind}\0${file}`, items);
        }

        server.stdout.on('data', chunk => {
            try {
                buffer = parseMessages(Buffer.concat([buffer, chunk]), receive);
            }
            catch (error) { fail(error); }
        });

        function requestDiagnostics(batch) {
            // A project refresh can cancel geterr partway through but still emit
            // requestCompleted. Retry files missing any diagnostic response;
            // the session timeout bounds retries. Keep the event protocol because
            // the Imba plugin maps its positions back to the original source.
            geterrSeq = seq.value;
            send(server, seq, 'geterr', { files: batch, delay: 0 });
        }

        // Register Imba before opening files. Otherwise tsserver can finish an
        // empty initial project before the plugin adds the extension, reporting
        // a false success or a transient "No inputs" configuration error.
        async function check() {
            await request('configure', {
                preferences: {}, hostInfo: 'bimba-typecheck',
                extraFileExtensions: [{ extension: '.imba', isMixedContent: false, scriptKind: 7 }],
            });
            for (const file of files) await request('open', { file, projectRootPath: cwd });
            for (const file of files) {
                const project = await request('projectInfo', { file, needFileNameList: false });
                if (project.languageServiceDisabled) throw new Error(`TypeScript language service is disabled for ${file}`);
                if (!project.configFileName || !fs.existsSync(project.configFileName)) {
                    throw new Error(`${file} is not included in a project configuration. Add it to the include/files of tsconfig.json or jsconfig.json.`);
                }
            }
            requestDiagnostics(files);
        }
        check().catch(fail);
    });
}
