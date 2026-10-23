import {afterEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, rm, symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Window} from 'happy-dom'

const fixtures = [], children = [], sockets = []
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close()
	for (const child of children.splice(0)) { child.kill(); await child.exited }
	for (const root of fixtures.splice(0)) await rm(root, {recursive:true, force:true})
})

test('resource imports share native files, JSON exports, package stylesheets and watched updates', async () => {
	const root = await mkdtemp(join(tmpdir(), 'bimba-resources-'))
	fixtures.push(root)
	async function file(name, value) {
		await mkdir(join(root, name, '..'), {recursive:true})
		await Bun.write(join(root, name), value)
	}
	await file('index.html', '<html><head></head><body></body></html>')
	await file('src/app.imba', 'export const value = 42\n')
	await file('src/data ?%#.json', '{"value":42,"nested":{"ok":true}}')
	await file('src/icon ?%#.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
	await file('src/font.woff2', new Uint8Array([119,79,70,50,0,128,255]))
	await file('src/document.custom', 'custom file bytes')
	await file('src/theme.css', '@import "./nested.css"; @font-face{font-family:fixture;src:url("./font.woff2")}')
	await file('src/nested.css', '.fixture {background:url("./icon%20%3F%25%23.svg")}')
	await file('src/imports.js', 'import data from "./data ?%#.json"; export {default as icon} from "./icon ?%#.svg"; export const load=()=>import("./document.custom");')
	await file('node_modules/fixture-style/package.json', JSON.stringify({name:'fixture-style',exports:{browser:'./theme.css',default:'./wrong.js'}}))
	await file('node_modules/fixture-style/theme.css', '@font-face{font-family:package;src:url("./font.woff2")}')
	await file('node_modules/fixture-style/font.woff2', new Uint8Array([1,2,128,255]))
	await file('node_modules/fixture-style/wrong.js', 'throw Error("Wrong export condition")')
	await file('node_modules/fixture-script/package.json', JSON.stringify({name:'fixture-script',main:'index.js',type:'module'}))
	await file('node_modules/fixture-script/index.js', 'import "fixture-style"; import icon from "./icon.svg"; export {icon}; export default 7;')
	await file('node_modules/fixture-script/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
	const external = await mkdtemp(join(tmpdir(), 'bimba-external-style-'))
	fixtures.push(external)
	await Bun.write(join(external,'package.json'), JSON.stringify({name:'external-style',main:'theme.css'}))
	await Bun.write(join(external,'theme.css'), '@font-face{font-family:external;src:url("./font.woff2")}')
	await Bun.write(join(external,'font.woff2'), new Uint8Array([9,8,7]))
	await symlink(external, join(root,'node_modules/external-style'))
	await file('host.mjs', `import {serve} from ${JSON.stringify(join(import.meta.dir,'../serve.js'))}; const server=serve('src/app.imba',{port:0,hostname:'127.0.0.1',watchRoot:'src'}); console.log('TEST_SERVER '+server.url);`)
	const child = Bun.spawn([process.execPath,'host.mjs'], {cwd:root,stdout:'pipe',stderr:'inherit'})
	children.push(child)
	const reader = child.stdout.getReader()
	let output = '', origin
	while (!origin) {
		const part = await reader.read()
		if (part.done) throw Error('Resource server exited before readiness')
		output += new TextDecoder().decode(part.value)
		origin = output.match(/TEST_SERVER (http:\/\/\S+)/)?.[1]
	}
	const route = name => '/src/' + encodeURIComponent(name)
	const request = (path, headers) => fetch(new URL(path,origin), {headers})
	async function source(path) {
		const response = await request(path, {'sec-fetch-dest':'script'})
		const code = await response.text()
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('javascript')
		return code
	}
	const load = code => import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
	const data = await load(await source(route('data ?%#.json')))
	expect(data.default).toEqual({value:42,nested:{ok:true}})
	expect(data.value).toBe(42)
	for (const name of ['icon ?%#.svg','font.woff2','document.custom']) {
		const module = await load(await source(route(name)))
		expect(module.default).toBe(route(name))
		const raw = await request(module.default)
		expect(Buffer.from(await raw.arrayBuffer())).toEqual(Buffer.from(await Bun.file(join(root,'src',name)).arrayBuffer()))
	}
	expect((await request(route('data ?%#.json'))).headers.get('content-type')).toContain('application/json')
	const imports = await source('/src/imports.js')
	for (const name of ['data ?%#.json','icon ?%#.svg','document.custom']) expect(imports).toContain('./'+encodeURIComponent(name)+'?import')
	expect((await load(await (await request(route('data ?%#.json')+'?import')).text())).value).toBe(42)

	// Run the generated modules against a DOM; only stylesheet network completion
	// is supplied here. Their href and every referenced native response stay real.
	const window = new Window({url:origin})
	const previous = globalThis.document
	globalThis.document = window.document
	const append = window.document.head.append.bind(window.document.head)
	window.document.head.append = element => { append(element); queueMicrotask(()=>element.onload?.(new window.Event('load'))) }
	try {
		for (const path of ['/src/theme.css','/__bimba_vendor__/fixture-style','/__bimba_vendor__/external-style']) {
			const code = await source(path)
			expect((await load(code)).default).toEqual({})
		}
		const script = await load(await source('/__bimba_vendor__/fixture-script'))
		expect(script.default).toBe(7)
		expect(await (await request(script.icon)).text()).toContain('<svg')
		const links = [...window.document.querySelectorAll('link[rel="stylesheet"]')]
		expect(links).toHaveLength(3)
		for (const link of links) {
			const response = await request(link.href, {'sec-fetch-dest':'style'})
			expect(response.headers.get('content-type')).toContain('text/css')
			const css = await response.text()
			const font = css.match(/url\("(.+?\.woff2)"\)/)[1]
			const binary = await request(new URL(font,link.href).href, {'sec-fetch-dest':'font'})
			expect(binary.headers.get('content-type')).toContain('font')
			expect((await binary.arrayBuffer()).byteLength).toBeGreaterThan(0)
		}
	} finally { globalThis.document = previous; await window.happyDOM.close() }

	const socket = new WebSocket(new URL('/__hmr__',origin).toString().replace('http:','ws:'))
	sockets.push(socket)
	await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
	for (const [name,value] of [['data ?%#.json','{"value":43}'],['document.custom','changed bytes']]) {
		const changed = new Promise((resolve,reject)=>{
			const timer=setTimeout(()=>reject(Error('Resource HMR missing for '+name)),2000)
			const receive=event=>{const message=JSON.parse(event.data);if(message.type!=='reload'||message.file!=='src/'+name)return;clearTimeout(timer);socket.removeEventListener('message',receive);resolve(message)}
			socket.addEventListener('message',receive)
		})
		await file('src/'+name,value)
		expect((await changed).paths).toContain(route(name))
	}
	expect((await load(await source(route('data ?%#.json')))).value).toBe(43)
	expect((await request('/src/missing.svg?import')).status).toBe(404)
}, 10000)
