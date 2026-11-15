const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { CompilationStore, hash, projectCache, compilerEnvironment } = require('../compilation-store.cjs');
const engine = hash([__filename, path.join(__dirname, 'index.cjs'), path.join(__dirname, '../plugin-compiler.cjs')]
    .map(file => fs.readFileSync(file)).join('\0'));

function validMapping(output) {
    return typeof output?.js === 'string' && (!output.errors || Array.isArray(output.errors) && output.errors.length === 0)
        && Array.isArray(output.diagnostics) && output.diagnostics.length === 0
        && Array.isArray(output.locs?.spans)
        && output.locs.spans.every(span => Array.isArray(span) && (span.length === 0 || span.length === 4 && span.every(Number.isFinite)));
}

class VirtualTypeScriptCache {
    constructor(cwd, plugin) {
        this.cwd = cwd;
        this.plugin = hash(fs.readFileSync(plugin));
        this.compilers = new Map();
        this.store = new CompilationStore(path.join(projectCache(cwd), 'virtual-typescript'));
        this.stats = { enabled: false, stored: 0, compiled: 0, compileMs: 0, cacheMs: 0 };
    }
    identity(file, compile) {
        let compiler;
        try { compiler = createRequire(file).resolve('imba/compiler'); } catch {}
        if (!this.compilers.has(compiler)) this.compilers.set(compiler, compiler ? hash(fs.readFileSync(compiler)) : null);
        return hash(JSON.stringify({ engine, plugin: this.plugin, projectCompiler: this.compilers.get(compiler), compile: String(compile),
            runtime: { bun: process.versions.bun, node: process.versions.node, platform: process.platform, arch: process.arch } }));
    }
    compile(compiler, source, options) {
        const original = compiler.compile;
        const started = performance.now();
        let slot, key;
        if (process.env.BIMBA_VIRTUAL_CACHE !== '0') {
            try {
                // Keep the exact options, including sourceId and absolute paths:
                // both generated symbols and source mapping depend on them.
                slot = hash(JSON.stringify({ file: options.fileName, kind: 'virtual-typescript' }));
                key = hash(JSON.stringify({ identity: this.identity(options.fileName, original), source, options,
                    environment: compilerEnvironment([source]) }));
                const cached = this.store.read(slot, key, validMapping);
                this.stats.cacheMs += performance.now() - started;
                if (cached) return cached;
            } catch {
                // A cache failure must never become a compiler failure (which
                // the upstream plugin can treat as an empty virtual document).
                slot = key = null;
            }
        }
        const compileStarted = performance.now();
        this.stats.compiled++;
        const result = original.call(compiler, source, options);
        this.stats.compileMs += performance.now() - compileStarted;
        if (slot && key && validMapping(result)) {
            const storeStarted = performance.now();
            try {
                // Round-trip validation rejects unsupported/non-JSON metadata.
                const output = JSON.parse(JSON.stringify({ js: result.js, locs: result.locs, diagnostics: result.diagnostics }));
                if (validMapping(output)) { this.store.write(slot, key, output); this.stats.stored++; }
            } catch {}
            this.stats.cacheMs += performance.now() - storeStarted;
        }
        return result;
    }
    report() {
        return { ...this.store.stats, ...this.stats,
            compileMs: Math.round(this.stats.compileMs), cacheMs: Math.round(this.stats.cacheMs) };
    }
}
module.exports = { VirtualTypeScriptCache, validMapping };
