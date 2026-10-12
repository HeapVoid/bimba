import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(import.meta.dir, '..')
const fixtures = []
const servers = []

afterEach(async () => {
	for (const server of servers.splice(0)) { server.kill(); await server.exited }
	for (const cwd of fixtures.splice(0)) await rm(cwd, { recursive: true, force: true })
})

test('virtual vendor modules preserve browser exports, CommonJS and nested resolution without disk wrappers', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'bimba-vendor-'))
	fixtures.push(cwd)
	async function file(name, content) {
		const filename = join(cwd, name)
		await mkdir(join(filename, '..'), { recursive: true })
		await Bun.write(filename, typeof content === 'string' ? content : JSON.stringify(content))
	}
	await file('index.html', '<!doctype html><html><head></head><body></body></html>')
	await file('src/app.imba', 'export const value = 42\n')
	await file('node_modules/fixture-dual/package.json', {
		name: 'fixture-dual', exports: { browser: './browser.js', default: './node.js' }, type: 'module',
	})
	await file('node_modules/fixture-dual/browser.js', 'export const value = "browser"; export default "default-browser";\n')
	await file('node_modules/fixture-dual/node.js', 'throw new Error("Node export must not load in a browser bundle");\n')
	await file('node_modules/fixture-cjs/package.json', { name: 'fixture-cjs', main: 'index.cjs' })
	await file('node_modules/fixture-cjs/index.cjs', 'module.exports = { value: require("fixture-nested").value };\n')
	for (const [base, value] of [['node_modules', 'root'], ['node_modules/fixture-cjs/node_modules', 'nested']]) {
		await file(`${base}/fixture-nested/package.json`, { name: 'fixture-nested', main: 'index.cjs' })
		await file(`${base}/fixture-nested/index.cjs`, `exports.value = ${JSON.stringify(value)};\n`)
	}
	await file('node_modules/@fixture/scoped/package.json', { name: '@fixture/scoped', exports: { './item': './item.js' }, type: 'module' })
	await file('node_modules/@fixture/scoped/item.js', 'export const value = "scoped";\n')

	const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
	const port = probe.port
	probe.stop(true)
	const server = Bun.spawn([process.execPath, join(root, 'index.js'), 'src/app.imba', '--serve', '--port', String(port)], {
		cwd, stdout: 'ignore', stderr: 'ignore',
	})
	servers.push(server)
	const url = `http://localhost:${port}`
	for (let attempt = 0; ; attempt++) {
		try { if ((await fetch(url)).ok) break } catch {}
		if (attempt > 80) throw new Error('Vendor fixture server did not start')
		await Bun.sleep(25)
	}
	let loaded = 0
	async function load(route) {
		const response = await fetch(url + route)
		const code = await response.text()
		expect(response.status).toBe(200)
		const module = `verified/${loaded++}.mjs`
		await file(module, code)
		return import(join(cwd, module))
	}
	const dual = await load('/__bimba_vendor__/fixture-dual')
	expect(dual.value).toBe('browser')
	expect(dual.default).toBe('default-browser')
	const cjs = await load('/__bimba_vendor__/fixture-cjs')
	expect(cjs.default.value).toBe('nested')
	const scoped = await load('/__bimba_vendor__/' + encodeURIComponent('@fixture/scoped/item'))
	expect(scoped.value).toBe('scoped')
	expect(scoped.default.value).toBe('scoped')
	const direct = await load('/node_modules/fixture-dual/browser.js')
	expect(direct.value).toBe('browser')
	expect(existsSync(join(cwd, 'node_modules/.cache'))).toBe(false)
})
