import { startTypecheckWorker } from './typecheck-worker.js';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { connectTypecheckServer, launchDevTypecheckServer, typecheckRuntime, typecheckRevisions, TypecheckSession } from './typecheck-transport.js';
import { theme } from './utils.js';
import { parseMessages } from './typecheck-protocol.js';
import { CompilerCache } from './compile-cache.js';

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

export function collectImbaFiles(entrypoints, cwd, { canonical = false } = {}) {
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
    const selected = canonical ? new Set([...files].map(file => fs.realpathSync(file))) : files;
    return { files: [...selected].sort(), targets };
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

export async function startDevTypecheckServer(entrypoint, options = {}) {
    if (process.env.CI || process.env.BIMBA_NO_TYPECHECK_DAEMON === '1') return;
    const cwd = fs.realpathSync(options.cwd || process.cwd());
    const tsserver = findTypeScript(cwd);
    const pluginProbe = findPluginProbe(cwd);
    const runner = typecheckRuntime();
    const session = options.session ?? process.env.BIMBA_TYPECHECK_SESSION;
    if (session) {
        await typecheckSession('warm', entrypoint, { ...options, cwd, session, wait: true });
    } else {
        await launchDevTypecheckServer({ cwd, tsserver, pluginProbe, runner });
        await checkImbaTypes(entrypoint, { cwd });
    }
    console.log(theme.success('TypeScript server ready for checks'));
}

// The CLI and project hosts use the same explicit lifecycle contract. A name
// selects an already started session; ordinary checks never start one implicitly.
export async function typecheckSession(action, entrypoint = [], options = {}) {
    const cwd = fs.realpathSync(options.cwd || process.cwd());
    const session = options.session ?? process.env.BIMBA_TYPECHECK_SESSION;
    const args = { cwd, session, runner: typecheckRuntime() };
    if (!['start', 'warm', 'status', 'stop'].includes(action)) throw new Error('Session action must be start, warm, status or stop');
    if (action === 'start') Object.assign(args, { tsserver: findTypeScript(cwd), pluginProbe: findPluginProbe(cwd) });
    const server = new TypecheckSession(args);
    const paths = Array.isArray(entrypoint) ? entrypoint : (entrypoint ? [entrypoint] : []);
    const wantsWarmup = action === 'warm' || action === 'start' && paths.length > 0;
    const files = wantsWarmup ? collectImbaFiles(paths, cwd, { canonical: true }).files : [];
    if (wantsWarmup && !files.length) throw new Error('No Imba files selected for session warmup');
    if (action === 'stop') return server.stop();
    let started;
    if (action === 'start') {
        started = await server.start(options);
        if (!paths.length) return started;
    } else if (!await server.status()) {
        throw new Error(`Typecheck session "${session}" is not running. Start it explicitly first.`);
    }
    if (action === 'status') return server.status();
    const result = await server.warm(files, { wait: !!options.wait });
    return started ? { ...result, started: started.started } : result;
}

export async function checkImbaTypes(entrypoint, options = {}) {
    const started = performance.now();
    const profile = process.env.BIMBA_PROFILE_TYPECHECK;
    const mark = phase => {
        if (profile) console.error(`[bimba typecheck] ${phase}: ${(performance.now() - started).toFixed(1)} ms`);
    };
    const cwd = fs.realpathSync(options.cwd || process.cwd());
    const session = options.session ?? process.env.BIMBA_TYPECHECK_SESSION;
    const timeout = Number(options.timeout || process.env.BIMBA_TYPECHECK_TIMEOUT || process.env.IMBA_TS_CHECK_TIMEOUT || 120000);
    const entrypoints = Array.isArray(entrypoint) ? entrypoint : (entrypoint ? [entrypoint] : []);
    const { files, targets } = collectImbaFiles(entrypoints, cwd, { canonical: !!session });
    const selectedByRealPath = new Map(files.map(file => [fs.realpathSync(file), file]));
    mark('collect files');

    if (!files.length) {
        console.log(theme.success('Success') + ` No Imba files found in ${theme.filedir(targets.join(', '))}`);
        return true;
    }

    const tsserver = findTypeScript(cwd);
    const pluginProbe = findPluginProbe(cwd);
    const runner = typecheckRuntime();
    const serverArgs = { cwd, tsserver, pluginProbe, runner, session };
    mark('resolve toolchain');

    console.log(theme.folder('──────────────────────────────────────────────────────────────────────'));
    console.log(theme.start(`Start checking TypeScript diagnostics for ${theme.count(files.length)} Imba file${files.length > 1 ? 's' : ''}`));

    // The language-service plugin can return no diagnostics when Imba cannot
    // produce a virtual TypeScript file. Validate syntax with the project compiler
    // first so a broken source file cannot be reported as a successful typecheck.
    const compilerPath = canResolve('imba/compiler', cwd);
    if (!compilerPath) throw new Error('Could not find the Imba compiler. Install it in this project: bun add -d imba');
    const compiler = new CompilerCache({ cwd });
    mark('load Imba compiler');
    let syntaxErrors = 0;
    for (const file of options.syntaxValidated ? [] : files) {
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
    mark('compile selected files');

    let shared = null;
    if (session && !process.env.CI && process.env.BIMBA_NO_TYPECHECK_DAEMON !== '1') {
        shared = await connectTypecheckServer(serverArgs);
        if (!shared) throw new Error(`Typecheck session "${session}" is not running. Start it explicitly first.`);
    } else {
        try { shared = await connectTypecheckServer(serverArgs); }
        catch (error) { console.error(`Bimba typecheck server unavailable; using a one-shot session: ${error.message}`); }
    }
    const server = shared || startTypecheckWorker({ cwd, tsserver, pluginProbe, runner });
    mark(shared ? 'connect warm tsserver' : 'spawn tsserver');

    let recoverable = false;
    const success = await new Promise((resolve) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        const seq = { value: 1 };
        const diagnostics = new Map();
        const pending = new Map();
        const checked = new Set();
        const pluginProjects = new Set();
        const rememberPlugin = project => {
            if (fs.existsSync(project)) pluginProjects.add(fs.realpathSync(project));
        };
        let geterrSeq = null;
        let retryTimer;

        function finish(success) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(retryTimer);
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
            recoverable = !!shared && /^(updateOpen:|TypeScript exited before diagnostics)/.test(error.message);
            if (recoverable && !options.recovering) console.error(`Bimba shared TypeScript session failed; reconnecting: ${error.message}`);
            else console.log(theme.failure(' Failure ') + ` ${error.message}`);
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
            if (msg.event === 'bimbaPluginReady') {
                rememberPlugin(msg.body.project);
                return;
            }
            if (msg.event === 'bimbaCacheProfile') {
                if (profile) console.error('[bimba virtual cache] ' + JSON.stringify(msg.body));
                return;
            }

            if (msg.event == 'requestCompleted' && msg.body?.request_seq == geterrSeq) {
                mark('diagnostics complete');
                const missing = files.filter(file => ['syntaxDiag', 'semanticDiag', 'suggestionDiag']
                    .some(kind => !checked.has(`${kind}\0${file}`)));
                if (missing.length) retryTimer = setTimeout(() => requestDiagnostics(missing), 25);
                else finishWithDiagnostics();
                return;
            }
            if (!/Diag$/.test(msg.event) || !msg.body?.diagnostics) return;
            mark(msg.event);

            const reported = msg.body.file || msg.body.configFile;
            if (!reported) throw new Error(`TypeScript ${msg.event} did not identify its file`);
            const realPath = fs.existsSync(reported) ? fs.realpathSync(reported) : reported;
            if (!msg.body.configFile && !selectedByRealPath.has(realPath)) return;
            const file = selectedByRealPath.get(realPath) || reported;
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
            if (!shared) await request('configure', {
                preferences: {}, hostInfo: 'bimba-typecheck',
                extraFileExtensions: [{ extension: '.imba', isMixedContent: false, scriptKind: 7 }],
            });
            mark('configure tsserver');
            if (shared) {
                const revisions = session ? typecheckRevisions(serverArgs) : null;
                const sync = await request('bimbaSync', {
                    files: files.map(file => ({ file, content: fs.readFileSync(file, 'utf8') })),
                    refresh: !!options.refreshProject,
                    ...(revisions ? { engine: revisions.engine, toolchain: {
                        tsserver, pluginProbe, runner, revision: revisions.worker,
                    } } : {}),
                });
                for (const project of sync.pluginProjects || []) rememberPlugin(project);
                // Plugin 1.8.x debounces virtual-source edits by up to 250ms
                // (including clearing a large document). Unchanged/JS checks do not wait.
                if (sync.imbaChanged && !sync.reset) await new Promise(resolve => setTimeout(resolve, 300));
                mark(`synchronize tsserver ${sync.workerPid}${sync.reset ? ' reset: ' + sync.reasons.join(', ') : ''}`);
            }
            // One project update lets tsserver build the selected graph once.
            // Use its public batch protocol in both warm and one-shot sessions.
            await request('updateOpen', { openFiles: files.map(file => ({ file, projectRootPath: cwd })) });
            mark('open selected files');
            const inspectedProjects = new Set();
            // Validate every file's actual default project. Pipelining removes
            // per-file IPC waits without guessing membership from config globs.
            await Promise.all(files.map(async file => {
                const project = await request('projectInfo', { file, needFileNameList: false });
                if (project.languageServiceDisabled) throw new Error(`TypeScript language service is disabled for ${file}`);
                if (!project.configFileName || !fs.existsSync(project.configFileName)) {
                    throw new Error(`${file} is not included in a project configuration. Add it to the include/files of tsconfig.json or jsconfig.json.`);
                }
                if (!pluginProjects.has(fs.realpathSync(project.configFileName))) {
                    // A plugin that failed to load is not a healthy graph. Retire
                    // it so repairing its dependency can recover on the next check.
                    if (shared) await request('bimbaInvalidate', {});
                    throw new Error(`Imba language-service plugin did not initialize for ${project.configFileName}. Check the plugin and its dependencies.`);
                }
                if ((options.projectFiles || shared) && !inspectedProjects.has(project.configFileName)) {
                    inspectedProjects.add(project.configFileName);
                    const complete = await request('projectInfo', { file, needFileNameList: true });
                    options.projectFiles?.([...(complete.fileNames || []), project.configFileName]);
                }
            }));
            mark('project info');
            requestDiagnostics(files);
        }
        check().catch(fail);
    });
    const remaining = timeout - (performance.now() - started);
    if (!success && recoverable && !options.recovering && remaining > 0) {
        // Disconnect has discarded an interrupted/rejected worker in the daemon.
        // Retry the same selection once, within the original timeout budget.
        return checkImbaTypes(entrypoint, { ...options, recovering: true, timeout: remaining });
    }
    return success;
}
