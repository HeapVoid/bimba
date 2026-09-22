import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { compile } from 'imba/compiler'
import vm from 'node:vm'
import { prepareHotModule } from '../serve.js'
import { IMBA_RUNTIME_DEFINES } from '../utils.js'

const windows = []
let runtime, clientCode
beforeAll(async () => {
	const result = await Bun.build({
		entrypoints: ['test:runtime'], target: 'browser', format: 'iife', define: IMBA_RUNTIME_DEFINES,
		plugins: [{ name: 'test-runtime', setup(build) {
			build.onResolve({ filter: /^test:runtime$/ }, () => ({ path: 'runtime', namespace: 'test' }))
			build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
				contents: "import * as imba from 'imba'; import * as runtime from 'imba/runtime'; globalThis.imba = imba; globalThis.testModules = { imba, 'imba/runtime': runtime };",
				loader: 'js', resolveDir: import.meta.dir,
			}))
		} }],
	})
	if (!result.success) throw new AggregateError(result.logs)
	runtime = await result.outputs[0].text()
	const source = await Bun.file(new URL('../serve.js', import.meta.url)).text()
	clientCode = vm.runInNewContext(source.match(/const hmrClient = (`[\s\S]*?`)\n/)[1])
		.replace(/^\s*<script>|<\/script>\s*$/g, '')
		.replace('await import(', 'await testImport(')
})
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close() })

// Only network/module loading is substituted. The compiler, DOM implementation,
// custom elements, Imba slots, named references and lifecycle are real.
function client() {
	const window = new Window({ url: 'http://localhost:5289', console })
	windows.push(window)
	// Bun does not populate VM intrinsics on Happy DOM's Window proxy.
	for (const key of Object.getOwnPropertyNames(window)) {
		if (window[key] === undefined && key in globalThis) window[key] = globalThis[key]
	}
	vm.runInContext('Array = [].constructor; Object = ({}).constructor; Function = (function(){}).constructor;', window)
	let socket, nextModule
	let reloads = 0
	window.WebSocket = class { constructor() { socket = this } }
	window.testImport = async () => nextModule()
	// Location is platform-owned; count fallback requests in this test realm.
	window.testReload = () => { reloads++ }
	vm.runInContext(clientCode.replaceAll('location.reload()', 'testReload()'), window)
	vm.runInContext(runtime, window)
	function load(source, file = 'popup.imba') {
		const compiled = compile(source, { platform: 'browser', sourcePath: file })
		if (compiled.errors?.length) throw new AggregateError(compiled.errors)
		const js = prepareHotModule(compiled.js, file).js.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/g, (_, names, module) => {
			if (!window.testModules[module]) throw new Error(`Unexpected test import: ${module}`)
			return `const {${names.replace(/\s+as\s+/g, ':')}} = testModules[${JSON.stringify(module)}];`
		})
		vm.runInContext(`(function(){${js}\n})();`, window)
	}
	return {
		window, document: window.document, load,
		get reloads() { return reloads },
		async update(source, file) {
			nextModule = () => load(source, file)
			socket.onmessage({ data: JSON.stringify({ type: 'update', file: file || 'popup.imba' }) })
			await new Promise(resolve => setTimeout(resolve, 30))
		},
	}
}

const popup = `tag test-popup
	open = false
	<self>
		<button.trigger @click=(open = !open)> 'Open'
		if open
			<global @keydown.esc=(open = false)>
				<$panel .panel>
					<slot>
`
const select = version => `tag test-select
	query = ''
	<self>
		<test-popup$menu>
			<input.search placeholder='Search ${version}' bind=query>
			<button.option @click=(query = '')> 'All halls ${version}'
${version % 2 ? "\t\t\t<span.extra> 'Extra option'\n" : ''}
`

describe('HMR with the Imba compiler and runtime', () => {
	test.each([false, true])('updates a cached component edited while detached (inherited: %s)', async inherited => {
		const env = client()
		const content = version => `tag test-content
${version % 2 ? '\tcss self color: blue\n' : ''}	<self>
		<div$body>
			<span.content> 'Content ${version}'
`
		const changed = version => inherited ? content(version).replace('tag test-content', 'tag test-base') : content(version)
		env.load(changed(0), 'content.imba')
		if (inherited) env.load('tag test-content < test-base\n', 'subclass.imba')
		env.load(`tag test-owner
	open = true
	<self>
		if open
			<test-content>
`, 'owner.imba')
		env.load('imba.mount <test-owner>\n', 'entry.imba')
		const root = env.document.querySelector('test-owner')
		for (let version = 1; version <= 4; version++) {
			root.open = false
			root.commit()
			expect(env.document.querySelectorAll('test-content')).toHaveLength(0)
			await env.update(changed(version), 'content.imba')
			root.open = true
			root.commit()
			expect(env.reloads).toBe(0)
			expect(env.document.querySelectorAll('.content')).toHaveLength(1)
			expect(env.document.querySelector('.content').textContent).toBe(`Content ${version}`)
			const child = env.document.querySelector('test-content')
			expect(child.className.trim()).toBe((child.flags$ns || '').trim())
		}
	})

	test('keeps caller-owned slot contents when only the popup template changes', async () => {
		const env = client()
		env.load(popup)
		env.load(select(0), 'select.imba')
		env.load('imba.mount <test-select>\n', 'entry.imba')
		const root = env.document.querySelector('test-select')
		root.query = 'retained'
		root.$menu.open = true
		root.commit()
		const search = env.document.querySelector('.search')
		for (let version = 1; version <= 4; version++) {
			await env.update(popup.replace("'Open'", `'Open ${version}'`))
			root.commit()
			expect(env.reloads).toBe(0)
			expect(env.document.querySelectorAll('.panel')).toHaveLength(1)
			expect(env.document.querySelectorAll('.search')).toHaveLength(1)
			expect(env.document.querySelector('.search')).toBe(search)
			expect(search.value).toBe('retained')
			expect(env.document.querySelector('.trigger').textContent).toBe(`Open ${version}`)
		}
		env.window.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }))
		root.commit()
		expect(env.document.querySelectorAll('.panel')).toHaveLength(0)
	})

	test('preserves a direct slot and the parent loop caches on the updated child', async () => {
		const env = client()
		const row = version => `tag test-row
	<self>
		<slot>
		<span.version> 'Version ${version}'
`
		env.load(row(0), 'row.imba')
		env.load(`tag test-list
	items = [{label: 'One'}, {label: 'Two'}]
	<self>
		for item in items
			<test-row>
				<span.slot-copy> item.label
`, 'list.imba')
		env.load('imba.mount <test-list>\n', 'entry.imba')
		const root = env.document.querySelector('test-list')
		const original = [...env.document.querySelectorAll('.slot-copy')]
		const appState = Symbol('application state')
		const firstRow = env.document.querySelector('test-row')
		firstRow[appState] = 'preserved'
		for (let version = 1; version <= 4; version++) {
			await env.update(row(version), 'row.imba')
			root.items[0].label = `One ${version}`
			root.commit()
			expect(env.reloads).toBe(0)
			expect([...env.document.querySelectorAll('.slot-copy')]).toEqual(original)
			expect(original[0].textContent).toBe(`One ${version}`)
			expect(env.document.querySelectorAll('.version')).toHaveLength(2)
			expect(env.document.querySelector('.version').textContent).toBe(`Version ${version}`)
			expect(firstRow[appState]).toBe('preserved')
		}
	})

	test('recreates named native nodes with new markup and one event handler', async () => {
		const env = client()
		const source = version => `tag test-button
	clicks = 0
	<self>
		<button$action @click=(clicks += ${version + 1})> 'Version ${version}'
		<output> clicks
`
		env.load(source(0))
		env.load('imba.mount <test-button>\n', 'entry.imba')
		const root = env.document.querySelector('test-button')
		let clicks = 0
		for (let version = 1; version <= 4; version++) {
			await env.update(source(version))
			root.$action.click()
			root.commit()
			clicks += version + 1
			expect(root.clicks).toBe(clicks)
			expect(env.document.querySelectorAll('button')).toHaveLength(1)
			expect(root.$action.textContent).toBe(`Version ${version}`)
			expect(env.reloads).toBe(0)
		}
	})

	test('repeated edits do not append content to a named popup and its slot', async () => {
		const env = client()
		env.load(popup + '\n' + select(0))
		env.load('imba.mount <test-select>\n', 'entry.imba')
		const root = env.document.querySelector('test-select')
		root.$menu.open = true
		root.commit()
		expect(env.document.querySelectorAll('.search')).toHaveLength(1)
		for (let version = 1; version <= 4; version++) {
			await env.update(popup + '\n' + select(version))
			root.$menu.open = true
			root.commit()
			expect(env.reloads).toBe(0)
			expect(env.document.querySelectorAll('.panel')).toHaveLength(1)
			expect(env.document.querySelectorAll('.search')).toHaveLength(1)
			expect(env.document.querySelector('.search').placeholder).toBe(`Search ${version}`)
			expect(env.document.querySelectorAll('.option')).toHaveLength(1)
			expect(env.document.querySelectorAll('.extra')).toHaveLength(version % 2)
			root.$menu.open = false
			root.commit()
			expect(env.document.querySelectorAll('.panel')).toHaveLength(0)
		}
	})
})
