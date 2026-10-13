import { parse } from 'acorn'

// Shared syntax operations for transformations of compiler-generated JavaScript.
export function syntax(js) {
	const comments = []
	const ast = parse(js, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments })
	return { ast, comments }
}

export function visit(node, callback, ancestors = []) {
	if (!node || typeof node.type !== 'string') return
	if (callback(node, ancestors) === false) return
	const parents = [...ancestors, node]
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const child of value) visit(child, callback, parents)
		} else if (value && typeof value === 'object') visit(value, callback, parents)
	}
}

export function replace(js, edits) {
	for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
		js = js.slice(0, start) + text + js.slice(end)
	}
	return js
}

export function keyName(node) {
	return node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : null
}
