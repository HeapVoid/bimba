import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function until(predicate, message) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(40); }
    throw Error(message());
}
test('frontend serve warms production compilation, checks saved types and leaves healthy HMR available', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bimba-dev-proof-'));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bimba-dev-artifacts-'));
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.symlinkSync(path.join(import.meta.dir, '../node_modules'), path.join(cwd, 'node_modules'));
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"dev-proof","bimba":{"frontend":true}}');
    fs.writeFileSync(path.join(cwd, 'bunfig.toml'), '# Fixture uses the source CLI.\n');
    fs.writeFileSync(path.join(cwd, 'index.html'), '<!doctype html><script type="module" data-entrypoint></script>');
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler' }, include: ['src/**/*'] }));
    const source = path.join(cwd, 'src/app.imba'), proofFile = path.join(cache, 'frontend-types.json');
    fs.writeFileSync(source, 'export const value = 42\nvalue.toFixed!\n');
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') }), port = probe.port; probe.stop(true);
    const env = { ...process.env, CI: '', BIMBA_NO_TYPECHECK_DAEMON: '', BIMBA_CACHE_DIR: cache };
    const child = Bun.spawn(['bun', path.join(import.meta.dir, '../index.js'), 'src/app.imba', '--serve', '--port', String(port), '--html', 'index.html'], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) void (async () => { for await (const chunk of stream) output += new TextDecoder().decode(chunk); })();
    try {
        await until(() => fs.existsSync(proofFile), () => 'No development proof: ' + output);
        expect((await fetch(`http://127.0.0.1:${port}/src/app.imba`)).status).toBe(200);
        const check = Bun.spawn(['bun', path.join(import.meta.dir, '../index.js'), '--frontend-check'], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
        const text = await new Response(check.stdout).text();
        expect(await check.exited).toBe(0); expect(text).toContain('snapshot-reused'); expect(text).toContain('"compiled":0');
        fs.writeFileSync(source, 'export const value = "wrong"\nvalue.toFixed!\n');
        await until(() => output.includes('TS2551'), () => 'Saved error was not checked: ' + output);
        expect(fs.existsSync(proofFile)).toBe(false);
        expect((await fetch(`http://127.0.0.1:${port}/src/app.imba`)).status).toBe(200);
        fs.writeFileSync(source, 'export const value = 42\nvalue.toFixed!\n');
        await until(() => fs.existsSync(proofFile), () => 'Repaired source was not checked: ' + output);
    } finally { child.kill(); await child.exited; fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); }
}, 45000);
