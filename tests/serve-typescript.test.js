import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(import.meta.dir, '..')
const servers = []
const fixtures = []

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.kill()
		await server.exited
	}
	for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true })
})

describe('dev server TypeScript modules', () => {
	test('transpiles direct and extensionless imports, then reloads on change', async () => {
		const fixture = await mkdtemp(join(tmpdir(), 'bimba-typescript-'))
		fixtures.push(fixture)
		await mkdir(join(fixture, 'src'))
		await mkdir(join(fixture, 'public'))

		await Bun.write(join(fixture, 'public/index.html'), '<!doctype html><script type="module" data-entrypoint></script>')
		await Bun.write(join(fixture, 'src/app.imba'), "import {value} from './config.ts'\nconsole.log value\n")
		await Bun.write(join(fixture, 'src/config.ts'), 'export interface Config { value: string }\nexport const value: string = "ready"\n')

		const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
		const port = probe.port
		probe.stop(true)

		const server = Bun.spawn([
			'bun', join(root, 'index.js'), 'src/app.imba', '--serve', '--port', String(port), '--html', 'public/index.html',
		], { cwd: fixture, stdout: 'ignore', stderr: 'ignore' })
		servers.push(server)

		await ready(port)

		const direct = await fetch(`http://localhost:${port}/src/config.ts`)
		const directCode = await direct.text()
		expect(direct.status).toBe(200)
		expect(direct.headers.get('content-type')).toContain('application/javascript')
		expect(directCode).toContain('export const value = "ready"')
		expect(directCode).not.toContain('interface Config')

		const extensionless = await fetch(`http://localhost:${port}/src/config`)
		expect(extensionless.status).toBe(200)
		expect(extensionless.headers.get('content-type')).toContain('application/javascript')

		const socket = new WebSocket(`ws://localhost:${port}/__hmr__`)
		await opened(socket)
		const reloaded = message(socket, 'reload')
		await Bun.write(join(fixture, 'src/config.ts'), 'export const value: string = "updated"\n')
		expect(await reloaded).toEqual({ type: 'reload' })
		socket.close()
	})
})

async function ready(port) {
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			const response = await fetch(`http://localhost:${port}/`)
			if (response.ok) return
		} catch (_) {}
		await Bun.sleep(25)
	}
	throw new Error('Dev server did not start')
}

function opened(socket) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('WebSocket did not open')), 2000)
		socket.addEventListener('open', () => {
			clearTimeout(timeout)
			resolve()
		}, { once: true })
	})
}

function message(socket, type) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.removeEventListener('message', receive)
			reject(new Error('Reload message was not received'))
		}, 3000)
		const receive = event => {
			const payload = JSON.parse(event.data)
			if (payload.type !== type) return
			clearTimeout(timeout)
			socket.removeEventListener('message', receive)
			resolve(payload)
		}
		socket.addEventListener('message', receive)
	})
}
