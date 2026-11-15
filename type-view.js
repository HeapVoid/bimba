import { createRequire } from 'node:module';
import path from 'node:path';
import { CompilerCache, hash } from './compile-cache.js';

import { loadPlugin } from './plugin-compiler.cjs';

export class TypeView {
    constructor(cwd, directory) {
        this.cache = new CompilerCache({ cwd, directory });
        const require = createRequire(path.join(cwd, 'package.json'));
        try {
            const filename = require.resolve('typescript-imba-plugin');
            const plugin = loadPlugin(filename);
            if (!plugin.compiler) return;
            this.compiler = plugin.compiler;
            this.identity = plugin.identity;
            this.ts = require('typescript');
        } catch {}
    }
    fingerprint(source, file) {
        if (!this.compiler?.compile) return null;
        try {
            const result = this.cache.compile(source, {
                target: 'tsc', platform: 'tsc', imbaPath: null, silent: true, noAnyTypes: true,
                sourcemap: 'hidden', fileName: file, sourcePath: file, sourceId: 'bimba' + hash(file).slice(0, 12),
            }, { kind: 'plugin-types', identity: this.identity, compile: this.compiler.compile.bind(this.compiler) });
            if (!result.js || result.errors?.length || result.diagnostics?.length || /@ts-(?:ignore|expect-error|check|nocheck)/.test(result.js)) return null;
            const tree = this.ts.createSourceFile(file, result.js, this.ts.ScriptTarget.Latest, true, this.ts.ScriptKind.TS);
            if (tree.parseDiagnostics.length) return null;
            return hash(this.ts.createPrinter({ removeComments: false, newLine: this.ts.NewLineKind.LineFeed }).printFile(tree));
        } catch { return null; }
    }
}
