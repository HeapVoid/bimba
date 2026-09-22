import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const fixtures = []
const servers = []

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.kill()
		await server.exited
	}
	for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true })
})

// Run the actual injected client with native EventTarget and a small DOM model.
// Only module loading is substituted; updates arrive through its WebSocket handler.
async function client() {
	const source = await Bun.file(join(import.meta.dir, '../serve.js')).text()
	const template = source.match(/const hmrClient = (`[\s\S]*?`)\n/)[1]
	const html = vm.runInNewContext(template)
	const code = html.replace(/^\s*<script>|<\/script>\s*$/g, '').replace('await import(', 'await loadModule(')
	const elements = []
	const definitions = new Map()
	let socket, load
	let reloads = 0
	class DOMEventTarget extends EventTarget {
		addEventListener(...args) { return super.addEventListener(...args) }
		removeEventListener(...args) { return super.removeEventListener(...args) }
	}
	class Element extends DOMEventTarget {
		constructor() {
			super()
			this.tagName = this.constructor.tagName.toUpperCase()
			this.className = ''
			this.children = []
			this.isConnected = true
		}
		querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]) }
		contains(el) { return this === el || this.querySelectorAll().includes(el) }
		set innerHTML(value) {
			for (const child of this.querySelectorAll()) {
				child.isConnected = false
				child.disconnectedCallback?.()
			}
			this.children = []
		}
		remove() { this.isConnected = false }
	}
	const document = {
		body: { children: elements },
		getElementById: () => null,
		querySelectorAll: selector => elements.flatMap(el => [el, ...el.querySelectorAll()])
			.filter(el => el.isConnected && (selector === '*' || el.tagName.toLowerCase() === selector)),
	}
	const registry = {
		get: name => definitions.get(name),
		define: (name, cls) => { cls.tagName = name; definitions.set(name, cls) },
	}
	vm.runInNewContext(code, {
		EventTarget: DOMEventTarget, Element, HTMLElement: Element, document, customElements: registry,
		WebSocket: class { constructor() { socket = this } },
		location: { host: 'localhost', protocol: 'http:', reload: () => { reloads++ } },
		console: { error() {} }, setTimeout, clearTimeout,
		imba: { commit() {} }, loadModule: () => load(),
	})
	return {
		Element, registry, elements,
		get reloads() { return reloads },
		async update(callback) {
			load = callback
			socket.onmessage({ data: JSON.stringify({ type: 'update', file: 'src/sidebar.imba' }) })
			await new Promise(resolve => setTimeout(resolve, 0))
		},
	}
}

describe('HMR client', () => {
	test('replaces self listeners without repeating mount or removing mount listeners', async () => {
		const env = await client()
		class Sidebar extends env.Element {
			clicks = 0
			mounts = 0
			pings = 0
			mount() { this.mounts++; this.addEventListener('ping', () => this.pings++) }
			render() { this.addEventListener('click', () => this.clicks++) }
		}
		env.registry.define('audit-sidebar', Sidebar)
		const el = new Sidebar()
		env.elements.push(el)
		el.render()
		el.mount()
		el.dispatchEvent(new Event('click'))
		expect(el.clicks).toBe(1)
		for (let i = 0; i < 3; i++) {
			await env.update(() => env.registry.define('audit-sidebar', class extends env.Element {
				render() { this.addEventListener('click', () => this.clicks += 2) }
			}))
			el.dispatchEvent(new Event('click'))
			expect(el.clicks).toBe(3 + i * 2)
		}
		el.dispatchEvent(new Event('ping'))
		expect(el.pings).toBe(1)
		expect(el.mounts).toBe(1)
	})

	test('refreshes instances of a changed base tag', async () => {
		const env = await client()
		class Base extends env.Element { render() { this.text = 'before' } }
		env.registry.define('audit-base', Base)
		class Sidebar extends Base {}
		env.registry.define('audit-sidebar', Sidebar)
		const el = new Sidebar()
		env.elements.push(el)
		el.render()
		await env.update(() => env.registry.define('audit-base', class extends env.Element {
			render() { this.text = 'after' }
		}))
		expect(el.text).toBe('after')
	})

	test('adds and removes css self classes while retaining application classes', async () => {
		const env = await client()
		class Sidebar extends env.Element { render() {} }
		env.registry.define('audit-sidebar', Sidebar)
		const el = new Sidebar()
		el.className = 'active'
		env.elements.push(el)
		await env.update(() => {
			class Styled extends env.Element { render() {} }
			Styled.prototype.flags$ns = 'style-new '
			env.registry.define('audit-sidebar', Styled)
		})
		expect(el.className.split(/\s+/).sort()).toEqual(['active', 'style-new'])
		await env.update(() => env.registry.define('audit-sidebar', class extends env.Element { render() {} }))
		expect(el.className).toBe('active')
		expect(el.flags$ns).toBe('')
	})

	test('lets DOM removal disconnect descendants exactly once', async () => {
		const env = await client()
		class Child extends env.Element {
			unmounts = 0
			disconnectedCallback() { this.unmounts++ }
		}
		env.registry.define('audit-child', Child)
		class Sidebar extends env.Element { render() {} }
		env.registry.define('audit-sidebar', Sidebar)
		const el = new Sidebar()
		const child = new Child()
		el.children.push(child)
		env.elements.push(el)
		await env.update(() => env.registry.define('audit-sidebar', class extends env.Element { render() {} }))
		expect(child.unmounts).toBe(1)
	})

	test('does not render a child again after its changed parent has rebuilt it', async () => {
		const env = await client()
		class Child extends env.Element { render() { this.renders = (this.renders || 0) + 1 } }
		env.registry.define('audit-child', Child)
		class Sidebar extends env.Element {
			render() {
				const child = new Child()
				this.children.push(child)
				child.render()
			}
		}
		env.registry.define('audit-sidebar', Sidebar)
		const el = new Sidebar()
		env.elements.push(el)
		el.render()
		const previous = el.children[0]
		const render = Sidebar.prototype.render
		await env.update(() => {
			env.registry.define('audit-sidebar', class extends env.Element { render() { render.call(this) } })
			env.registry.define('audit-child', class extends env.Element { render() { this.renders = (this.renders || 0) + 1 } })
		})
		expect(env.reloads).toBe(0)
		expect(previous.isConnected).toBe(false)
		expect(el.children).toHaveLength(1)
		expect(el.children[0]).not.toBe(previous)
		expect(el.children[0].renders).toBe(1)
	})

	test('retains replacement body portals created while rendering a component', async () => {
		const env = await client()
		class Popup extends env.Element { static tagName = 'div' }
		const original = new Popup()
		class Sidebar extends env.Element { render() {} }
		env.registry.define('audit-sidebar', Sidebar)
		env.elements.push(new Sidebar(), original)
		let replacement
		await env.update(() => env.registry.define('audit-sidebar', class extends env.Element {
			render() {
				original.remove()
				replacement = new Popup()
				env.elements.push(replacement)
			}
		}))
		expect(original.isConnected).toBe(false)
		expect(replacement.isConnected).toBe(true)
	})

	test('reloads if rendering the update fails', async () => {
		const env = await client()
		class Sidebar extends env.Element { render() {} }
		env.registry.define('audit-sidebar', Sidebar)
		env.elements.push(new Sidebar())
		await env.update(() => env.registry.define('audit-sidebar', class extends env.Element {
			render() { throw new Error('broken render') }
		}))
		expect(env.reloads).toBe(1)
	})
})

async function server() {
	const fixture = await mkdtemp(join(tmpdir(), 'bimba-hmr-'))
	fixtures.push(fixture)
	await mkdir(join(fixture, 'src'))
	await Bun.write(join(fixture, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
	await Bun.write(join(fixture, 'src/app.imba'), "import './sidebar.imba'\n")
	await Bun.write(join(fixture, 'src/sidebar.imba'), "tag audit-sidebar\n\t<self> 'before'\n")
	const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
	const port = probe.port
	probe.stop(true)
	const child = Bun.spawn([process.execPath, join(import.meta.dir, '../index.js'), 'src/app.imba', '--serve', '--port', String(port)], {
		cwd: fixture, stdout: 'ignore', stderr: 'ignore',
	})
	servers.push(child)
	const url = `http://localhost:${port}`
	for (let i = 0; ; i++) {
		try { if ((await fetch(url)).ok) break } catch (_) {}
		if (i > 80) throw new Error('Server did not start')
		await Bun.sleep(25)
	}
	const messages = []
	const socket = new WebSocket(`ws://localhost:${port}/__hmr__`)
	socket.addEventListener('message', event => messages.push(JSON.parse(event.data)))
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true })
		socket.addEventListener('error', reject, { once: true })
	})
	return { fixture, url, messages, socket }
}

describe('HMR watcher', () => {
	test.each(['sidebar.imba', 'app.imba'])('updates only CSS in %s, including the first and last rule', async name => {
		const env = await server()
		try {
			const source = "tag audit-sidebar\n\t<self> 'before'\n"
			const file = join(env.fixture, 'src', name)
			await Bun.write(file, source)
			await fetch(env.url + '/src/' + name)
			await Bun.sleep(400)
			env.messages.length = 0
			for (const color of ['red5', 'blue5', null]) {
				await Bun.write(file, color ? source.replace('\t<self>', `\tcss self bg:${color}\n\t<self>`) : source)
				// HTTP compilation must not consume the pending CSS update.
				await fetch(env.url + '/src/' + name)
				await Bun.sleep(350)
				const css = env.messages.filter(msg => msg.type === 'css')
				expect(css).toHaveLength(color === 'red5' ? 1 : color === 'blue5' ? 2 : 3)
				expect(css.at(-1).styleId).toBeTruthy()
				expect(css.at(-1).css).not.toContain('/*#*/')
				if (color === null) expect(css.at(-1).css).not.toContain('background:')
			}
			expect(env.messages.filter(msg => msg.type === 'update' || msg.type === 'reload')).toHaveLength(0)
		} finally { env.socket.close() }
	})

	test('updates global Imba styles without importing a component module', async () => {
		const env = await server()
		try {
			const file = join(env.fixture, 'src/global.imba')
			await Bun.write(file, 'css body bg:red5\n')
			await fetch(env.url + '/src/global.imba')
			await Bun.sleep(300)
			env.messages.length = 0
			await Bun.write(file, 'css body bg:blue5\n')
			await Bun.sleep(350)
			expect(env.messages.filter(msg => msg.type === 'css')).toHaveLength(1)
			expect(env.messages.filter(msg => msg.type === 'update' || msg.type === 'reload')).toHaveLength(0)
		} finally { env.socket.close() }
	})

	test('updates imported CSS files through their served URL', async () => {
		const env = await server()
		try {
			const file = join(env.fixture, 'src/theme.css')
			await Bun.write(file, 'body { background: red; }')
			await fetch(env.url + '/src/theme.css')
			await Bun.sleep(300)
			env.messages.length = 0
			await Bun.write(file, 'body { background: blue; }')
			await fetch(env.url + '/src/theme.css')
			await Bun.sleep(350)
			expect(env.messages.filter(msg => msg.type === 'css')).toEqual([
				{ type: 'css', file: 'src/theme.css', paths: ['/src/theme.css'], css: 'body { background: blue; }' },
			])
			expect(env.messages.filter(msg => msg.type === 'reload')).toHaveLength(0)
		} finally { env.socket.close() }
	})

	test('serves a valid HMR client and resettable named-element caches', async () => {
		const env = await server()
		try {
			const html = await (await fetch(env.url)).text()
			const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
			const client = scripts.find(script => script.includes('const _classes'))
			expect(client).toBeDefined()
			expect(() => new vm.Script(client)).not.toThrow()
			await Bun.write(join(env.fixture, 'src/sidebar.imba'), "tag audit-sidebar\n\t<self>\n\t\t<button$action> 'Action'\n")
			const js = await (await fetch(env.url + '/src/sidebar.imba')).text()
			expect(js).toContain("Object.defineProperty(this,'$action',{value:el,configurable:true})")
		} finally { env.socket.close() }
	})

	test('sends an update even when an HTTP request compiled the saved file first', async () => {
		const env = await server()
		try {
			await fetch(env.url + '/src/sidebar.imba')
			await Bun.write(join(env.fixture, 'src/sidebar.imba'), "tag audit-sidebar\n\t<self> 'after'\n")
			expect(await (await fetch(env.url + '/src/sidebar.imba')).text()).toContain('after')
			await Bun.sleep(600)
			expect(env.messages.filter(msg => msg.type === 'update')).toHaveLength(1)
			// Saving identical contents or reading the module again must not replay it.
			await Bun.write(join(env.fixture, 'src/sidebar.imba'), "tag audit-sidebar\n\t<self> 'after'\n")
			await fetch(env.url + '/src/sidebar.imba')
			await Bun.sleep(400)
			expect(env.messages.filter(msg => msg.type === 'update')).toHaveLength(1)
		} finally { env.socket.close() }
	})

	test('reloads the entrypoint instead of running its mounts twice', async () => {
		const env = await server()
		try {
			await fetch(env.url + '/src/app.imba')
			await Bun.write(join(env.fixture, 'src/app.imba'), "import './sidebar.imba'\nconsole.log 'new entry'\n")
			await Bun.sleep(600)
			expect(env.messages.filter(msg => msg.type === 'reload')).toHaveLength(1)
			expect(env.messages.filter(msg => msg.type === 'update')).toHaveLength(0)
		} finally { env.socket.close() }
	})
})
