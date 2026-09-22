import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { classifyHotUpdate, compileHotModule, prepareHotModule } from '../hot-module.js'

const file = 'src/hot-module-test.imba'
const source = (style = '', value = 1) => `tag test-popup
${style ? `\t${style}\n` : ''}\tdef value
\t\t${value}
\t<self>
\t\t<div> 'Contents'
`

function compiled(code = source(), filename = file) {
	const result = compileHotModule(code, filename)
	expect(result.errors).toEqual([])
	return result
}

describe('hot module compilation', () => {
	test('canonicalizes relative and absolute compiler paths', () => {
		const relative = compiled()
		const absolute = compiled(source(), path.resolve(file))
		expect(relative).toEqual(absolute)
		expect(relative.styleId).toBeTruthy()
		expect(relative.js).toContain('sourceMappingURL=data:')
		expect(relative.js.indexOf('__bimba_styles__.register(')).toBeLessThan(relative.js.indexOf('//# sourceMappingURL='))
	})

	test('classifies CSS value changes and first styles added or removed without JS updates', () => {
		const plain = compiled()
		const red = compiled(source('css self bg:red5'))
		const blue = compiled(source('css self bg:blue5'))
		const inline = compiled(source().replace('<div>', '<div [bg:red5]>'))
		expect(classifyHotUpdate(null, plain)).toBe('full')
		expect(classifyHotUpdate(plain, plain)).toBe('none')
		expect(classifyHotUpdate(plain, red)).toBe('css')
		expect(classifyHotUpdate(red, blue)).toBe('css')
		expect(classifyHotUpdate(blue, plain)).toBe('css')
		expect(classifyHotUpdate(plain, inline)).toBe('css')
		expect(red.context).toBe(plain.context)
		expect(red.css).not.toContain('red5')
		expect(red.css).toMatch(/background:\s*(?:#[\da-f]+|(?:rgba?|hsla?|oklch)\()/i)
	})

	test('retains top-level closure changes while separating component method changes', () => {
		const before = compiled(`const label = 'Before'\n${source('', 1)}`)
		const method = compiled(`const label = 'Before'\n${source('', 2)}`)
		const closure = compiled(`const label = 'After'\n${source('', 1)}`)
		expect(classifyHotUpdate(before, method)).toBe('full')
		expect(before.context).toBe(method.context)
		expect(before.context).not.toBe(closure.context)
		expect(compiled(`def helper\n\t1\n${source()}`).context).not.toBe(compiled(`def helper\n\t2\n${source()}`).context)
		expect(before.context).not.toBe(compiled(`const label = 'Before'\n${source()}\nconsole.log 'side effect'\n`).context)
	})

	test('detects class additions, removals and inheritance changes in the module context', () => {
		const plain = compiled()
		const added = compiled(source() + '\ntag other-popup\n\t<self>\n')
		expect(plain.context).not.toBe(added.context)
		const base = compiled('tag test-popup < first-popup\n\t<self>\n')
		const changed = compiled('tag test-popup < second-popup\n\t<self>\n')
		expect(base.context).not.toBe(changed.context)
	})

	test('keeps ordinary service class bodies in the context but recognizes PascalCase tags', () => {
		const service = value => `class Service
\tdef value
\t\t${value}
tag test-popup
\t<self> (new Service).value!
`
		expect(compiled(service(1)).context).not.toBe(compiled(service(2)).context)
		const local = value => `export tag Popup
\tdef value
\t\t${value}
\t<self> value!
`
		expect(compiled(local(1)).context).toBe(compiled(local(2)).context)
	})

	test('keeps tag static initialization in the module context', () => {
		const initial = compiled(source().replace('tag test-popup', 'tag test-popup\n\tstatic value = 1'))
		const changed = compiled(source().replace('tag test-popup', 'tag test-popup\n\tstatic value = 2'))
		expect(initial.context).not.toBe(changed.context)
		expect(initial.context).toContain('this.value = 1')
		expect(initial.context).toContain('imba_defineTag(')
	})

	test('normalizes comments without losing whitespace or escapes in literal values', () => {
		const plain = compiled()
		expect(classifyHotUpdate(plain, compiled('# comment\n' + source()))).toBe('none')
		expect(classifyHotUpdate(compiled(source().replace('Contents', 'A B')), compiled(source().replace('Contents', 'AB')))).toBe('full')
	})

	test('returns compiler diagnostics as own properties', () => {
		const result = compileHotModule('tag test-popup\n\t<self\n', file)
		expect(result.errors.length).toBeGreaterThan(0)
		expect({ ...result }.errors).toBe(result.errors)
	})
})

describe('generated HMR cache rewriting', () => {
	test('stabilizes full Unicode identifiers without rewriting user calls, strings or comments', () => {
		const js = `var εSELF = Symbol(), ε = Symbol(), bjφ = Symbol();
/*body*/
let c$0 = Symbol();
const application = Symbol();
const text = 'ε = Symbol()';
// ε = Symbol()
function allocate() { const ε = Symbol(); return ε; }
`
		const result = prepareHotModule(js, file)
		expect(result.slotCount).toBe(4)
		for (const name of ['εSELF', 'ε', 'bjφ', 'c$0']) expect(result.js).toContain(`__bsyms__[${JSON.stringify(name)}]`)
		expect(result.js).toContain('const application = Symbol();')
		expect(result.js).toContain("const text = 'ε = Symbol()';")
		expect(result.js).toContain('// ε = Symbol()')
		expect(result.js).toContain('function allocate() { const ε = Symbol(); return ε; }')
	})

	test('only makes the generated named getter cache configurable', () => {
		const js = `class Popup {
get $menu() {
 let el = imba_createComponent('test-menu',null,'',null,null);
 return (Object.defineProperty(this,'$menu',{value:el}),el);
}
method() { let el = {}; Object.defineProperty(this,'$custom',{value:el}); }
}
const text = "Object.defineProperty(this,'$menu',{value:el})";
`
		const result = prepareHotModule(js, file)
		expect(result.js).toContain("Object.defineProperty(this,'$menu',{value:el,configurable:true})")
		expect(result.js).toContain("Object.defineProperty(this,'$custom',{value:el})")
		expect(result.js).toContain(`const text = "Object.defineProperty(this,'$menu',{value:el})";`)
	})
})
