import vm from 'node:vm'

export async function clientTemplate() {
	const source = await Bun.file(new URL('../serve.js', import.meta.url)).text()
	const fileUrl = source.match(/function fileUrl\(filepath\) \{[\s\S]*?\n\}/)[0]
	const template = source.match(/const hmrClient = (`[\s\S]*?`)\n/)[1]
	return vm.runInNewContext(fileUrl + '\n' + template)
}
