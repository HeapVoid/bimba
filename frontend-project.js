import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CompilerCache, atomicJSON, compilerEnvironment, hash, projectCache } from './compile-cache.js';
import { TypeView } from './type-view.js';
import { checkImbaTypes } from './typecheck.js';

const skip = new Set(['.git', '.cache', '.bimba', '.check-build', '.local-run', '.worktrees', 'node_modules', 'public', 'dist', 'build', 'coverage', '__pycache__']);
const engine = hash(['frontend-project.js', 'compile-cache.js', 'type-view.js', 'typecheck.js', 'typecheck-daemon.js', 'typecheck-transport.js'].map(file => fs.readFileSync(new URL(file, import.meta.url))).join('\0'));

function walk(root, visit, excluded = skip, ancestors = new Set()) {
    const real = fs.realpathSync(root);
    if (ancestors.has(real)) return;
    const parents = new Set([...ancestors, real]);
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (excluded.has(entry.name)) continue;
        const file = path.join(root, entry.name);
        let stat;
        try { stat = fs.statSync(file, { bigint: true }); }
        catch (error) {
            if (error.code !== 'ENOENT' || !entry.isSymbolicLink()) throw error;
            visit(file, null); continue;
        }
        if (stat.isDirectory()) walk(file, visit, excluded, parents);
        else if (stat.isFile()) visit(file, stat);
    }
}

// Last installed dependency inventory only. ctime prevents an edit with a
// restored mtime from reusing stale bytes; enumeration detects membership.
export class DependencyInventory {
    constructor(directory) {
        this.file = path.join(directory, 'dependencies.json');
        try { this.previous = JSON.parse(fs.readFileSync(this.file, 'utf8')).files; } catch {}
        this.previous ||= {};
    }
    snapshot(cwd) {
        const files = {}, values = {};
        let changed = false;
        const root = path.join(cwd, 'node_modules');
        if (fs.existsSync(root)) walk(root, (file, stat) => {
            if (!stat) { values[path.relative(cwd, file)] = 'broken-link:' + fs.readlinkSync(file); return; }
            const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
            const old = this.previous[file];
            const same = old?.signature === signature && typeof old.digest === 'string' && /^[a-f0-9]{64}$/.test(old.digest);
            if (!same) changed = true;
            const digest = same ? old.digest : hash(fs.readFileSync(file));
            files[file] = { signature, digest };
            values[path.relative(cwd, file).replaceAll('\\', '/')] = digest;
        }, new Set(['.git', '__pycache__', '.cache']));
        changed ||= Object.keys(this.previous).length !== Object.keys(files).length;
        this.previous = files;
        if (changed) atomicJSON(this.file, { files });
        return hash(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
    }
}

export class FrontendProject {
    constructor({ cwd = process.cwd(), directory = projectCache(cwd), force = false } = {}) {
        this.cwd = path.resolve(cwd); this.directory = directory; this.force = force;
        this.compiler = null;
        this.dependencies = null;
        this.proofFile = path.join(directory, 'frontend-types.json');
    }
    inputFiles(externalFiles = [], selected = []) {
        const inputs = new Set(selected.map(file => path.resolve(this.cwd, file)));
        const require = createRequire(path.join(this.cwd, 'package.json'));
        let ts;
        try { ts = require('typescript'); } catch { ts = createRequire(import.meta.url)('typescript'); }
        const configurations = fs.readdirSync(this.cwd).filter(name => /^(?:tsconfig.*|jsconfig)\.json$/.test(name));
        const host = { ...ts.sys, readFile: file => {
            inputs.add(file);
            return ts.sys.readFile(file);
        }};
        for (const name of configurations) {
            const file = path.join(this.cwd, name); inputs.add(file);
            const config = ts.readConfigFile(file, host.readFile);
            if (config.config) {
                const project = ts.parseJsonConfigFileContent(config.config, host, this.cwd, {}, file, undefined,
                    [{ extension: '.imba', scriptKind: 7, isMixedContent: false }]);
                for (const input of project.fileNames) inputs.add(input);
            }
        }
        if (!configurations.length && fs.existsSync(path.join(this.cwd, 'src'))) {
            walk(path.join(this.cwd, 'src'), file => inputs.add(file));
        }
        for (const file of externalFiles) inputs.add(path.resolve(this.cwd, file));
        for (const name of ['package.json', 'bun.lock', 'bun.lockb', 'bunfig.toml', '.env', '.env.local', '.env.test']) inputs.add(path.join(this.cwd, name));
        return inputs;
    }
    affected(file) {
        const absolute = path.resolve(this.cwd, file);
        let graph = [];
        try {
            const stat = fs.statSync(this.proofFile);
            const stamp = stat.mtimeMs + ':' + stat.size;
            if (stamp !== this.graphStamp) {
                this.graphStamp = stamp;
                this.graph = Object.keys(JSON.parse(fs.readFileSync(this.proofFile, 'utf8')).proof.external || {});
            }
            graph = this.graph || [];
        } catch {}
        const current = this.inputFiles(graph);
        const affected = current.has(absolute) || this.previousInputs?.has(absolute);
        this.previousInputs = current;
        return !!affected;
    }
    snapshot(externalFiles = [], selected = []) {
        const sources = {}, other = {}, inputs = {}, files = this.inputFiles(externalFiles, selected);
        this.dependencies ||= new DependencyInventory(this.directory);
        for (const file of [...files].sort()) {
            const name = path.relative(this.cwd, file).replaceAll('\\', '/');
            if (!fs.existsSync(file)) { inputs[name] = other[name] = 'missing'; continue; }
            const bytes = fs.readFileSync(file);
            inputs[name] = hash(bytes);
            if (name.endsWith('.imba') && !name.startsWith('../')) sources[name] = bytes.toString('utf8');
            else other[name] = inputs[name];
        }
        const external = this.externalInputs(externalFiles);
        const environment = compilerEnvironment(Object.values(sources));
        // Execution priority, daemon ownership and checkout path are not types.
        const runtime = Object.fromEntries(['NODE_OPTIONS', 'NODE_PATH', 'NODE', 'BIMBA_NODE', 'NODE_ENV', 'TZ'].map(name => [name, process.env[name] ?? null]));
        const dependencies = this.dependencies.snapshot(this.cwd);
        const context = hash(JSON.stringify({ engine, other, environment, runtime, dependencies }));
        return { context, sources, external, inputs, dependencies };
    }
    externalInputs(files, raw = false) {
        const values = {};
        for (const file of [...new Set(files)].sort()) {
            const absolute = path.resolve(this.cwd, file);
            const relative = path.relative(this.cwd, absolute);
            if (relative === 'node_modules' || relative.startsWith('node_modules/')) continue;
            const key = relative.startsWith('../') || relative === '..' || path.isAbsolute(relative) ? absolute : relative.replaceAll('\\', '/');
            values[key] = fs.existsSync(absolute)
                ? (!raw && !relative.startsWith('../') && key.endsWith('.imba') ? 'imba-source' : hash(fs.readFileSync(absolute))) : 'missing';
        }
        return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
    }
    equivalent(previous, current) {
        if (!previous || previous.context !== current.context || JSON.stringify(previous.external || {}) !== JSON.stringify(current.external)) return false;
        if (Object.keys(previous.sources).sort().join('\0') !== Object.keys(current.sources).sort().join('\0')) return false;
        const changed = Object.keys(current.sources).filter(file => previous.sources[file] !== current.sources[file]);
        // Custom project plugins/config extensions can observe original text.
        for (const name of fs.readdirSync(this.cwd).filter(name => /^(?:tsconfig.*|jsconfig)\.json$/.test(name))) {
            try {
                const config = JSON.parse(fs.readFileSync(path.join(this.cwd, name), 'utf8'));
                if (config.extends || config.compilerOptions?.plugins?.length) return false;
            } catch { return false; }
        }
        if (!changed.length) return true;
        const views = new TypeView(this.cwd, this.directory);
        return changed.every(file => {
            const before = views.fingerprint(previous.sources[file], file);
            return before !== null && before === views.fingerprint(current.sources[file], file);
        });
    }
    async check({ files = null, diagnostics = checkImbaTypes } = {}) {
        this.compiler ||= new CompilerCache({ cwd: this.cwd, directory: this.directory, force: this.force });
        let previous;
        try {
            const record = JSON.parse(fs.readFileSync(this.proofFile, 'utf8'));
            if (record.format === 1 && record.digest === hash(JSON.stringify(record.proof))) previous = record.proof;
        } catch {}
        const externalFiles = Object.keys(previous?.external || {});
        const before = this.snapshot(externalFiles, files || []);
        const selected = (files || Object.keys(before.sources).filter(file => !fs.existsSync(path.join(this.cwd, 'src')) || file.startsWith('src/'))).sort();
        let valid = true;
        for (const file of selected) {
            const source = before.sources[file];
            if (typeof source !== 'string') throw Error('Unknown Imba input: ' + file);
            try {
                const result = this.compiler.compile(source, { sourcePath: path.join(this.cwd, file), platform: 'browser', comments: false });
                for (const error of result.errors || []) { valid = false; console.error(`${file}: ${error.toSnippet?.() || error.message || error}`); }
            } catch (error) { valid = false; console.error(`${file}: ${error.message}`); }
        }
        const reusable = !this.force && process.env.BIMBA_FORCE !== '1' && this.equivalent(previous, before);
        if (!valid || !reusable) fs.rmSync(this.proofFile, { force: true });
        const coverage = new Set(reusable ? previous.coverage : []);
        const missing = selected.filter(file => !coverage.has(file));
        const observedExternal = {}, observedInputs = {};
        const passed = valid && (!missing.length || await diagnostics(missing, { cwd: this.cwd, syntaxValidated: true, refreshProject: !reusable,
            projectFiles: paths => {
                Object.assign(observedExternal, this.externalInputs(paths));
                Object.assign(observedInputs, this.externalInputs(paths, true));
            },
        }));
        const after = this.snapshot(externalFiles, files || []);
        const external = Object.fromEntries(Object.entries({ ...after.external, ...observedExternal }).sort(([a], [b]) => a.localeCompare(b)));
        const complete = Object.keys(observedExternal).some(file => !(file in after.external))
            ? this.snapshot(Object.keys(external), files || []) : after;
        // Discovering imports may extend the snapshot, but cannot replace any
        // bytes checked earlier. Raw graph hashes also bind newly found Imba.
        const stable = JSON.stringify(before) === JSON.stringify(after)
            && after.dependencies === complete.dependencies
            && Object.entries(after.inputs).every(([file, digest]) => complete.inputs[file] === digest)
            && JSON.stringify(Object.entries(observedInputs).sort(([a], [b]) => a.localeCompare(b)))
                === JSON.stringify(Object.entries(this.externalInputs(Object.keys(observedInputs), true)));
        if (passed && stable) {
            for (const file of missing) coverage.add(file);
            const proof = { ...complete, external, coverage: [...coverage].sort() };
            atomicJSON(this.proofFile, { format: 1, proof, digest: hash(JSON.stringify(proof)) });
        } else fs.rmSync(this.proofFile, { force: true });
        return { passed: passed && stable, mode: missing.length ? 'diagnostics' : 'snapshot-reused', checked: missing.length, covered: selected.length, compiler: { ...this.compiler.stats }, stable };
    }
}
