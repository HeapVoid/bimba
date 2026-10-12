import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(import.meta.dir, '..')
const fixtures = []

afterEach(async () => {
	for (const cwd of fixtures.splice(0)) await rm(cwd, { recursive: true, force: true })
})

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), 'bimba-bundle-check-'))
	fixtures.push(cwd)
	await mkdir(join(cwd, 'src'))
	await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir')
	await Bun.write(join(cwd, 'bunfig.toml'), '# Compile with the CLI plugin.\n')
	await Bun.write(join(cwd, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { allowJs: true, checkJs: false, skipLibCheck: true, types: [], strict: false, module: 'Preserve', moduleResolution: 'Bundler' },
		include: ['src/**/*'],
	}))
	await Bun.write(join(cwd, 'src/app.imba'), "import {value} from './config.ts'\nconsole.log value\n")
	return cwd
}

async function bundle(cwd, ...flags) {
	const child = Bun.spawn([process.execPath, join(root, 'index.js'), 'src/app.imba', '--outdir', 'out', ...flags], {
		cwd, stdout: 'pipe', stderr: 'pipe',
	})
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { code, output: (out + err).replace(/\x1b\[[0-9;]*m/g, '') }
}

test.skipIf(!process.versions.typescript)('native bundle check covers TypeScript imported from Imba before writing output', async () => {
	const cwd = await fixture()
	const source = join(cwd, 'src/config.ts')
	await Bun.write(source, 'export const value: number = "wrong"\n')
	const invalid = await bundle(cwd, '--check')
	expect(invalid.code).toBe(1)
	expect(invalid.output).toContain('TS2322')
	expect(invalid.output).toContain('config.ts')
	expect(invalid.output).not.toContain('Success')
	expect(existsSync(join(cwd, 'out'))).toBe(false)

	const unchecked = await bundle(cwd)
	expect(unchecked.code).toBe(0)
	expect(existsSync(join(cwd, 'out/app.js'))).toBe(true)
	await rm(join(cwd, 'out'), { recursive: true })

	await Bun.write(source, 'export const value: number = 42\n')
	const valid = await bundle(cwd, '--check')
	expect(valid.code).toBe(0)
	expect(existsSync(join(cwd, 'out/app.js'))).toBe(true)
})

test('native bundle check rejects incompatible modes or runtimes explicitly', async () => {
	const cwd = await fixture()
	const result = await bundle(cwd, '--check', '--serve')
	expect(result.code).toBe(1)
	expect(result.output).toContain('--check applies to bundle mode')
	if (!process.versions.typescript) {
		const unsupported = await bundle(cwd, '--check')
		expect(unsupported.code).toBe(1)
		expect(unsupported.output).toContain('--check requires Bun 1.4.3')
		expect(existsSync(join(cwd, 'out'))).toBe(false)
		await Bun.write(join(cwd, 'src/config.ts'), 'export const value: number = 42\n')
		const normal = await bundle(cwd)
		expect(normal.code).toBe(0)
		expect(existsSync(join(cwd, 'out/app.js'))).toBe(true)
	}
})
