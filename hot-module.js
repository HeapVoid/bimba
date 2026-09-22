import { parse } from 'acorn'
import { compile } from 'imba/compiler'
import path from 'node:path'

const normalizer = new Bun.Transpiler({
	loader: 'js', target: 'browser', trimUnusedImports: false, inline: false,
})
const generatedSymbol = /^(?:ε[\p{ID_Continue}$]*|[\p{ID_Start}_$][\p{ID_Continue}$]*φ\d*|c\$\d+|\$\d+)$/u

function syntax(js) {
	const comments = []
	const ast = parse(js, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments })
	return { ast, comments }
}

function visit(node, callback, ancestors = []) {
	if (!node || typeof node.type !== 'string') return
	if (callback(node, ancestors) === false) return
	const parents = [...ancestors, node]
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const child of value) visit(child, callback, parents)
		} else if (value && typeof value === 'object') visit(value, callback, parents)
	}
}

function replace(js, edits) {
	for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
		js = js.slice(0, start) + text + js.slice(end)
	}
	return js
}

function keyName(node) {
	return node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : null
}

// Imba's generated getter caches its element as a non-configurable own field.
// Only that getter's exact cache operation is made removable during HMR.
function isNamedCache(node, ancestors) {
	if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false
	const { object, property, computed } = node.callee
	if (computed || object.type !== 'Identifier' || object.name !== 'Object' || property.name !== 'defineProperty') return false
	const [target, name, descriptor] = node.arguments
	if (node.arguments.length !== 3 || target.type !== 'ThisExpression' || name.type !== 'Literal' || typeof name.value !== 'string' || !name.value.startsWith('$')) return false
	if (descriptor.type !== 'ObjectExpression' || descriptor.properties.length !== 1) return false
	const field = descriptor.properties[0]
	if (field.type !== 'Property' || field.computed || keyName(field.key) !== 'value' || field.value.type !== 'Identifier' || field.value.name !== 'el') return false
	const getter = ancestors.findLast(parent => parent.type === 'MethodDefinition')
	if (!getter || getter.kind !== 'get' || getter.computed || keyName(getter.key) !== name.value) return false
	return getter.value.body.body.some(statement => statement.type === 'VariableDeclaration' && statement.declarations.some(declaration =>
		declaration.id.type === 'Identifier' && declaration.id.name === 'el' && declaration.init?.type === 'CallExpression' &&
		declaration.init.callee.type === 'Identifier' && /^imba_create(?:Component|Element|SVGElement)$/.test(declaration.init.callee.name)))
}

export function prepareHotModule(js, filepath) {
	const { ast, comments } = syntax(js)
	const body = comments.find(comment => comment.type === 'Block' && comment.value === 'body')?.start ?? -1
	const edits = []
	let slotCount = 0
	for (const statement of ast.body) {
		if (statement.type !== 'VariableDeclaration') continue
		for (const declaration of statement.declarations) {
			const { id, init } = declaration
			if (id.type !== 'Identifier' || !init || init.type !== 'CallExpression' || init.callee.type !== 'Identifier' || init.callee.name !== 'Symbol' || init.arguments.length) continue
			if (declaration.start >= body && !generatedSymbol.test(id.name)) continue
			edits.push({ start: init.start, end: init.end, text: `(__bsyms__[${JSON.stringify(id.name)}] ||= Symbol())` })
			slotCount++
		}
	}
	visit(ast, (node, ancestors) => {
		if (isNamedCache(node, ancestors)) {
			const descriptor = node.arguments[2]
			const offset = descriptor.properties[0].end
			edits.push({ start: offset, end: offset, text: ',configurable:true' })
		}
	})
	const output = replace(js, edits)
	if (!slotCount) return { js: output, slotCount }
	const fileKey = JSON.stringify(path.resolve(filepath))
	return {
		js: `const __bsyms__ = ((globalThis.__bimba_syms ||= {})[${fileKey}] ||= {});\n` + output,
		slotCount,
	}
}

function moduleContext(js, ast) {
	const definitions = new Set()
	for (const statement of ast.body) {
		if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'imba') continue
		for (const specifier of statement.specifiers) {
			if (specifier.type === 'ImportSpecifier' && keyName(specifier.imported) === 'defineTag') definitions.add(specifier.local.name)
		}
	}
	const edits = []
	visit(ast, node => {
		if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return
		const tag = node.body.body.some(member => member.type === 'StaticBlock' && member.body.some(statement => {
			const call = statement.type === 'ExpressionStatement' && statement.expression
			return call?.type === 'CallExpression' && call.callee.type === 'Identifier' && definitions.has(call.callee.name) && call.arguments[1]?.type === 'ThisExpression'
		}))
		if (tag) {
			// The client patches registered tag methods. Ordinary classes remain in
			// the context, as do static initialization and computed method keys.
			for (const member of node.body.body) {
				if (member.type !== 'MethodDefinition') continue
				const body = member.value.body
				edits.push({ start: body.start, end: body.end, text: '{}' })
			}
		}
		return false
	})
	return normalizer.transformSync(replace(js, edits))
}

export function compileHotModule(source, filepath) {
	const absolute = path.resolve(filepath)
	try {
		const result = compile(source, {
			sourcePath: absolute, platform: 'browser', hmr: true,
			styles: 'extern', resolveColors: true, sourcemap: 'inline',
		})
		// Compile diagnostics are exposed through a prototype getter.
		const errors = result.errors || []
		if (errors.length) return { js: '', css: '', styleId: null, code: '', context: '', slots: null, errors }
		const { ast, comments } = syntax(result.js)
		const code = normalizer.transformSync(result.js)
		const context = moduleContext(result.js, ast)
		const css = result.css || ''
		const styleId = result.sourceId
		const registration = `\nimport {styles as __bimba_styles__} from 'imba';\n__bimba_styles__.register(${JSON.stringify(styleId)},${JSON.stringify(css)});\n`
		const sourceMap = comments.find(comment => comment.type === 'Line' && /^#\s*sourceMappingURL=/.test(comment.value))
		const offset = sourceMap?.start ?? result.js.length
		const initial = result.js.slice(0, offset) + registration + result.js.slice(offset)
		const prepared = prepareHotModule(initial, absolute)
		return { js: prepared.js, css, styleId, code, context, slots: prepared.slotCount, errors }
	} catch (error) {
		return { js: '', css: '', styleId: null, code: '', context: '', slots: null, errors: [error] }
	}
}

export function classifyHotUpdate(previous, next) {
	if (!previous || previous.code !== next.code) return 'full'
	return previous.css === next.css ? 'none' : 'css'
}
