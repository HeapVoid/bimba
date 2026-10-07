import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const counters = { hits: 0, compiled: 0 };
const require = createRequire(import.meta.url);
const engine = hash(fs.readFileSync(import.meta.filename));

export function projectCache(cwd = process.cwd()) {
    let namespace;
    try { namespace = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).name; } catch {}
    namespace ||= fs.realpathSync(cwd);
    return process.env.BIMBA_CACHE_DIR || path.join(os.homedir(), '.cache', 'bimba', 'projects', hash(namespace).slice(0, 24));
}

export function atomicJSON(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, JSON.stringify(value));
        fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
}

export function compilerEnvironment(sources) {
    const names = new Set(sources.flatMap(source => [...source.matchAll(/\$(\w+)\$/g)].map(match => match[1].toUpperCase())));
    return Object.fromEntries([...names].sort().map(name => [name, process.env[name] ?? null]));
}

// One current result per logical file and compiler variant. The source and
// toolchain belong to the result key, not its slot: edits replace old history.
export class CompilerCache {
    constructor({ cwd = process.cwd(), directory = projectCache(cwd), force = false } = {}) {
        this.cwd = path.resolve(cwd);
        this.directory = directory;
        this.force = force;
        let compilerPath;
        try { compilerPath = createRequire(path.join(this.cwd, 'package.json')).resolve('imba/compiler'); }
        catch { compilerPath = require.resolve('imba/compiler'); }
        this.compiler = require(compilerPath);
        this.identity = hash(fs.readFileSync(compilerPath));
        this.stats = { hits: 0, compiled: 0 };
    }
    compile(source, options, { kind = 'imba', identity = this.identity, compile = this.compiler.compile } = {}) {
        const normalized = Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)));
        // Relative compiler paths also make CSS identifiers and source maps
        // reproducible in another checkout. Paths outside this project retain
        // their full identity. Relative imports are resolved by the bundler.
        for (const name of ['sourcePath', 'fileName']) if (normalized[name]) {
            const relative = path.relative(this.cwd, path.resolve(this.cwd, normalized[name]));
            if (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) normalized[name] = relative.replaceAll('\\', '/');
        }
        const slot = hash(JSON.stringify({ kind, options: normalized }));
        const key = hash(JSON.stringify({ engine, identity, options: normalized, environment: compilerEnvironment([source]), source }));
        const file = path.join(this.directory, 'compiled', slot + '.json');
        if (!this.force && process.env.BIMBA_FORCE !== '1') {
            try {
                const value = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (value?.format === 1 && value.key === key && typeof value.output?.js === 'string' && value.digest === hash(JSON.stringify(value.output))) {
                    this.stats.hits++; counters.hits++;
                    return { ...value.output, errors: [], diagnostics: [] };
                }
            } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
        }
        this.stats.compiled++; counters.compiled++;
        const result = compile(source, normalized);
        if (typeof result.js === 'string' && !result.errors?.length && !result.diagnostics?.length) {
            const output = { js: result.js, css: result.css ?? null, sourceId: result.sourceId ?? null };
            atomicJSON(file, { format: 1, key, output, digest: hash(JSON.stringify(output)) });
        }
        return result;
    }
}
let current;
export function compileImba(source, options) {
    const cwd = process.cwd(), directory = projectCache(cwd);
    if (!current || current.cwd !== cwd || current.directory !== directory) current = new CompilerCache({ cwd, directory });
    return current.compile(source, options);
}

export class ImbaPlugin {
    name = 'bimba-imba';
    #options;
    #errors = 0;
    constructor(options = { platform: 'browser', comments: false }) { this.#options = { ...options }; }
    get errors() { return this.#errors; }
    setup = build => {
        build.onLoad({ filter: /\.imba$/ }, ({ path: file }) => {
            const result = compileImba(fs.readFileSync(file, 'utf8'), { ...this.#options, sourcePath: file });
            if (result.errors?.length) {
                this.#errors++;
                throw Error(file + ': ' + result.errors.map(error => error.message || String(error)).join('\n'));
            }
            return { contents: result.js, loader: 'js' };
        });
    };
}
