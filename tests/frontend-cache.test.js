import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CompilerCache } from '../compile-cache.js';
import { FrontendProject } from '../frontend-project.js';

const fixtures = [];
afterEach(() => { for (const file of fixtures.splice(0)) fs.rmSync(file, { recursive: true, force: true }); });
const tag = width => `tag cache-probe\n\tcss w:${width}px\n\t<self> 'Ready'\n`;
function fixture({ toolchain = false } = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bimba-frontend-'));
    fixtures.push(cwd);
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"frontend-fixture","type":"module"}');
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler' }, include: ['src/**/*'] }));
    if (toolchain) fs.symlinkSync(path.join(import.meta.dir, '../node_modules'), path.join(cwd, 'node_modules'), 'dir');
    else fs.mkdirSync(path.join(cwd, 'node_modules'));
    return cwd;
}
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimba-artifacts-')); fixtures.push(root); return root; }
function write(cwd, name, value) { fs.writeFileSync(path.join(cwd, name), value); }

describe('frontend compilation snapshots', () => {
    test('reuses identical source across checkout paths, preserving CSS and relative imports', async () => {
        const a = fixture(), b = fixture(), cache = directory();
        const first = new CompilerCache({ cwd: a, directory: cache });
        const second = new CompilerCache({ cwd: b, directory: cache });
        const source = "import './dependency.imba'\n" + tag(10);
        const output = first.compile(source, { sourcePath: path.join(a, 'src/probe.imba'), platform: 'browser', comments: false });
        const restored = second.compile(source, { sourcePath: path.join(b, 'src/probe.imba'), platform: 'browser', comments: false });
        expect(restored.js).toBe(output.js);
        expect(restored.js).toContain("'./dependency.imba'");
        expect(restored.js).toContain('width: 10px');
        expect(second.stats).toEqual({ hits: 1, compiled: 0 });
    });
    test('keeps one latest result per variant, binds environment, rejects corruption and syntax errors', () => {
        const cwd = fixture(), cache = directory();
        const compiler = new CompilerCache({ cwd, directory: cache });
        const options = { sourcePath: path.join(cwd, 'src/probe.imba'), platform: 'browser', comments: false };
        for (let i = 0; i < 20; i++) expect(compiler.compile(tag(i), options).errors).toEqual([]);
        expect(fs.readdirSync(path.join(cache, 'compiled'))).toHaveLength(1);
        const output = compiler.compile(tag(19), options).js;
        const file = path.join(cache, 'compiled', fs.readdirSync(path.join(cache, 'compiled'))[0]);
        const corrupt = JSON.parse(fs.readFileSync(file)); corrupt.output.js = 'broken'; fs.writeFileSync(file, JSON.stringify(corrupt));
        expect(compiler.compile(tag(19), options).js).toBe(output);
        fs.writeFileSync(file, 'null'); expect(compiler.compile(tag(19), options).js).toBe(output);
        const malformed = JSON.parse(fs.readFileSync(file)); delete malformed.output; fs.writeFileSync(file, JSON.stringify(malformed));
        expect(compiler.compile(tag(19), options).js).toBe(output);
        expect(compiler.compile(tag(19) + 'const invalid=(\n', options).errors.length).toBeGreaterThan(0);
        expect(compiler.compile(tag(19), options).js).toBe(output);
        expect(compiler.compile(tag(19), { ...options, hmr: true, styles: 'extern' }).js).not.toBe(output);
        expect(fs.readdirSync(path.join(cache, 'compiled'))).toHaveLength(2);
        const previous = process.env.BIMBA_TEST_FLAG;
        try {
            process.env.BIMBA_TEST_FLAG = '1'; const yes = compiler.compile('export const flag = $BIMBA_TEST_FLAG$', options).js;
            process.env.BIMBA_TEST_FLAG = ''; expect(compiler.compile('export const flag = $BIMBA_TEST_FLAG$', options).js).not.toBe(yes);
        } finally { if (previous === undefined) delete process.env.BIMBA_TEST_FLAG; else process.env.BIMBA_TEST_FLAG = previous; }
    });
    test('reuses diagnostic coverage in a different checkout without invoking diagnostics', async () => {
        const a = fixture(), b = fixture(), cache = directory();
        for (const cwd of [a, b]) write(cwd, 'src/probe.imba', tag(10));
        let calls = 0;
        const diagnostics = async () => { calls++; return true; };
        expect((await new FrontendProject({ cwd: a, directory: cache }).check({ diagnostics })).passed).toBe(true);
        const reused = await new FrontendProject({ cwd: b, directory: cache }).check({ diagnostics });
        expect(reused.mode).toBe('snapshot-reused'); expect(calls).toBe(1);
        expect(reused.compiler).toEqual({ hits: 1, compiled: 0 });
    });
    test('compares only changed Imba sources for CSS equivalence', async () => {
        const cwd = fixture({ toolchain: true }), cache = directory();
        write(cwd, 'src/probe.imba', tag(10)); write(cwd, 'src/other.imba', 'export const value = 42\n');
        let calls = 0;
        const project = new FrontendProject({ cwd, directory: cache }), diagnostics = async () => { calls++; return true; };
        await project.check({ diagnostics });
        write(cwd, 'src/probe.imba', tag(20));
        const repeated = await project.check({ diagnostics });
        expect(repeated.mode).toBe('snapshot-reused'); expect(calls).toBe(1);
        write(cwd, 'src/other.imba', 'export const value = "text"\n');
        const changed = await project.check({ diagnostics });
        expect(changed.mode).toBe('diagnostics'); expect(changed.checked).toBe(2); expect(calls).toBe(2);
    }, 20000);
    test('partial checks cannot prove other files; code, JS, dependency and membership changes invalidate coverage', async () => {
        const cwd = fixture(), cache = directory(), project = new FrontendProject({ cwd, directory: cache });
        write(cwd, 'src/a.imba', 'export const value = 1\n'); write(cwd, 'src/b.imba', 'export const value = 2\n');
        const calls = [], diagnostics = async files => { calls.push(files); return true; };
        await project.check({ files: ['src/a.imba'], diagnostics });
        await project.check({ diagnostics }); expect(calls.at(-1)).toEqual(['src/b.imba']);
        write(cwd, 'src/a.imba', 'export const value = "wrong"\n');
        await project.check({ diagnostics }); expect(calls.at(-1)).toEqual(['src/a.imba', 'src/b.imba']);
        write(cwd, 'src/helper.js', 'export const value = 2;'); await project.check({ diagnostics }); expect(calls.at(-1)).toHaveLength(2);
        write(cwd, 'node_modules/dependency.js', 'changed'); await project.check({ diagnostics }); expect(calls.at(-1)).toHaveLength(2);
        write(cwd, 'src/c.imba', 'export const value = 3\n'); await project.check({ diagnostics }); expect(calls.at(-1)).toHaveLength(3);
        fs.unlinkSync(path.join(cwd, 'src/c.imba')); await project.check({ diagnostics }); expect(calls.at(-1)).toHaveLength(2);
    });
    test('failure, corrupted proof, force and edits during checking cannot publish a complete success', async () => {
        const cwd = fixture(), cache = directory(), project = new FrontendProject({ cwd, directory: cache });
        write(cwd, 'src/a.imba', 'export const value = 1\n');
        await project.check({ diagnostics: async () => true });
        const record = JSON.parse(fs.readFileSync(project.proofFile)); record.proof.coverage.push('fake'); fs.writeFileSync(project.proofFile, JSON.stringify(record));
        expect((await project.check({ diagnostics: async () => false })).passed).toBe(false);
        expect(fs.existsSync(project.proofFile)).toBe(false);
        expect(fs.readdirSync(path.join(cache, 'compiled'))).toHaveLength(1);
        const changing = await project.check({ diagnostics: async () => { write(cwd, 'src/a.imba', 'export const value = 2\n'); return true; } });
        expect(changing.stable).toBe(false); expect(changing.passed).toBe(false);
        await project.check({ diagnostics: async () => true });
        let forced = false;
        const result = await new FrontendProject({ cwd, directory: cache, force: true }).check({ diagnostics: async () => { forced = true; return true; } });
        expect(forced).toBe(true); expect(result.compiler.compiled).toBe(1);
    });
    test('tracks actual external project files and refuses reuse after they change', async () => {
        const cwd = fixture(), cache = directory(), external = path.join(directory(), 'shared.d.ts');
        write(cwd, 'src/probe.imba', 'export const value = 1\n'); fs.writeFileSync(external, 'export type Shared = number');
        const project = new FrontendProject({ cwd, directory: cache });
        let calls = 0;
        const diagnostics = async (_files, options) => { calls++; options.projectFiles([external]); return true; };
        expect((await project.check({ diagnostics })).passed).toBe(true);
        expect((await project.check({ diagnostics })).mode).toBe('snapshot-reused');
        fs.writeFileSync(external, 'export type Shared = string');
        expect((await project.check({ diagnostics })).mode).toBe('diagnostics'); expect(calls).toBe(2);
    });
    test('real diagnostics catch a consumer after its imported type changes and recover after repair', async () => {
        const cwd = fixture({ toolchain: true }), cache = directory();
        write(cwd, 'src/dependency.imba', 'export const value = 42\n');
        write(cwd, 'src/consumer.imba', "import {value} from './dependency.imba'\nvalue.toFixed!\n");
        const project = new FrontendProject({ cwd, directory: cache });
        const previous = process.env.BIMBA_NO_TYPECHECK_DAEMON;
        process.env.BIMBA_NO_TYPECHECK_DAEMON = '1';
        try {
        expect((await project.check()).passed).toBe(true);
        expect((await project.check()).mode).toBe('snapshot-reused');
        write(cwd, 'src/dependency.imba', 'export const value = "wrong"\n');
        expect((await project.check()).passed).toBe(false);
        expect(fs.existsSync(project.proofFile)).toBe(false);
        write(cwd, 'src/dependency.imba', 'export const value = 42\n');
        expect((await project.check()).passed).toBe(true);
        } finally { if (previous === undefined) delete process.env.BIMBA_NO_TYPECHECK_DAEMON; else process.env.BIMBA_NO_TYPECHECK_DAEMON = previous; }
    }, 30000);
});
