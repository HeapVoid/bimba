const { createRequire, Module } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./compilation-store.cjs');

// This is the existing TypeView integration with the actual bundled compiler.
// A byte-exact compatibility match is required before accessing private classes.
const supported = new Set(['c8832e55231efbe96ff6de28df1fae7b9d6fb027a12ceb0884687f23674f7eb7']);
const loaded = new Map();
function loadPlugin(filename) {
    filename = fs.realpathSync(filename);
    const bundle = fs.readFileSync(filename, 'utf8');
    const identity = hash(bundle);
    if (loaded.get(filename)?.identity === identity) return loaded.get(filename);
    let factory, compiler, Compilation;
    if (supported.has(identity)) {
        const module = new Module(filename);
        module.filename = filename;
        module.paths = Module._nodeModulePaths(path.dirname(filename));
        module._compile(bundle + '\nmodule.exports.bimbaCompiler = imbac; module.exports.bimbaCompilation = Compilation2;', filename);
        factory = module.exports;
        compiler = factory.bimbaCompiler;
        Compilation = factory.bimbaCompilation;
    } else {
        const require = createRequire(filename);
        delete require.cache[filename];
        factory = require(filename);
    }
    const value = { factory, compiler, Compilation, identity };
    loaded.set(filename, value);
    return value;
}
module.exports = { loadPlugin };
