import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import vm from 'node:vm'
import { compileHotModule, classifyHotUpdate } from '../hot-module.js'
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
		.replaceAll('await import(', 'await testImport(')
})
afterEach(async () => {
	for (const window of windows.splice(0)) {
		// Unmount roots normally before Happy DOM destroys its document arrays;
		// an open <global> removes body-level portals from those same arrays.
		while (window.document.body.firstChild) window.document.body.firstChild.remove()
		await window.happyDOM.close()
	}
})

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
	let reloads = 0, moduleLoads = 0
	const modules = new Map()
	window.WebSocket = class { constructor() { socket = this } }
	window.testImport = async specifier => specifier === '/__bimba_vendor__/imba' ? window.testModules.imba : nextModule()
	// Location is platform-owned; count fallback requests in this test realm.
	window.testReload = () => { reloads++ }
	vm.runInContext(clientCode.replaceAll('location.reload()', 'testReload()'), window)
	vm.runInContext(runtime, window)
	function execute(compiled) {
		const js = compiled.js.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/g, (_, names, module) => {
			if (!window.testModules[module]) throw new Error(`Unexpected test import: ${module}`)
			return `const {${names.replace(/\s+as\s+/g, ':')}} = testModules[${JSON.stringify(module)}];`
		})
		vm.runInContext(`(function(){${js}\n})();`, window)
		moduleLoads++
	}
	function load(source, file = 'popup.imba') {
		const compiled = compileHotModule(source, file)
		if (compiled.errors?.length) throw new AggregateError(compiled.errors)
		execute(compiled)
		modules.set(file, compiled)
	}
	return {
		window, document: window.document, load,
		get reloads() { return reloads },
		get moduleLoads() { return moduleLoads },
		async update(source, file = 'popup.imba') {
			const previous = modules.get(file)
			const compiled = compileHotModule(source, file)
			if (compiled.errors?.length) throw new AggregateError(compiled.errors)
			const change = classifyHotUpdate(previous, compiled)
			nextModule = () => execute(compiled)
			if (change !== 'none') socket.onmessage({ data: JSON.stringify(change === 'css'
				? { type: 'css', file, styleId: compiled.styleId, css: compiled.css }
				: { type: 'update', file, contextChanged: previous?.context !== compiled.context }) })
			await new Promise(resolve => setTimeout(resolve, 30))
			modules.set(file, compiled)
			return { change, compiled }
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
	test('CSS edits preserve an open same-module popup, input focus, selection and scroll', async () => {
		const env = client()
		const source = popup + '\n' + select(0)
		env.load(source)
		env.load('imba.mount <test-select>\n', 'entry.imba')
		const root = env.document.querySelector('test-select')
		const menu = root.$menu
		root.query = 'retained search'
		menu.open = true
		root.commit()
		const panel = env.document.querySelector('.panel')
		const search = env.document.querySelector('.search')
		search.focus()
		search.setSelectionRange(2, 7)
		panel.scrollTop = 37
		const moduleLoads = env.moduleLoads
		const variants = [
			source.replace('\t<self>', '\tcss self\n\t\t.panel bg: red5\n\t<self>'),
			source.replace('\t<self>', '\tcss self\n\t\t.panel bg: blue5 p: 12px\n\t<self>'),
			source,
			source.replace('<$panel .panel>', '<$panel .panel [bg: green5]>'),
			source.replace('<$panel .panel>', '<$panel .panel [bg: orange5 p: 8px]>'),
			source,
		]
		for (const changed of variants) {
			const { change, compiled } = await env.update(changed)
			expect(change).toBe('css')
			expect(env.moduleLoads).toBe(moduleLoads)
			expect(env.document.querySelector(`style[data-id="${compiled.styleId}"]`).textContent).toBe(compiled.css)
			expect(env.document.querySelector('test-select')).toBe(root)
			expect(root.$menu).toBe(menu)
			expect(menu.open).toBe(true)
			expect(env.document.querySelector('.panel')).toBe(panel)
			expect(env.document.querySelector('.search')).toBe(search)
			expect(env.document.activeElement).toBe(search)
			expect([search.selectionStart, search.selectionEnd]).toEqual([2, 7])
			expect(search.value).toBe('retained search')
			expect(root.query).toBe('retained search')
			expect(panel.scrollTop).toBe(37)
			expect(env.document.querySelectorAll('.panel')).toHaveLength(1)
			expect(env.document.querySelectorAll('.search')).toHaveLength(1)
			expect(env.document.querySelectorAll('.option')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

	test('editing a popup template preserves its unchanged owner in the same module', async () => {
		const env = client()
		env.load(popup + '\n' + select(0))
		env.load('imba.mount <test-select>\n', 'entry.imba')
		const root = env.document.querySelector('test-select')
		const menu = root.$menu
		root.query = 'retained'
		menu.open = true
		root.commit()
		const search = env.document.querySelector('.search')
		for (let version = 1; version <= 4; version++) {
			await env.update(popup.replace("'Open'", `'Open ${version}'`) + '\n' + select(0))
			root.commit()
			expect(root.$menu).toBe(menu)
			expect(menu.open).toBe(true)
			expect(env.document.querySelector('.search')).toBe(search)
			expect(search.value).toBe('retained')
			expect(env.document.querySelector('.trigger').textContent).toBe(`Open ${version}`)
			expect(env.document.querySelectorAll('.panel')).toHaveLength(1)
			expect(env.document.querySelectorAll('.search')).toHaveLength(1)
			expect(env.document.querySelectorAll('.option')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

	test('ordinary method edits preserve DOM and update the existing event handler', async () => {
		const env = client()
		const source = step => `tag test-button
	count = 0
	def increment
		count += ${step}
	<self>
		<button$action @click=increment> 'Increment'
		<output> count
`
		env.load(source(1))
		env.load('imba.mount <test-button>\n', 'entry.imba')
		const root = env.document.querySelector('test-button')
		const button = root.$action
		const output = env.document.querySelector('output')
		let count = 0
		for (let step = 2; step <= 5; step++) {
			await env.update(source(step))
			expect(root.$action).toBe(button)
			expect(env.document.querySelector('output')).toBe(output)
			button.click()
			root.commit()
			count += step
			expect(root.count).toBe(count)
			expect(output.textContent).toBe(String(count))
			expect(env.document.querySelectorAll('button')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

	test('module-local changes refresh closures captured by cached event handlers', async () => {
		const env = client()
		const source = step => `const step = ${step}
tag test-button
	count = 0
	<self>
		<button$action @click=(count += step)> 'Increment'
		<output> count
`
		env.load(source(1))
		env.load('imba.mount <test-button>\n', 'entry.imba')
		const root = env.document.querySelector('test-button')
		let count = 0
		for (let step = 2; step <= 5; step++) {
			await env.update(source(step))
			root.$action.click()
			root.commit()
			count += step
			expect(root.count).toBe(count)
			expect(env.document.querySelector('output').textContent).toBe(String(count))
			expect(env.document.querySelectorAll('button')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

	test('ordinary helper class edits refresh cached event closures', async () => {
		const env = client()
		const source = step => `class Counter
	def value
		${step}
const counter = new Counter
tag test-button
	count = 0
	<self>
		<button$action @click=(count += counter.value!)> 'Increment'
		<output> count
`
		env.load(source(1))
		env.load('imba.mount <test-button>\n', 'entry.imba')
		const root = env.document.querySelector('test-button')
		let count = 0
		for (let step = 2; step <= 5; step++) {
			await env.update(source(step))
			root.$action.click()
			root.commit()
			count += step
			expect(root.count).toBe(count)
			expect(env.document.querySelector('output').textContent).toBe(String(count))
			expect(env.document.querySelectorAll('button')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

	test('removing a method override restores inherited behavior and preserves runtime additions', async () => {
		const env = client()
		const source = override => `tag base-button
	count = 0
	def increment
		count += 1
	<self>
		<button$action @click=increment> 'Increment'
		<output> count
tag test-button < base-button
${override ? '\tdef increment\n\t\tcount += 10\n' : ''}`
		env.load(source(true))
		env.load('imba.mount <test-button>\n', 'entry.imba')
		const root = env.document.querySelector('test-button')
		const ctor = env.window.customElements.get('test-button')
		const runtime = Symbol('runtime addition')
		ctor.prototype[runtime] = 'preserved prototype'
		ctor[runtime] = 'preserved constructor'
		let count = 0
		for (const override of [false, true, false]) {
			await env.update(source(override))
			root.$action.click()
			root.commit()
			count += override ? 10 : 1
			expect(root.count).toBe(count)
			expect(root[runtime]).toBe('preserved prototype')
			expect(ctor[runtime]).toBe('preserved constructor')
			expect(env.document.querySelector('output').textContent).toBe(String(count))
			expect(env.document.querySelectorAll('button')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

	test('static text changes in named getters invalidate the otherwise unchanged render', async () => {
		const env = client()
		const source = version => `tag test-content
	<self>
		<div$body> 'Version ${version}'
`
		env.load(source(0))
		env.load('imba.mount <test-content>\n', 'entry.imba')
		for (let version = 1; version <= 3; version++) {
			await env.update(source(version))
			expect(env.document.querySelector('test-content').$body.textContent).toBe(`Version ${version}`)
			expect(env.document.querySelectorAll('test-content > div')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

	test('template helper method edits invalidate their render-context caches', async () => {
		const env = client()
		const source = version => `tag test-content
	def content
		<div.copy> 'Version ${version}'
	<self>
		content!
`
		env.load(source(0))
		env.load('imba.mount <test-content>\n', 'entry.imba')
		for (let version = 1; version <= 3; version++) {
			await env.update(source(version))
			expect(env.document.querySelector('.copy').textContent).toBe(`Version ${version}`)
			expect(env.document.querySelectorAll('.copy')).toHaveLength(1)
			expect(env.reloads).toBe(0)
		}
	})

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
			for (const flag of child.flags$ns.trim().split(/\s+/)) expect(child.classList.contains(flag)).toBe(true)
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
