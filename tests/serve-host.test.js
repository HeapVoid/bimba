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

test('mounted source roots keep modules, dependencies, assets and HMR separate from the host', async () => {
	const host = await mkdtemp(join(tmpdir(), 'bimba-mount-host-'))
	const project = await mkdtemp(join(tmpdir(), 'bimba-mount-project-'))
	const other = await mkdtemp(join(tmpdir(), 'bimba-mount-other-'))
	fixtures.push(host, project, other)
	async function file(root, name, value) {
		await mkdir(join(root, name, '..'), {recursive:true})
		await Bun.write(join(root, name), value)
	}
	await file(host, 'src/app.imba', 'export const value = 1\n')
	await file(host, 'index.html', '<html><head></head><body></body></html>')
	await file(host, 'examples/plugin.js', 'export default "HOST";')
	await file(other, 'examples/plugin.js', 'export default "OTHER";')
	await file(project, 'examples/plugin.js', 'export {default} from "./nested/value ?%# ю.js"; export {default as typed} from "./typed"; export {default as packageValue} from "fixture-value";')
	await file(project, 'examples/nested/value ?%# ю.js', 'export default "PROJECT";')
	await file(project, 'examples/typed.ts', 'export default "TYPED" as string;')
	await file(project, 'examples/view.imba', 'export default "IMBA"\n')
	await file(project, 'examples/typed.tsx', 'export default "TSX" as string;')
	await file(project, 'examples/module.mjs', 'export default "ESM";')
	await file(project, 'examples/common.cjs', 'module.exports = require("./value.cjs");')
	await file(project, 'examples/value.cjs', 'module.exports = "COMMON";')
	await file(project, 'examples/data.json', '{"value":"JSON"}')
	await file(project, 'examples/theme.css', '.fixture {background:url("./icon.svg")}')
	await file(project, 'examples/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
	await file(project, 'node_modules/fixture-value/package.json', JSON.stringify({name:'fixture-value',exports:{browser:'./browser.js',default:'./wrong.js'}}))
	await file(project, 'node_modules/fixture-value/browser.js', 'export default "PACKAGE";')
	await file(project, 'node_modules/fixture-value/wrong.js', 'throw Error("Wrong export condition");')
	await file(project, 'examples/escape.js', 'export default "OUTSIDE";')
	const {symlink} = await import('node:fs/promises')
	await symlink(join(other, 'examples/plugin.js'), join(project, 'examples/link.js'))
	await file(host, 'host.mjs', `
import {serve} from ${JSON.stringify(join(import.meta.dir, '../serve.js'))};
const roots = ${JSON.stringify({project, other, host})};
const server = serve('src/app.imba', {port:0,hostname:'127.0.0.1',watchRoot:'src',fetch(request) {
  const query = new URL(request.url);
  if (query.pathname === '/module') return new Response(server.moduleUrl(roots[query.searchParams.get('root')] + '/examples/' + (query.searchParams.get('file') || 'plugin.js'), roots[query.searchParams.get('root')]));
}});
console.log('TEST_SERVER ' + server.url);
`)
	const child = Bun.spawn([process.execPath, 'host.mjs'], {cwd:host,stdout:'pipe',stderr:'inherit'})
	children.push(child)
	const reader = child.stdout.getReader()
	let output = '', origin
	while (!origin) {
		const result = await reader.read()
		if (result.done) throw Error('Mounted server exited before readiness')
		output += new TextDecoder().decode(result.value)
		origin = output.match(/TEST_SERVER (http:\/\/\S+)/)?.[1]
	}
	const request = (path, headers) => fetch(new URL(path, origin), {headers})
	const address = async (root, file = 'plugin.js') => (await request('/module?root=' + root + '&file=' + encodeURIComponent(file))).text()
	expect(await address('host')).toBe('/examples/plugin.js')
	expect((await (await request(await address('host'))).text())).toContain('HOST')
	const projectUrl = await address('project'), otherUrl = await address('other')
	expect(projectUrl).not.toBe(otherUrl)
	expect(await address('project')).toBe(projectUrl)
	const source = async path => {
		const response = await request(path, {'sec-fetch-dest':'script'})
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('javascript')
		return response.text()
	}
	const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
	const plugin = await source(projectUrl)
	expect(plugin).not.toContain('HOST')
	const relative = [...new Bun.Transpiler({loader:'js'}).scanImports(plugin)].map(item=>item.path)
	expect((await load(await source(new URL(relative[0], new URL(projectUrl, origin))))).default).toBe('PROJECT')
	expect((await load(await source(new URL(relative[1], new URL(projectUrl, origin))))).default).toBe('TYPED')
	expect((await load(await source(relative[2]))).default).toBe('PACKAGE')
	expect((await load(await source(otherUrl))).default).toBe('OTHER')
	for (const [file, value] of [['typed.tsx','TSX'],['module.mjs','ESM'],['common.cjs','COMMON'],['data.json','JSON']]) {
		const module = await load(await source(await address('project', file)))
		expect(file === 'data.json' ? module.default.value : module.default).toBe(value)
	}
	expect(await source(await address('project', 'view.imba'))).toContain('export default "IMBA"')
	const cssUrl = await address('project', 'theme.css')
	expect(await source(cssUrl)).toContain(JSON.stringify(cssUrl))
	const css = await (await request(cssUrl)).text()
	expect(css).toContain('./icon.svg')
	const iconUrl = new URL('./icon.svg', new URL(cssUrl, origin))
	expect(await (await request(iconUrl)).text()).toContain('<svg')
	expect((await load(await source(iconUrl))).default).toBe(iconUrl.pathname)
	await rm(join(host, 'examples/plugin.js'))
	expect(await source(projectUrl)).toContain('./nested/value%20%3F%25%23%20%D1%8E.js')
	const prefix = projectUrl.slice(0, projectUrl.indexOf('/examples/'))
	expect((await request(prefix + '/examples/link.js')).status).toBe(404)
	expect((await request(prefix + '/%2e%2e%2fexamples/plugin.js')).status).toBe(404)
	expect((await request(prefix.replace(/[^/]+$/, 'unknown') + '/examples/plugin.js')).status).toBe(404)

	const socket = new WebSocket(new URL('/__hmr__', origin).toString().replace('http:', 'ws:'))
	sockets.push(socket)
	await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
	async function change(file, text, address) {
		const changed = new Promise((resolve,reject)=>{
			const timer=setTimeout(()=>reject(Error('Mounted HMR missing for '+file)),3000)
			const receive=event=>{const message=JSON.parse(event.data);if(!message.paths?.includes(address))return;clearTimeout(timer);socket.removeEventListener('message',receive);resolve(message)}
			socket.addEventListener('message', receive)
		})
		await Bun.write(join(project, 'examples', file), text)
		return changed
	}
	expect((await change('value.cjs', 'module.exports = "CHANGED";', await address('project','common.cjs'))).type).toBe('reload')
	expect((await load(await source(await address('project','common.cjs')))).default).toBe('CHANGED')
	expect((await change('theme.css', '.fixture {color:blue}', cssUrl)).type).toBe('css')
}, 15000)
