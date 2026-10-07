import { createRequire, Module } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CompilerCache, hash } from './compile-cache.js';

// This is the actual bundled compiler used by the supported language-service
// plugin. Unknown implementations get real diagnostics, never equivalence reuse.
const supported = 'c8832e55231efbe96ff6de28df1fae7b9d6fb027a12ceb0884687f23674f7eb7';
export class TypeView {
    constructor(cwd, directory) {
        this.cache = new CompilerCache({ cwd, directory });
        const require = createRequire(path.join(cwd, 'package.json'));
        try {
            const filename = require.resolve('typescript-imba-plugin');
            const bundle = fs.readFileSync(filename, 'utf8');
            if (hash(bundle) !== supported) return;
            const module = new Module(filename);
            module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
            module._compile(bundle + '\nmodule.exports.bimbaCompiler = imbac;', filename);
            this.compiler = module.exports.bimbaCompiler;
            this.ts = require('typescript');
        } catch {}
    }
    fingerprint(source, file) {
        if (!this.compiler?.compile) return null;
        try {
            const result = this.cache.compile(source, {
                target: 'tsc', platform: 'tsc', imbaPath: null, silent: true, noAnyTypes: true,
                sourcemap: 'hidden', fileName: file, sourcePath: file, sourceId: 'bimba' + hash(file).slice(0, 12),
            }, { kind: 'plugin-types', identity: supported, compile: this.compiler.compile.bind(this.compiler) });
            if (!result.js || result.errors?.length || result.diagnostics?.length || /@ts-(?:ignore|expect-error|check|nocheck)/.test(result.js)) return null;
            const tree = this.ts.createSourceFile(file, result.js, this.ts.ScriptTarget.Latest, true, this.ts.ScriptKind.TS);
            if (tree.parseDiagnostics.length) return null;
            return hash(this.ts.createPrinter({ removeComments: false, newLine: this.ts.NewLineKind.LineFeed }).printFile(tree));
        } catch { return null; }
    }
}
