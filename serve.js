import { serve as bunServe } from 'bun'
import * as compiler from 'imba/compiler'
import { watch, existsSync } from 'fs'
import path from 'path'
import { theme } from './utils.js'

const hmrClient = `
<script>
	const _originalDefine = customElements.define.bind(customElements);
	const _registry = new Map();
	const _updated = new Set();

	customElements.define = function(name, cls, opts) {
		const existing = _registry.get(name);
		if (existing) {
			Object.getOwnPropertyNames(cls.prototype).forEach(key => {
				if (key === 'constructor') return;
				try { Object.defineProperty(existing.prototype, key, Object.getOwnPropertyDescriptor(cls.prototype, key)); } catch(e) {}
			});
			Object.getOwnPropertyNames(cls).forEach(key => {
				if (['length','name','prototype','arguments','caller'].includes(key)) return;
				try { Object.defineProperty(existing, key, Object.getOwnPropertyDescriptor(cls, key)); } catch(e) {}
			});
			_updated.add(name);
		} else {
			_registry.set(name, cls);
			_originalDefine(name, cls, opts);
		}
	};

	function resetElement(el) {
		Object.getOwnPropertySymbols(el).forEach(s => {
			try { if (el[s] instanceof Node) el[s] = undefined; } catch(e) {}
		});
		el.innerHTML = '';
	}

	const ws = new WebSocket('ws://' + location.host + '/__hmr__');
	ws.onmessage = (e) => {
		const data = JSON.parse(e.data);
		if (data.type === 'update') {
			_updated.clear();
			import('/' + data.file + '?t=' + Date.now()).then(() => {
				const updatedClasses = [..._updated].map(n => _registry.get(n)).filter(Boolean);
				const found = [];
				if (updatedClasses.length) {
					document.querySelectorAll('*').forEach(el => {
						for (const cls of updatedClasses) {
							if (el instanceof cls) { found.push(el); break; }
						}
					});
				}
				found.forEach(resetElement);
				_updated.clear();
				imba.commit();
			});
		} else if (data.type === 'reload') {
			location.reload();
		}
	};
</script>`

async function compileFile(filepath) {
	const code = await Bun.file(filepath).text()
	return compiler.compile(code, { sourcePath: filepath, platform: 'browser' })
}

function findHtml(flagHtml) {
	if (flagHtml) return flagHtml;
	const candidates = ['./index.html', './public/index.html', './src/index.html'];
	return candidates.find(p => existsSync(p)) || './index.html';
}

// Build importmap from package.json dependencies.
// Packages with an .imba entry point are served locally; others via esm.sh.
async function buildImportMap() {
	const imports = {
		"imba/runtime": "https://esm.sh/imba/runtime",
		"imba": "https://esm.sh/imba"
	};
	try {
		const pkg = JSON.parse(await Bun.file('./package.json').text());
		for (const [name] of Object.entries(pkg.dependencies || {})) {
			if (name === 'imba') continue;
			try {
				const depPkg = JSON.parse(await Bun.file(`./node_modules/${name}/package.json`).text());
				const entry = depPkg.module || depPkg.main;
				if (entry && entry.endsWith('.imba')) {
					imports[name] = `/node_modules/${name}/${entry}`;
				} else {
					imports[name] = `https://esm.sh/${name}`;
				}
			} catch(e) {
				imports[name] = `https://esm.sh/${name}`;
			}
		}
	} catch(e) { /* no package.json, use defaults */ }

	const json = JSON.stringify({ imports }, null, '\t\t\t\t');
	return `\t\t<script type="importmap">\n\t\t\t${json}\n\t\t</script>`;
}

// Transform production HTML for dev:
// - removes existing importmap block
// - removes <script data-bimba> from its position
// - injects importmap + entrypoint script + HMR client before </head>
function transformHtml(html, entrypoint, importMapTag) {
	html = html.replace(/<script\s+type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi, '');
	html = html.replace(/<script([^>]*)\bdata-entrypoint\b([^>]*)><\/script>/gi, '');

	const entryUrl = '/' + entrypoint.replace(/^\.\//, '').replaceAll('\\', '/');
	const entryScript = `\t\t<script type='module' src='${entryUrl}'></script>`;

	html = html.replace('</head>', `${importMapTag}\n${entryScript}\n${hmrClient}\n\t</head>`);
	return html;
}

export function serve(entrypoint, flags) {
	const port = flags.port || 5200
	const htmlPath = findHtml(flags.html)
	const htmlDir = path.dirname(htmlPath)
	const srcDir = path.dirname(entrypoint)
	const sockets = new Set()
	let importMapTag = null

	watch(srcDir, { recursive: true }, (_event, filename) => {
		if (!filename || !filename.endsWith('.imba')) return
		const rel = path.join(path.relative('.', srcDir), filename).replaceAll('\\', '/')
		// console.log(theme.action('changed: ') + theme.filename(rel))
		for (const socket of sockets)
			socket.send(JSON.stringify({ type: 'update', file: rel }))
	})

	bunServe({
		port,
		development: true,

		fetch: async (req, server) => {
			const url = new URL(req.url)
			const pathname = url.pathname

			if (pathname === '/__hmr__') {
				if (server.upgrade(req)) return undefined
			}

			if (pathname === '/' || pathname.endsWith('.html')) {
				const htmlFile = pathname === '/' ? htmlPath : '.' + pathname
				let html = await Bun.file(htmlFile).text()
				if (!importMapTag) importMapTag = await buildImportMap()
				html = transformHtml(html, entrypoint, importMapTag)
				return new Response(html, { headers: { 'Content-Type': 'text/html' } })
			}

			if (pathname.endsWith('.imba')) {
				try {
					const out = await compileFile('.' + pathname)
					return new Response(out.js, { headers: { 'Content-Type': 'application/javascript' } })
				} catch (e) {
					return new Response(e.message, { status: 500 })
				}
			}

			// Static files: check htmlDir first (assets relative to HTML), then root (node_modules, src, etc.)
			const htmlDirFile = Bun.file(path.join(htmlDir, pathname))
			if (await htmlDirFile.exists()) return new Response(htmlDirFile)
			const file = Bun.file('.' + pathname)
			if (await file.exists()) return new Response(file)
			return new Response('Not Found', { status: 404 })
		},

		websocket: {
			open: (ws) => sockets.add(ws),
			close: (ws) => sockets.delete(ws),
		}
	})

	console.log(theme.folder('──────────────────────────────────────────────────────────────────────'))
	console.log(theme.start(`Dev server running at `) + theme.success(`http://localhost:${port}`))
	console.log(theme.folder('──────────────────────────────────────────────────────────────────────'))
}
