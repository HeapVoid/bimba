import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(import.meta.dir, '..')
const fixtures = []

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true })
})

async function fixture(config = true) {
	const cwd = await mkdtemp(join(tmpdir(), 'bimba-typecheck-'))
	fixtures.push(cwd)
	await mkdir(join(cwd, 'src'))
	await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir')
	if (config) await Bun.write(join(cwd, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler' },
		include: ['src/**/*'],
	}))
	return cwd
}

async function check(cwd, env = {}, paths = ['src']) {
	const child = Bun.spawn(['bun', join(root, 'index.js'), ...paths, '--typecheck'], {
		cwd, env: { ...process.env, BIMBA_TYPECHECK_TIMEOUT: '10000', ...env }, stdout: 'pipe', stderr: 'pipe',
	})
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	])
	return { code, output: (out + err).replace(/\x1b\[[0-9;]*m/g, '') }
}

describe('Imba TypeScript diagnostics', () => {
	test('checks only selected files and batches several paths in one session', async () => {
		const cwd = await fixture()
		await Bun.write(join(cwd, 'src/good.imba'), 'const value = 42\nvalue.toFixed!\n')
		await Bun.write(join(cwd, 'src/bad.imba'), "const value = 'wrong type'\nvalue.toFixed!\n")
		const single = await check(cwd, {}, ['src/good.imba'])
		expect(single.code).toBe(0)
		expect(single.output).toContain('for 1 Imba file')
		expect(single.output).not.toContain('src/bad.imba')
		const batch = await check(cwd, {}, ['src/good.imba', 'src/bad.imba', 'src/good.imba'])
		expect(batch.code).toBe(1)
		expect(batch.output).toContain('for 2 Imba files')
		expect(batch.output).toContain('src/bad.imba:2:7')
		expect(batch.output).toContain('TS2551')
	}, 30000)

	test('rejects a non-Imba file passed to typecheck', async () => {
		const cwd = await fixture()
		await Bun.write(join(cwd, 'src/other.js'), 'console.log(42)\n')
		const result = await check(cwd, {}, ['src/other.js'])
		expect(result.code).toBe(1)
		expect(result.output).toContain('not an Imba file')
	}, 15000)

	test('checks real types in an Imba-only project', async () => {
		const cwd = await fixture()
		const source = join(cwd, 'src/probe.imba')
		await Bun.write(source, "const value = 'typecheck probe'\nvalue.toFixed!\n")
		const invalid = await check(cwd)
		expect(invalid.code).toBe(1)
		expect(invalid.output).toContain('src/probe.imba:2:7')
		expect(invalid.output).toContain('TS2551')
		expect(invalid.output).not.toContain('Timed out')
		await Bun.write(source, 'const value = 42\nvalue.toFixed!\n')
		const valid = await check(cwd)
		expect(valid.code).toBe(0)
		expect(valid.output).toContain('No Imba TypeScript diagnostics')
	}, 30000)

	for (const excluded of [false, true]) {
		test(`rejects files ${excluded ? 'excluded from the project' : 'without a project config'} instead of a false success`, async () => {
			const cwd = await fixture(false)
			await Bun.write(join(cwd, 'src/probe.imba'), "const value = 'typecheck probe'\nvalue.toFixed!\n")
			if (excluded) {
				await Bun.write(join(cwd, 'test.js'), 'console.log(1)\n')
				await Bun.write(join(cwd, 'jsconfig.json'), JSON.stringify({compilerOptions:{allowJs:true,checkJs:false},include:['test.js']}))
			}
			const result = await check(cwd)
			expect(result.code).toBe(1)
			expect(result.output).toContain('not included in a project configuration')
			expect(result.output).not.toContain('Timed out')
		}, 15000)
	}

	test('reports a config error without a source position instead of timing out', async () => {
		const cwd = await fixture()
		await Bun.write(join(cwd, 'src/probe.imba'), 'console.log 42\n')
		await Bun.write(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'broken-target' }, include: ['src/**/*'] }))
		const result = await check(cwd)
		expect(result.code).toBe(1)
		expect(result.output).toContain('tsconfig.json')
		expect(result.output).toContain('TS6046')
		expect(result.output).not.toContain('Timed out')
	}, 15000)

	test('reports malformed Imba without timing out', async () => {
		const cwd = await fixture()
		await Bun.write(join(cwd, 'src/probe.imba'), 'const value = [\n')
		const result = await check(cwd)
		expect(result.code).toBe(1)
		expect(result.output).toContain('src/probe.imba')
		expect(result.output).not.toContain('Timed out')
		expect(result.output).not.toContain('No Imba TypeScript diagnostics')
	}, 15000)

	test('maps diagnostics after Unicode text and across several files', async () => {
		const cwd = await fixture()
		await Bun.write(join(cwd, 'src/good.imba'), "console.log 'Привет 👋'\n")
		await Bun.write(join(cwd, 'src/bad.imba'), "const text = 'Ошибка 🧪'\ntext.toFixed!\n")
		const result = await check(cwd)
		expect(result.code).toBe(1)
		expect(result.output).toContain('src/bad.imba:2:6')
		expect(result.output).toContain('TS2551')
		expect(result.output).not.toContain('Timed out')
	}, 15000)

	test('reports a tsserver startup exit immediately', async () => {
		const cwd = await fixture()
		await Bun.write(join(cwd, 'src/probe.imba'), 'console.log 42\n')
		const result = await check(cwd, { BIMBA_NODE: '/usr/bin/false' })
		expect(result.code).toBe(1)
		expect(result.output).toMatch(/TypeScript exited|EPIPE/)
		expect(result.output).not.toContain('Timed out')
	}, 15000)

	test('checks remaining files when a project update interrupts diagnostics', async () => {
		const cwd = await fixture()
		await Bun.write(join(cwd, 'src/first.imba'), 'console.log 42\n')
		await Bun.write(join(cwd, 'src/last.imba'), "const text = 'still checked'\ntext.toFixed!\n")
		const proxy = join(cwd, 'tsserver-proxy.cjs')
		// Send a real tsserver change during geterr. TypeScript cancels the
		// remaining diagnostics but still sends requestCompleted for that batch.
		await Bun.write(proxy, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(child.stdin);
let buffer = Buffer.alloc(0), changed = false;
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const header = buffer.indexOf('\\r\\n\\r\\n');
    if (header < 0) break;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
    if (buffer.length < header + 4 + length) break;
    const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length));
    buffer = buffer.subarray(header + 4 + length);
    if (!changed && message.event === 'syntaxDiag') {
      changed = true;
      process.stderr.write('Injected project update\\n');
      child.stdin.write(JSON.stringify({seq: 1000000, type: 'request', command: 'change', arguments: {
        file: message.body.file, line: 1, offset: 1, endLine: 1, endOffset: 1, insertString: ''
      }}) + '\\n');
    }
  }
  process.stdout.write(chunk);
});
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => { child.kill(); process.exit(0); });
`)
		await chmod(proxy, 0o755)
		const result = await check(cwd, { BIMBA_NODE: proxy })
		expect(result.output).toContain('Injected project update')
		expect(result.code).toBe(1)
		expect(result.output).toContain('src/last.imba:2:6')
		expect(result.output).toContain('TS2551')
		expect(result.output).not.toContain('Timed out')
	}, 15000)
})
