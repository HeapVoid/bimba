import fs from 'node:fs'
import path from 'node:path'
import { syntax, visit, replace, keyName } from './javascript.js'

const references = new Set(['getSuperTagType', 'getTagType', 'createComponent', 'createDynamic'])
const exported = name => '__bimba_tag_' + Buffer.from(name).toString('hex')
const custom = name => typeof name === 'string' && name.includes('-')
const canonical = file => fs.realpathSync(file)

function files(root) {
	if (fs.statSync(root).isFile()) return root.endsWith('.imba') ? [root] : []
	return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
		const file = path.join(root, entry.name)
		return entry.isDirectory() ? files(file) : entry.isFile() && file.endsWith('.imba') ? [file] : []
	})
}

function moduleTags(js) {
	const { ast } = syntax(js), helpers = new Map(), tags = new Map(), uses = [], imports = [], names = new Set(), constructors = new Map(), namespaces = new Set(), contexts = new Map(), superclasses = new Set()
	for (const statement of ast.body) {
		const declaration = statement.declaration || statement
		if (declaration.type === 'ClassDeclaration') constructors.set(declaration.id?.name, null)
		if (statement.type !== 'ImportDeclaration') continue
		imports.push(statement.source.value)
		for (const specifier of statement.specifiers) {
			constructors.set(specifier.local.name, statement.source.value)
			if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name)
		}
		if (statement.source.value !== 'imba') continue
		for (const specifier of statement.specifiers) {
			if (specifier.type === 'ImportSpecifier') helpers.set(specifier.local.name, keyName(specifier.imported))
		}
	}
	visit(ast, (node, ancestors) => {
		if (node.type === 'Identifier') names.add(node.name)
		if (node.type === 'ClassDeclaration') {
			const base = node.superClass
			const source = base?.type === 'Identifier' ? constructors.get(base.name) :
				base?.type === 'MemberExpression' && !base.computed && base.object.type === 'Identifier' && namespaces.has(base.object.name) ? constructors.get(base.object.name) : null
			if (source?.startsWith('.') && source.endsWith('.imba')) superclasses.add(source)
		}
		if (node.type !== 'CallExpression') return
		const scope = ancestors.findLast(parent => /Function/.test(parent.type)) || ast
		if (node.callee.type === 'MemberExpression' && keyName(node.callee.property) === 'run' && node.callee.object.type === 'Identifier') {
			const values = contexts.get(scope) || new Map()
			values.set(node.callee.object.name, node.arguments[0])
			contexts.set(scope, values)
		}
		if (node.callee.type !== 'Identifier') return
		const helper = helpers.get(node.callee.name)
		let argument = node.arguments[0]
		// Dynamic templates store their real input in the compiler's render context.
		if (helper === 'createDynamic' && argument?.type === 'MemberExpression' && keyName(argument.property) === 'value' && argument.object.type === 'Identifier') argument = contexts.get(scope)?.get(argument.object.name) || argument
		const name = argument?.value
		if (helper === 'createComponent' || helper === 'createDynamic') {
			const explicit = argument?.type === 'Identifier' && constructors.has(argument.name) ||
				argument?.type === 'MemberExpression' && !argument.computed && argument.object.type === 'Identifier' && namespaces.has(argument.object.name)
			if (argument?.type !== 'Literal' && !explicit) throw Error('Runtime-computed tag reference requires a literal tag or directly imported constructor')
		}
		if (!custom(name)) return
		if (helper === 'defineTag' && node.arguments[1]?.type === 'ThisExpression') {
			const owner = ancestors.findLast(parent => parent.type === 'ClassDeclaration')
			if (!owner?.id || !ast.body.some(statement => statement === owner || statement.declaration === owner)) throw Error('Automatic tag dependencies require a named top-level tag: ' + name)
			tags.set(name, { binding: owner.id.name, start: owner.start })
		} else if (references.has(helper)) {
			if (helper === 'getSuperTagType' && /^(?:HTML|SVG).*Element$/.test(node.arguments[1]?.value || '')) return
			uses.push({ name, helper, node, owner: ancestors.findLast(parent => parent.type === 'ClassDeclaration')?.id?.name })
		}
	})
	return { tags, uses, imports, names, superclasses }
}

// One build owns the index and dependency closure. Only explicitly selected
// lazy entry modules and their static dependencies are transformed; the shell
// can mention their tag names without turning them into eager imports.
export class TagDependencies {
	constructor({ cwd, roots, entries = [], external = [], compiler, compile }) {
		for (const [name, values] of Object.entries({ roots, entries, external })) {
			if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim()) || name === 'roots' && !values.length) throw Error('Automatic tag dependencies require ' + name + ' to be an array of nonempty strings')
		}
		this.cwd = cwd
		this.roots = roots.map(root => canonical(path.resolve(cwd, root)))
		this.entries = entries.map(file => canonical(path.resolve(cwd, file)))
		this.external = new Set(external)
		this.compiler = compiler
		this.compile = compile
		this.owners = new Map()
		this.modules = new Map()
		this.snapshots = new Map()
		this.lazyEntries = new Set()
	}

	source(file) {
		const value = fs.readFileSync(file, 'utf8')
		if (this.snapshots.has(file) && this.snapshots.get(file) !== value) throw Error(file + ': source changed during automatic tag dependency discovery; rebuild')
		this.snapshots.set(file, value)
		return value
	}

	prepare() {
		this.owners.clear()
		this.modules.clear()
		this.snapshots.clear()
		this.lazyEntries.clear()
		this.inventory = new Set(this.roots.flatMap(files).map(canonical))
		for (const file of this.inventory) {
			const tokens = this.compiler.tokenize(this.source(file), { sourcePath: file })
			let depth = 0
			for (let index = 0; index < tokens.length; index++) {
				const token = tokens[index]
				if (token._type === 'INDENT') depth++
				if (token._type === 'OUTDENT') depth--
				if (depth || token._type !== 'TAG' || tokens[index - 1]?._type === 'EXTEND') continue
				const name = tokens[index + 1]
				if (name?._type !== 'TAG_TYPE' || !custom(name._value)) continue
				const owners = this.owners.get(name._value) || new Set()
				owners.add(file)
				this.owners.set(name._value, owners)
			}
		}
		for (const file of this.entries) this.resolve(file)
		this.inheritance()
	}

	resolve(file) {
		file = canonical(file)
		if (this.modules.has(file)) return
		this.source(file)
		const result = this.compile(file)
		this.source(file)
		if (result.errors?.length) throw Error(file + ': ' + result.errors.map(error => error.message).join('\n'))
		let analysis
		try { analysis = moduleTags(result.js) } catch (error) { throw Error(file + ': ' + error.message) }
		const module = { ...analysis, js: result.js, dependencies: [] }
		this.modules.set(file, module)
		for (const use of module.uses) {
			const local = module.tags.get(use.name)
			if (local) {
				if (use.helper === 'getSuperTagType' && local.binding === use.owner) throw Error(file + ': Circular tag inheritance: ' + use.name)
				if (use.helper === 'getSuperTagType' && local.start >= use.node.start) throw Error(file + ': superclass tag ' + use.name + ' must be declared before its subclass')
				continue
			}
			if (this.external.has(use.name)) continue
			const owners = [...(this.owners.get(use.name) || [])]
			if (owners.length !== 1) throw Error(`${file}: ${owners.length ? 'Ambiguous' : 'Missing'} tag dependency ${use.name}${owners.length ? ': ' + owners.join(', ') : ''}`)
			const owner = owners[0]
			module.dependencies.push({ ...use, file: owner })
			this.resolve(owner)
			if (!this.modules.get(owner).tags.has(use.name)) throw Error(owner + ': tag must register at module evaluation: ' + use.name)
		}
		for (const specifier of module.imports) {
			if (specifier.startsWith('.') && specifier.endsWith('.imba')) this.resolve(path.resolve(path.dirname(file), specifier))
		}
	}

	link(file, js) {
		file = canonical(file)
		const { ast } = syntax(js)
		visit(ast, node => {
			if (node.type !== 'ImportExpression') return
			if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') {
				if (!this.entries.length) throw Error(file + ': computed import() requires explicit tag dependency entries')
				return
			}
			const specifier = node.source.value
			if (!specifier.startsWith('.') || !specifier.endsWith('.imba')) return
			const target = canonical(path.resolve(path.dirname(file), specifier))
			this.lazyEntries.add(target)
			if (!this.entries.length) this.resolve(target)
		})
		if (!this.entries.length) this.inheritance()
		return this.transform(file, js)
	}

	verify() {
		const current = new Set(this.roots.flatMap(files).map(canonical))
		if (current.size !== this.inventory.size || [...current].some(file => !this.inventory.has(file))) throw Error('Source inventory changed during automatic tag dependency discovery; rebuild')
		for (const file of this.snapshots.keys()) this.source(file)
		// Dynamic boundaries may be discovered after a consumer's onLoad. Check
		// the completed graph before exposing artifacts, rather than eagerly
		// pulling a separately loaded dialog into the page that opens it.
		for (const [file, module] of this.modules) {
			const explicit = new Set(module.imports.filter(specifier => specifier.startsWith('.') && specifier.endsWith('.imba'))
				.map(specifier => canonical(path.resolve(path.dirname(file), specifier))))
			for (const use of module.dependencies) {
				if (this.lazyEntries.has(use.file) && !explicit.has(use.file)) throw Error(`${file}: implicit tag dependency ${use.name} crosses declared import() boundary ${use.file}; use an explicit static import or declare the loader-supplied tag in tags.external`)
			}
		}
	}

	inheritance() {
		const edges = file => {
			const module = this.modules.get(file)
			return new Set([...module.dependencies.map(use => use.file), ...module.imports
				.filter(specifier => specifier.startsWith('.') && specifier.endsWith('.imba'))
				.map(specifier => canonical(path.resolve(path.dirname(file), specifier)))])
		}
		const route = (file, target, seen = new Set()) => {
			if (file === target) return [file]
			if (seen.has(file)) return null
			seen.add(file)
			for (const next of edges(file)) {
				const found = route(next, target, seen)
				if (found) return [file, ...found]
			}
			return null
		}
		// A render or explicit-import edge can also close an ESM cycle around a
		// superclass. Its class must exist during evaluation, before any render.
		for (const [file, module] of this.modules) {
			const bases = [...module.dependencies.filter(use => use.helper === 'getSuperTagType').map(use => use.file),
				...[...module.superclasses].map(specifier => canonical(path.resolve(path.dirname(file), specifier)))]
			for (const base of bases) {
				const cycle = route(base, file)
				if (cycle) throw Error('Circular tag inheritance: ' + [file, ...cycle].map(item => path.relative(this.cwd, item)).join(' -> '))
			}
		}
	}

	transform(file, js) {
		const module = this.modules.get(canonical(file))
		if (!module) return js
		this.source(canonical(file))
		if (js !== module.js) throw Error(file + ': source changed during automatic tag dependency discovery; rebuild')
		// Use the current compiler output, including outputs restored from cache.
		const current = module, edits = [], imports = new Map(), bindings = new Map()
		for (const use of current.uses) {
			const dependency = module.dependencies.find(item => item.name === use.name)
			if (!dependency) continue
			let binding = bindings.get(use.name)
			if (!binding) {
				binding = exported(use.name) + '_dependency'
				while (current.names.has(binding)) binding += '_'
				bindings.set(use.name, binding)
				const names = imports.get(dependency.file) || []
				names.push(exported(use.name) + ' as ' + binding)
				imports.set(dependency.file, names)
			}
			const target = use.helper === 'getSuperTagType' || use.helper === 'getTagType' ? use.node : use.node.arguments[0]
			edits.push({ start: target.start, end: target.end, text: binding })
		}
		let prefix = ''
		for (const [owner, names] of imports) {
			let specifier = path.relative(path.dirname(file), owner).replaceAll('\\', '/')
			if (!specifier.startsWith('.')) specifier = './' + specifier
			prefix += `import {${names.join(', ')}} from ${JSON.stringify(specifier)};\n`
		}
		const exports = [...current.tags].map(([name, tag]) => tag.binding + ' as ' + exported(name))
		return prefix + replace(js, edits) + (exports.length ? '\nexport {' + exports.join(', ') + '};\n' : '')
	}

	get dependencies() {
		return [...this.modules].flatMap(([file, module]) => module.dependencies.map(use => ({
			from: path.relative(this.cwd, file), tag: use.name,
			to: path.relative(this.cwd, use.file), kind: use.helper === 'getSuperTagType' ? 'inheritance' : 'component',
		})))
	}
}
