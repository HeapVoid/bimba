import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { TagDependencies } from './tag-dependencies.js';
import { CompilationStore, hash, counters, projectCache, atomicJSON, compilerEnvironment } from './compilation-store.cjs';
export { hash, counters, projectCache, atomicJSON, compilerEnvironment };
const require = createRequire(import.meta.url);
const engine = hash(fs.readFileSync(import.meta.filename));
const compilerModules = new Map();

// One current result per logical file and compiler variant.
export class CompilerCache {
    constructor({ cwd = process.cwd(), directory = projectCache(cwd), force = false } = {}) {
        this.cwd = path.resolve(cwd);
        this.directory = directory;
        this.force = force;
        let compilerPath;
        try { compilerPath = createRequire(path.join(this.cwd, 'package.json')).resolve('imba/compiler'); }
        catch { compilerPath = require.resolve('imba/compiler'); }
        compilerPath = fs.realpathSync(compilerPath);
        this.identity = hash(fs.readFileSync(compilerPath));
        const previous = compilerModules.get(compilerPath);
        // Do not adopt a compiler loaded before its fingerprint was observed.
        if (previous !== this.identity) delete require.cache[compilerPath];
        this.compiler = require(compilerPath);
        compilerModules.set(compilerPath, this.identity);
        this.store = new CompilationStore(path.join(directory, 'compiled'), force);
        this.stats = this.store.stats;
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
        const cached = this.store.read(slot, key, value => typeof value?.js === 'string');
        if (cached) return { ...cached, errors: [], diagnostics: [] };
        const result = compile(source, normalized);
        if (typeof result.js === 'string' && !result.errors?.length && !result.diagnostics?.length) {
            const output = { js: result.js, css: result.css ?? null, sourceId: result.sourceId ?? null };
            this.store.write(slot, key, output);
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

// Both the public build plugin and the CLI use one linker and compiler contract.
export function createTagDependencies(tags, options, build) {
    if (options.platform !== 'browser' || build.config?.target && build.config.target !== 'browser') throw Error('Automatic tag dependencies require a browser build');
    if (options.hmr || options.sourcemap && options.sourcemap !== 'none' || build.config?.sourcemap && build.config.sourcemap !== 'none') throw Error('Automatic tag dependencies do not yet support HMR or source maps');
    const cache = new CompilerCache();
    const linker = new TagDependencies({ ...tags, cwd: cache.cwd, compiler: cache.compiler,
        compile: file => cache.compile(fs.readFileSync(file, 'utf8'), { ...options, sourcePath: file }),
    });
    linker.prepare();
    build.onEnd(result => { if (result.success) linker.verify(); });
    return linker;
}

export class ImbaPlugin {
    name = 'bimba-imba';
    #options;
    #errors = 0;
    #tags;
    tags = null;
    constructor(options = { platform: 'browser', comments: false }, { tags = null } = {}) {
        this.#options = { ...options };
        this.#tags = tags;
    }
    get errors() { return this.#errors; }
    setup = build => {
        if (this.#tags) {
            this.tags = createTagDependencies(this.#tags, this.#options, build);
        }
        build.onLoad({ filter: /\.imba$/ }, ({ path: file }) => {
            const result = compileImba(fs.readFileSync(file, 'utf8'), { ...this.#options, sourcePath: file });
            if (result.errors?.length) {
                this.#errors++;
                throw Error(file + ': ' + result.errors.map(error => error.message || String(error)).join('\n'));
            }
            return { contents: this.tags ? this.tags.link(file, result.js) : result.js, loader: 'js' };
        });
    };
}
