import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixtures = []
const children = []
const sockets = []

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close()
	for (const child of children.splice(0)) { child.kill(); await child.exited }
	for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true })
})

test('an embedded dev server owns routing, import maps, watched dependencies and shutdown', async () => {
	const root = await mkdtemp(join(tmpdir(), 'bimba-host-'))
	fixtures.push(root)
	await mkdir(join(root, 'src/page'), { recursive: true })
	const file = (path, value) => Bun.write(join(root, path), value)
	await file('index.html', '<html><head></head><body></body></html>')
	await file('src/page/app#draft.imba', 'export const value = 42\n')
	await file('src/plugin#draft.cjs', 'module.exports = {value:require("./value.cjs")};')
	await file('src/value.cjs', 'module.exports = "first";')
	await file('src/plugin ?% ю.js', 'export default "encoded";')
	await file('src/parent.js', 'export {default} from "./plugin ?% ю.js";')
	await file('src/component#draft.imba', 'export const value = 42\n')
	await file('src/theme#draft.css', '.fixture {color:red;}')
	await file('host.mjs', `
import {serve} from ${JSON.stringify(join(import.meta.dir, '../serve.js'))};
const server = serve('src/page/app#draft.imba', {
  port:0, hostname:'127.0.0.1', watchRoot:'src', imports:{'fixture:plugin':'/src/plugin%23draft.cjs'},
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/ready') return Response.json({ready:true});
    if (path === '/api/stop') { setTimeout(() => server.stop(true), 20); return new Response('stopping'); }
    return null;
  }
});
console.log('TEST_SERVER ' + server.url);
`)
	const child = Bun.spawn([process.execPath, 'host.mjs'], { cwd:root, stdout:'pipe', stderr:'inherit' })
	children.push(child)
	const reader = child.stdout.getReader()
	let output = ''
	let url
	while (!url) {
		const result = await reader.read()
		if (result.done) throw new Error('Embedded server exited before readiness')
		output += new TextDecoder().decode(result.value)
		url = output.match(/TEST_SERVER (http:\/\/\S+)/)?.[1]
	}
	const request = path => fetch(new URL(path, url))
	expect(await (await request('/api/ready')).json()).toEqual({ready:true})
	expect((await request('/missing.js')).status).toBe(404)
	const html = await (await request('/')).text()
	expect(html).toContain('"fixture:plugin":"/src/plugin%23draft.cjs"')
	expect(html).toContain('/src/page/app%23draft.imba')
	expect(html).toContain('await import(fileUrl(file)')

	async function module(path) {
		const response = await request(path)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('javascript')
		return import('data:text/javascript;base64,' + Buffer.from(await response.text()).toString('base64'))
	}
	expect((await module('/src/plugin%23draft.cjs')).default.value).toBe('first')
	expect((await module('/src/' + encodeURIComponent('plugin ?% ю.js'))).default).toBe('encoded')
	const parent = await (await request('/src/parent.js')).text()
	expect(parent).toContain('./' + encodeURIComponent('plugin ?% ю.js'))
	const component = await request('/src/component%23draft.imba')
	expect(component.status).toBe(200)
	expect(component.headers.get('content-type')).toContain('javascript')
	const stylesheet = await fetch(new URL('/src/theme%23draft.css', url), {headers:{'sec-fetch-dest':'script'}})
	expect(stylesheet.status).toBe(200)
	expect(await stylesheet.text()).toContain('"/src/theme%23draft.css"')

	const socket = new WebSocket(new URL('/__hmr__', url).toString().replace('http:', 'ws:'))
	sockets.push(socket)
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, {once:true})
		socket.addEventListener('error', reject, {once:true})
	})
	async function change(path, source, type = 'reload') {
		const received = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('HMR did not report ' + path)), 2500)
			const receive = event => {
				const message = JSON.parse(event.data)
				if (message.type !== type || message.file !== path) return
				clearTimeout(timer)
				socket.removeEventListener('message', receive)
				resolve(message)
			}
			socket.addEventListener('message', receive)
		})
		await file(path, source)
		return received
	}
	const dependency = await change('src/value.cjs', 'module.exports = "second";')
	expect(dependency.paths).toContain('/src/plugin%23draft.cjs')
	expect((await module('/src/plugin%23draft.cjs')).default.value).toBe('second')
	const plugin = await change('src/plugin#draft.cjs', 'module.exports = {value:"third"};')
	expect(plugin.paths).toContain('/src/plugin%23draft.cjs')
	expect((await module('/src/plugin%23draft.cjs')).default.value).toBe('third')
	const native = await change('src/component#draft.imba', 'export const value = 43\n', 'update')
	expect(native.paths).toContain('/src/component%23draft.imba')
	const css = await change('src/theme#draft.css', '.fixture {color:blue;}', 'css')
	expect(css.paths).toContain('/src/theme%23draft.css')
	expect(css.css).toContain('blue')
	socket.close()
	await request('/api/stop')
	expect(await child.exited).toBe(0)
}, 10000)
