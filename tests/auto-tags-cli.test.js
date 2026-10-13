import {afterEach, expect, test} from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const directories = [], executable = path.resolve(import.meta.dir, '../index.js')
afterEach(() => {for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive:true, force:true})})

function fixture(config) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bimba-tag-cli-'))
	directories.push(cwd)
	fs.mkdirSync(path.join(cwd,'src'))
	fs.symlinkSync(path.resolve(import.meta.dir,'../node_modules'),path.join(cwd,'node_modules'),'dir')
	fs.writeFileSync(path.join(cwd,'bunfig.toml'),'# No project preload.\n')
	fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({name:'auto-tags-cli-fixture', bimba:config === undefined ? {} : {tags:config}}))
	fs.writeFileSync(path.join(cwd,'src/app.imba'),"export def open do import('./page.imba')\nwindow.openPage = open\n")
	fs.writeFileSync(path.join(cwd,'src/page.imba'),"tag lazy-page < base-panel\n\t<self>\n\t\t<status-badge>\n")
	fs.writeFileSync(path.join(cwd,'src/base.imba'),"tag base-panel\n\t<self>\n")
	fs.writeFileSync(path.join(cwd,'src/badge.imba'),"tag status-badge\n\t<self> 'Automatic CLI dependency'\n")
	return cwd
}

async function cli(cwd, ...flags) {
	const child = Bun.spawn([process.execPath, '--no-env-file', executable, 'src/app.imba', '--outdir','out','--splitting', ...flags], {cwd, stdout:'pipe', stderr:'pipe'})
	const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
	return {code, output:(out+err).replace(/\x1b\[[0-9;]*m/g,'')}
}
const outputs = cwd => fs.readdirSync(path.join(cwd,'out')).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(cwd,'out',file),'utf8'))

test('the project opts into automatic lazy tag linking through the CLI flag', async () => {
	const cwd = fixture()
	const result = await cli(cwd,'--auto-tags')
	expect(result.code).toBe(0)
	expect(result.output).toContain('Success')
	const files = outputs(cwd)
	expect(files.length).toBeGreaterThan(1)
	expect(files.join('\n')).toContain('Automatic CLI dependency')
	expect(fs.readFileSync(path.join(cwd,'out/app.js'),'utf8')).not.toContain('Automatic CLI dependency')
})

test('package.json selects source roots while the ordinary CLI remains unchanged', async () => {
	const cwd = fixture({roots:['src','components']})
	fs.mkdirSync(path.join(cwd,'components'))
	fs.renameSync(path.join(cwd,'src/badge.imba'),path.join(cwd,'components/badge.imba'))
	const baseline = await cli(cwd)
	expect(baseline.code).toBe(0)
	expect(outputs(cwd).join('\n')).not.toContain('Automatic CLI dependency')
	const automatic = await cli(cwd,'--auto-tags')
	expect(automatic.code).toBe(0)
	expect(outputs(cwd).join('\n')).toContain('Automatic CLI dependency')
})

test('an invalid dependency graph fails without replacing a previous successful entry', async () => {
	const cwd = fixture()
	expect((await cli(cwd,'--auto-tags')).code).toBe(0)
	const before = fs.readFileSync(path.join(cwd,'out/app.js'),'utf8')
	fs.unlinkSync(path.join(cwd,'src/badge.imba'))
	const result = await cli(cwd,'--auto-tags')
	expect(result.code).toBe(1)
	expect(result.output).toContain('Missing tag dependency status-badge')
	expect(result.output).not.toContain('Success')
	expect(fs.readFileSync(path.join(cwd,'out/app.js'),'utf8')).toBe(before)
})

test('incompatible CLI modes fail before creating output or bunfig', async () => {
	const cwd = fixture()
	fs.unlinkSync(path.join(cwd,'bunfig.toml'))
	for (const flags of [['--serve'],['--watch'],['--typecheck'],['--check'],['--frontend-check'],['--target','node'],['--sourcemap','external']]) {
		const result = await cli(cwd,'--auto-tags',...flags)
		expect(result.code).toBe(1)
		expect(result.output).toContain('--auto-tags supports browser bundle mode')
	}
	expect(fs.existsSync(path.join(cwd,'out'))).toBe(false)
	expect(fs.existsSync(path.join(cwd,'bunfig.toml'))).toBe(false)
})

test('malformed project configuration cannot silently disable an authorized auto-tags build', async () => {
	for (const config of [false, 'src', {roots:[]}, {roots:'src'}]) {
		const cwd = fixture(config)
		const result = await cli(cwd,'--auto-tags')
		expect(result.code).toBe(1)
		expect(result.output).not.toContain('Success')
		expect(fs.existsSync(path.join(cwd,'out'))).toBe(false)
	}
	const cwd = fixture()
	fs.writeFileSync(path.join(cwd,'package.json'),'{broken')
	expect((await cli(cwd,'--auto-tags')).code).toBe(1)
})

test('auto-tags is explicitly optional even when the project supplies its configuration', async () => {
	const cwd = fixture({roots:['src']})
	const result = await cli(cwd,'--no-auto-tags')
	expect(result.code).toBe(0)
	expect(outputs(cwd).join('\n')).not.toContain('Automatic CLI dependency')
})

test('a late lazy-boundary conflict cannot replace any previous bundle artifacts', async () => {
	const cwd = fixture()
	fs.writeFileSync(path.join(cwd,'src/app.imba'),"export def open do import('./page.imba')\nexport def dialog do import('./popup.imba')\nwindow.openPage = open\n")
	const page = "import {dialog} from './app.imba'\nexport def showDialog\n\tconst loaded = await dialog!\n\timba.mount <popup-dialog> if loaded\ntag lazy-page\n\t<self> 'Catalogue'\n"
	fs.writeFileSync(path.join(cwd,'src/page.imba'),"import './popup.imba'\n" + page)
	fs.writeFileSync(path.join(cwd,'src/popup.imba'),"tag popup-dialog\n\t<self> 'Dialog'\n")
	expect((await cli(cwd,'--auto-tags')).code).toBe(0)
	const before = outputs(cwd)
	fs.writeFileSync(path.join(cwd,'src/page.imba'),page)
	const result = await cli(cwd,'--auto-tags')
	expect(result.code).toBe(1)
	expect(result.output).toContain('crosses declared import() boundary')
	expect(result.output).not.toContain('Success')
	expect(outputs(cwd)).toEqual(before)
})

test('a shell compiler error cannot be hidden by a previously successful bundle', async () => {
	const cwd = fixture()
	expect((await cli(cwd,'--auto-tags')).code).toBe(0)
	const before = outputs(cwd)
	fs.writeFileSync(path.join(cwd,'src/app.imba'),"export def open\n\tif\n")
	const result = await cli(cwd,'--auto-tags')
	expect(result.code).toBe(1)
	expect(result.output).toContain('app.imba')
	expect(result.output).not.toContain('Success')
	expect(outputs(cwd)).toEqual(before)
})
