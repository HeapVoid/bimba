import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Window } from 'happy-dom'
import { ImbaPlugin } from '../compile-cache.js'
import { IMBA_RUNTIME_DEFINES } from '../utils.js'

const directories = [], windows = []
afterEach(async () => {
	for (const window of windows.splice(0)) await window.happyDOM.close()
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(sources) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimba-tags-'))
	directories.push(root)
	fs.mkdirSync(path.join(root, 'src'))
	fs.symlinkSync(path.resolve(import.meta.dir, '../node_modules'), path.join(root, 'node_modules'), 'dir')
	for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, 'src', name), source)
	return root
}

async function build(root, { tags = true, splitting = false, entries = ['lazy.imba'], plugins = [], tagOptions, compilerOptions, buildOptions = {}, plugin: supplied } = {}) {
	const plugin = supplied || new ImbaPlugin(compilerOptions, tags ? { tags: tagOptions || { roots: [path.join(root, 'src')], entries: entries.map(file => path.join(root, 'src', file)) } } : {})
	let result
	try { result = await Bun.build({
		entrypoints: [path.join(root, 'src/entry.js')], target: 'browser',
		format: splitting ? 'esm' : 'iife', splitting, define: IMBA_RUNTIME_DEFINES, plugins: [plugin, ...plugins], ...buildOptions,
	}) } catch (error) { result = { success: false, logs: error.errors || [error] } }
	return { result, plugin }
}

function execute(js) {
	const window = new Window({ url: 'http://localhost', console })
	windows.push(window)
	for (const key of Object.getOwnPropertyNames(window)) if (window[key] === undefined && key in globalThis) window[key] = globalThis[key]
	vm.runInContext('Array = [].constructor; Object = ({}).constructor; Function = (function(){}).constructor;', window)
	vm.runInContext(js, window)
	return window
}

const entry = "import './lazy.imba'; import {mount,createComponent} from 'imba'; const page = createComponent('lazy-page',null,'',null); mount(page); page.commit();"
const sources = {
	'entry.js': entry,
	'lazy.imba': "tag lazy-page < base-panel\n\t<self>\n\t\t<span> label\n\t\t<status-badge>\n",
	'base.imba': "tag base-panel\n\tget label do 'Inherited base'\n\t<self>\n",
	'badge.imba': "tag status-badge\n\t<self>\n\t\t<span> 'Nested component'\n\t\t<badge-icon>\n",
	'icon.imba': "tag badge-icon\n\t<self> 'Transitive dependency'\n",
}

test('automatic tag dependencies repair demonstrated missing inheritance and nested component ownership', async () => {
	const root = fixture(sources)
	const baseline = await build(root, { tags: false })
	expect(baseline.result.success).toBe(true)
	const baselineJS = await baseline.result.outputs[0].text()
	expect(() => execute(baselineJS)).toThrow()
	const { result, plugin } = await build(root)
	expect(result.success).toBe(true)
	const window = execute(await result.outputs[0].text())
	expect(window.document.body.textContent).toContain('Inherited base')
	expect(window.document.body.textContent).toContain('Nested component')
	expect(window.document.body.textContent).toContain('Transitive dependency')
	expect(plugin.tags.dependencies.map(({ tag, kind }) => ({ tag, kind }))).toEqual([
		{ tag: 'base-panel', kind: 'inheritance' }, { tag: 'status-badge', kind: 'component' },
		{ tag: 'badge-icon', kind: 'component' },
	])
})

test('shell references preserve a lazy boundary and unrelated tags are never compiled or emitted', async () => {
	const root = fixture({ ...sources,
		'entry.js': "import {createComponent} from 'imba'; globalThis.openPage = () => import('./lazy.imba'); globalThis.makePage = () => createComponent('lazy-page',null,'',null);",
		'unrelated.imba': "tag unrelated-page\n\t<self> 'Unrelated payload'\n",
	})
	const { result } = await build(root, { splitting: true })
	expect(result.success).toBe(true)
	const initial = result.outputs.find(output => output.kind === 'entry-point')
	expect(await initial.text()).not.toContain('Inherited base')
	const all = (await Promise.all(result.outputs.map(output => output.text()))).join('\n')
	expect(all.includes('Inherited base')).toBe(true)
	expect(all.includes('Unrelated payload')).toBe(false)
})

test('compiler tokens distinguish declarations from comments, strings and extensions', async () => {
	const root = fixture({ ...sources,
		'noise.imba': "# tag status-badge\nconst text = 'tag status-badge'\nextend tag status-badge\n\tget extra do true\n",
	})
	expect((await build(root)).result.success).toBe(true)
})

test('missing and ambiguous tag owners fail the build with the consumer and tag', async () => {
	for (const ambiguous of [false, true]) {
		const root = fixture({ ...sources,
			...(ambiguous ? { 'duplicate.imba': sources['badge.imba'] } : { 'badge.imba': 'export const unrelated = true\n' }),
		})
		const { result } = await build(root)
		expect(result.success).toBe(false)
		expect(result.logs.map(log => log.message).join('\n')).toMatch(new RegExp(`${ambiguous ? 'Ambiguous' : 'Missing'} tag dependency status-badge`))
	}
})

test('inheritance cycles fail while mutually referenced render components keep live ESM bindings', async () => {
	const cyclic = fixture({
		'entry.js': "import './lazy.imba';",
		'lazy.imba': "tag lazy-page < other-page\n\t<self>\n",
		'other.imba': "tag other-page < lazy-page\n\t<self>\n",
	})
	const failed = await build(cyclic)
	expect(failed.result.success).toBe(false)
	expect(failed.result.logs.map(log => log.message).join('\n')).toContain('Circular tag inheritance')
	const render = fixture({
		'entry.js': entry,
		'lazy.imba': "tag lazy-page\n\tdepth = 2\n\t<self>\n\t\t<span> 'Render cycle is safe'\n\t\t<other-page depth=(depth - 1)> if depth > 0\n",
		'other.imba': "tag other-page\n\tdepth = 2\n\t<self>\n\t\t<lazy-page depth=(depth - 1)> if depth > 0\n",
	})
	const accepted = await build(render)
	expect(accepted.result.success).toBe(true)
	const window = execute(await accepted.result.outputs[0].text())
	expect(window.document.body.textContent).toContain('Render cycle is safe')
	expect(window.document.querySelectorAll('lazy-page').length).toBe(2)
	expect(window.document.querySelectorAll('other-page').length).toBe(1)
})

test('a new build discovers a changed tag owner instead of reusing a stale dependency closure', async () => {
	const root = fixture(sources)
	expect((await build(root)).result.success).toBe(true)
	fs.writeFileSync(path.join(root, 'src/badge.imba'), 'export const old = true\n')
	fs.writeFileSync(path.join(root, 'src/moved.imba'), sources['badge.imba'].replace('Nested component', 'Moved component'))
	const { result, plugin } = await build(root)
	expect(result.success).toBe(true)
	expect(execute(await result.outputs[0].text()).document.body.textContent).toContain('Moved component')
	expect(plugin.tags.dependencies.find(use => use.tag === 'status-badge').to).toEndWith('moved.imba')
})

test('mixed render and inheritance module cycles reject an unsafe superclass order', async () => {
	const root = fixture({
		'entry.js': entry,
		'lazy.imba': "tag lazy-page\n\tshow = false\n\t<self>\n\t\t<child-page> if show\n",
		'child.imba': "tag child-page < lazy-page\n\t<self>\n",
	})
	const { result } = await build(root)
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('Circular tag inheritance')
})

test('an edit between dependency discovery and onLoad rejects the stale build snapshot', async () => {
	const root = fixture(sources)
	const { result } = await build(root, { plugins: [{ name: 'concurrent-save', setup() {
		fs.writeFileSync(path.join(root, 'src/badge.imba'), sources['badge.imba'].replace('Nested component', 'New content'))
	} }] })
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('source changed during automatic tag dependency discovery')
	const retry = await build(root)
	expect(retry.result.success).toBe(true)
	expect(execute(await retry.result.outputs[0].text()).document.body.textContent).toContain('New content')
})

test('literal import() boundaries in Imba discover lazy entries without a duplicated page list', async () => {
	const root = fixture({ ...sources,
		'entry.js': "import {open} from './shell.imba'; globalThis.openPage = open;",
		'shell.imba': "export def open do import('./lazy.imba')\ntag shell-app\n\tshow = false\n\t<self>\n\t\t<lazy-page> if show\n",
	})
	const {result, plugin} = await build(root, {entries:[], splitting:true})
	expect(result.success).toBe(true)
	expect(plugin.tags.dependencies.map(use => use.tag)).toEqual(['base-panel', 'status-badge', 'badge-icon'])
	expect(await result.outputs.find(file => file.kind === 'entry-point').text()).not.toContain('Inherited base')
})

test('two lazy pages share one transitive component and superclass in a split build', async () => {
	const root = fixture({ ...sources,
		'entry.js': "import {first,second} from './shell.imba'; globalThis.pages = [first,second];",
		'shell.imba': "export def first do import('./lazy.imba')\nexport def second do import('./second.imba')\n",
		'second.imba': "tag second-page < base-panel\n\t<self>\n\t\t<status-badge>\n",
	})
	const {result, plugin} = await build(root, {entries:[], splitting:true})
	expect(result.success).toBe(true)
	const all = (await Promise.all(result.outputs.map(file => file.text()))).join('\n')
	expect(all.split('Nested component').length - 1).toBe(1)
	expect(all.split('Transitive dependency').length - 1).toBe(1)
	expect(all.split('Inherited base').length - 1).toBe(1)
	expect(plugin.tags.dependencies.filter(use => use.tag === 'status-badge').length).toBe(2)
})

test('explicit static Imba imports retain normal evaluation and auto-link their own dependencies', async () => {
	const root = fixture({...sources, 'lazy.imba': "import './base.imba'\nimport './badge.imba'\n" + sources['lazy.imba']})
	const {result} = await build(root)
	expect(result.success).toBe(true)
	expect(execute(await result.outputs[0].text()).document.body.textContent).toContain('Transitive dependency')
})

test('native HTML and SVG elements need no tag owner', async () => {
	const root = fixture({'entry.js':entry, 'lazy.imba':"tag lazy-page\n\t<self>\n\t\t<button> 'Native button'\n\t\t<svg>\n\t\t\t<path d='M0 0'>\n"})
	const {result, plugin} = await build(root)
	expect(result.success).toBe(true)
	const window = execute(await result.outputs[0].text())
	expect(window.document.querySelector('button').textContent).toBe('Native button')
	expect(window.document.querySelector('path').namespaceURI).toBe('http://www.w3.org/2000/svg')
	expect(plugin.tags.dependencies).toEqual([])
})

test('duplicate declarations in one file cannot evade unique tag ownership', async () => {
	const root = fixture({...sources, 'badge.imba':sources['badge.imba'] + "\ntag status-badge\n\t<self> 'Duplicate'\n"})
	const {result} = await build(root)
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toMatch(/Duplicate|already been declared/)
})

test('colocated inheritance requires a preceding base and rejects self-inheritance', async () => {
	for (const kind of ['before', 'after', 'self']) {
		const base = "tag base-panel\n\tget label do 'Local base'\n\t<self>\n"
		const child = "tag lazy-page < " + (kind === 'self' ? 'lazy-page' : 'base-panel') + "\n\t<self> label\n"
		const root = fixture({'entry.js':entry, 'lazy.imba':kind === 'before' ? base + child : child + (kind === 'after' ? base : '')})
		const {result} = await build(root)
		expect(result.success).toBe(kind === 'before')
		if (kind === 'before') expect(execute(await result.outputs[0].text()).document.body.textContent).toContain('Local base')
		else expect(result.logs.map(log => log.message).join('\n')).toMatch(/declared before|Circular tag inheritance/)
	}
})

test('conditional tag registration fails instead of exporting an unavailable class', async () => {
	const root = fixture({'entry.js':entry, 'lazy.imba':"if true\n\ttag lazy-page\n\t\t<self> 'Conditional'\n"})
	const {result} = await build(root)
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('top-level tag: lazy-page')
})

test('computed imports require an explicit selection rather than silently missing lazy modules', async () => {
	const root = fixture({...sources, 'entry.js':"import {open} from './shell.imba'; globalThis.openPage = open;",
		'shell.imba':"export def open file do import(file)\n"})
	const {result} = await build(root, {entries:[]})
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('computed import() requires explicit tag dependency entries')
	expect((await build(root)).result.success).toBe(true)
})

test('source inventory and uncompiled tag declarations remain stable through completion', async () => {
	for (const added of [true, false]) {
		const root = fixture({...sources, 'noise.imba':"tag unused-panel\n\t<self>\n"})
		const {result} = await build(root, {plugins:[{name:'concurrent-index-save', setup() {
			fs.writeFileSync(path.join(root, 'src', added ? 'new.imba' : 'noise.imba'), "tag status-badge\n\t<self>\n")
		}}]})
		expect(result.success).toBe(false)
		expect(result.logs.map(log => log.message).join('\n')).toMatch(/inventory changed|source changed/)
	}
})

test('one reused plugin refreshes its index after a tag moves between builds', async () => {
	const root = fixture(sources)
	const plugin = new ImbaPlugin(undefined, {tags:{roots:[path.join(root,'src')], entries:[path.join(root,'src/lazy.imba')]}})
	expect((await build(root, {plugin})).result.success).toBe(true)
	fs.renameSync(path.join(root,'src/badge.imba'),path.join(root,'src/moved.imba'))
	const {result} = await build(root, {plugin})
	expect(result.success).toBe(true)
	expect(plugin.tags.dependencies.find(use => use.tag === 'status-badge').to).toEndWith('moved.imba')
})

test('source maps and unsupported compiler modes are rejected explicitly', async () => {
	const root = fixture(sources)
	for (const options of [
		{compilerOptions:{platform:'node'}}, {buildOptions:{target:'node'}}, {compilerOptions:{platform:'browser', hmr:true}},
		{compilerOptions:{platform:'browser', sourcemap:'external'}}, {buildOptions:{sourcemap:'external'}},
	]) {
		const {result} = await build(root, options)
		expect(result.success).toBe(false)
		expect(result.logs.map(log => log.message).join('\n')).toMatch(/browser build|HMR or source maps/)
	}
})

test('an explicit Imba import can close an unsafe superclass module cycle', async () => {
	const root = fixture({...sources,
		'base.imba':"import './bridge.imba'\n" + sources['base.imba'],
		'bridge.imba':"import './lazy.imba'\n",
	})
	const {result} = await build(root)
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('Circular tag inheritance')
})

test('external tags retain an explicit loading contract and do not generate guessed imports', async () => {
	const root = fixture({...sources,
		'lazy.imba':"import './base.imba'\nimport './badge.imba'\n" + sources['lazy.imba'],
		'badge.imba':"import './icon.imba'\n" + sources['badge.imba'],
	})
	const {result, plugin} = await build(root, {tagOptions:{roots:[path.join(root,'src/lazy.imba')],
		entries:[path.join(root,'src/lazy.imba')], external:['base-panel','status-badge','badge-icon']}})
	expect(result.success).toBe(true)
	expect(plugin.tags.dependencies).toEqual([])
	expect(execute(await result.outputs[0].text()).document.body.textContent).toContain('Transitive dependency')
})

test('generated dependency bindings cannot shadow existing consumer identifiers', async () => {
	const binding = '__bimba_tag_' + Buffer.from('status-badge').toString('hex') + '_dependency'
	const root = fixture({...sources,
		'lazy.imba':`const ${binding} = 'User binding preserved'\n` + sources['lazy.imba'].replace('<span> label', `<span> ${binding}`),
	})
	const {result} = await build(root)
	expect(result.success).toBe(true)
	const text = execute(await result.outputs[0].text()).document.body.textContent
	expect(text).toContain('User binding preserved')
	expect(text).toContain('Nested component')
})

test('invalid tag inventories reject the build with a configuration error', async () => {
	const root = fixture(sources)
	for (const options of [{roots:[]}, {roots:'src'}, {roots:[path.join(root,'src')], entries:'lazy.imba'},
		{roots:[path.join(root,'src')], external:[null]}]) {
		const {result} = await build(root, {tagOptions:options})
		expect(result.success).toBe(false)
		expect(result.logs.map(log => log.message).join('\n')).toContain('array of nonempty strings')
	}
})

test('overlapping and symlinked inventory roots still identify one physical tag owner', async () => {
	const root = fixture(sources)
	fs.symlinkSync(path.join(root,'src'),path.join(root,'alias'),'dir')
	const {result} = await build(root, {tagOptions:{roots:[path.join(root,'src'),path.join(root,'alias'),path.join(root,'src/badge.imba')], entries:[path.join(root,'src/lazy.imba')]}})
	expect(result.success).toBe(true)
	expect(execute(await result.outputs[0].text()).document.body.textContent).toContain('Nested component')
})

test('customized native element inheritance retains its builtin constructor', async () => {
	const root = fixture({'entry.js':entry, 'lazy.imba':"tag lazy-page < button\n\t<self> 'Native superclass'\n"})
	const {result, plugin} = await build(root)
	expect(result.success).toBe(true)
	expect(plugin.tags.dependencies).toEqual([])
	const window = execute(await result.outputs[0].text())
	expect(window.document.body.textContent).toContain('Native superclass')
	expect(window.document.body.firstElementChild instanceof window.HTMLButtonElement).toBe(true)
})

test('runtime-computed tag names reject an incomplete implicit dependency', async () => {
	const root = fixture({...sources, 'lazy.imba':"const widget = 'status-badge'\ntag lazy-page\n\t<self>\n\t\t<{widget}>\n"})
	const {result} = await build(root)
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('Runtime-computed tag reference')
})

test('directly imported PascalCase constructors keep their explicit module ownership', async () => {
	for (const namespaced of [false, true]) {
		const root = fixture({'entry.js':entry,
			'lazy.imba':(namespaced ? "import * as components from './counter.imba'\n" : "import {Counter} from './counter.imba'\n") +
				"tag lazy-page\n\t<self>\n\t\t<{" + (namespaced ? 'components.Counter' : 'Counter') + "}>\n",
			'counter.imba':"export tag Counter\n\t<self> 'Explicit constructor'\n",
		})
		const {result} = await build(root)
		expect(result.success).toBe(true)
		expect(execute(await result.outputs[0].text()).document.body.textContent).toContain('Explicit constructor')
	}
})

test('literal dynamic templates resolve their tag through the compiler render context', async () => {
	const root = fixture({...sources, 'lazy.imba':"tag lazy-page\n\t<self>\n\t\t<{'status-badge'}>\n"})
	const {result} = await build(root)
	expect(result.success).toBe(true)
	expect(execute(await result.outputs[0].text()).document.body.textContent).toContain('Transitive dependency')
})

test('explicit constructor inheritance can complete an unsafe inferred module cycle', async () => {
	const root = fixture({'entry.js':"import './counter.imba';",
		'lazy.imba':"import {Counter} from './counter.imba'\ntag lazy-page < Counter\n\t<self>\n",
		'counter.imba':"export tag Counter\n\tshow = false\n\t<self>\n\t\t<lazy-page> if show\n",
	})
	const {result} = await build(root,{entries:['counter.imba']})
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('Circular tag inheritance')
})

const deferredDialog = {
	'entry.js':"import {catalogue} from './shell.imba'; globalThis.catalogue = catalogue;",
	'shell.imba':"export def catalogue do import('./lazy.imba')\nexport def dialog do import('./popup.imba')\n",
	'lazy.imba':"import {dialog} from './shell.imba'\nexport def openDialog\n\tconst loaded = await dialog!\n\timba.mount <popup-dialog> if loaded\ntag lazy-page\n\t<self> 'Catalogue only'\n",
	'popup.imba':"tag popup-dialog\n\t<self> 'Heavy action dialog'\n",
}

test('implicit references cannot silently pull an independently lazy dialog into its catalogue', async () => {
	const root = fixture(deferredDialog)
	const {result} = await build(root,{entries:[],splitting:true})
	expect(result.success).toBe(false)
	expect(result.logs.map(log => log.message).join('\n')).toContain('crosses declared import() boundary')
})

test('loader-supplied tags preserve a dialog boundary while an explicit static import can cross it', async () => {
	for (const eager of [false,true]) {
		const root = fixture({...deferredDialog,'lazy.imba':(eager ? "import './popup.imba'\n" : '') + deferredDialog['lazy.imba']})
		const {result} = await build(root,{tagOptions:{roots:[path.join(root,'src')],external:eager ? [] : ['popup-dialog']}})
		expect(result.success).toBe(true)
		const window = execute(await result.outputs[0].text())
		expect(window.customElements.get('popup-dialog')).toBeUndefined()
		const catalogue = await window.catalogue()
		expect(!!window.customElements.get('popup-dialog')).toBe(eager)
		await catalogue.openDialog()
		expect(window.document.body.textContent).toContain('Heavy action dialog')
	}
})
