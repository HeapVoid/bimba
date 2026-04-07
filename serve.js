import { serve as bunServe } from 'bun'
import * as compiler from 'imba/compiler'
import { watch, existsSync } from 'fs'
import path from 'path'
import { theme } from './utils.js'
import { printerr } from './plugin.js'

// HMR client — single mode with debounced updates and element discard
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

	// Debounced refresh: first update is instant, subsequent ones within 200ms are batched
	let _pending = false;
	let _pendingFiles = new Set();

	function scheduleRefresh(file) {
		_pendingFiles.add(file);
		if (_pending) return; // already scheduled
		_pending = true;

		// First update: immediate
		requestAnimationFrame(() => {
			doRefresh();
			_pending = false;

			// If more files arrived during this frame, schedule another refresh
			if (_pendingFiles.size > 0) {
				setTimeout(() => {
					_pending = true;
					requestAnimationFrame(() => {
						doRefresh();
						_pending = false;
					});
				}, 200);
			}
		});
	}

	function doRefresh() {
		if (_pendingFiles.size === 0) return;
		const files = [..._pendingFiles];
		_pendingFiles.clear();

		// Remove old elements from DOM so Imba recreates them
		const updatedClasses = [..._updated].map(n => _registry.get(n)).filter(Boolean);
		if (updatedClasses.length) {
			document.querySelectorAll('*').forEach(el => {
				for (const cls of updatedClasses) {
					if (el instanceof cls) {
						// Remove from parent so Imba can recreate
						if (el.parentNode) {
							el.parentNode.removeChild(el);
						}
						break;
					}
				}
			});
		}
		_updated.clear();

		// Tell Imba to re-render
		if (typeof imba !== 'undefined') {
			if (imba.invalidate) imba.invalidate();
			else if (imba.commit) imba.commit();
		}
	}

	let _connected = false;
	let _overlay = null;

	function connect() {
		const ws = new WebSocket('ws://' + location.host + '/__hmr__');
		ws.onopen = () => {
			if (_connected) {
				location.reload();
			} else {
				_connected = true;
			}
		};
		ws.onmessage = (e) => {
			const data = JSON.parse(e.data);
			if (data.type === 'update') {
				clearError();
				_updated.clear();
				import('/' + data.file + '?t=' + Date.now()).then(() => {
					scheduleRefresh(data.file);
				});
			} else if (data.type === 'reload') {
				location.reload();
			} else if (data.type === 'error') {
				showError(data.file, data.errors);
			} else if (data.type === 'clear-error') {
				clearError();
			}
		};
		ws.onclose = () => {
			setTimeout(connect, 1000);
		};
	}

	function showError(file, errors) {
		let overlay = document.getElementById('__bimba_error__');
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = '__bimba_error__';
			overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;font-family:monospace;padding:24px;box-sizing:border-box';
			overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
			document.body.appendChild(overlay);
		}
		overlay.innerHTML = \`
			<div style="background:#1a1a1a;border:1px solid #ff4444;border-radius:8px;max-width:860px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 0 40px rgba(255,68,68,.3)">
				<div style="background:#ff4444;color:#fff;padding:10px 16px;font-size:13px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
					<span>Compile error — \${file}</span>
					<span onclick="document.getElementById('__bimba_error__').remove()" style="cursor:pointer;opacity:.7;font-size:16px">✕</span>
				</div>
				\${errors.map(err => \`
					<div style="padding:16px;border-bottom:1px solid #333">
						<div style="color:#ff8080;font-size:13px;margin-bottom:10px">\${err.message}\${err.line ? \` <span style="color:#888">line \${err.line}</span>\` : ''}</div>
						\${err.snippet ? \`<pre style="margin:0;padding:10px;background:#111;border-radius:4px;font-size:12px;line-height:1.6;color:#ccc;overflow-x:auto;white-space:pre">\${err.snippet.replace(/</g,'&lt;')}</pre>\` : ''}
					</div>
				\`).join('')}
			</div>
		\`;
	}

	function clearError() {
		const overlay = document.getElementById('__bimba_error__');
		if (overlay) overlay.remove();
	}

	connect();
</script>`

const _compileCache = new Map()
const _versionHistory = new Map()

async function compileFile(filepath) {
	const file = Bun.file(filepath)
	const stat = await file.stat()
	const mtime = stat.mtime.getTime()
	const cached = _compileCache.get(filepath)
	if (cached && cached.mtime === mtime) return { ...cached.result, cached: true }
	const code = await file.text()
	const result = compiler.compile(code, { sourcePath: filepath, platform: 'browser', sourcemap: 'inline' })
	
	// Track what changed compared to previous version
	const prev = _versionHistory.get(filepath)
	let changeType = 'full'
	if (prev) {
		const cssChanged = prev.css !== result.css
		const jsChanged = prev.js !== result.js
		if (cssChanged && !jsChanged) {
			changeType = 'css-only'
		} else if (jsChanged) {
			changeType = 'full'
		} else if (!cssChanged && !jsChanged) {
			changeType = 'none'
		}
	}
	
	_versionHistory.set(filepath, { css: result.css, js: result.js })
	_compileCache.set(filepath, { mtime, result })
	return { ...result, changeType }
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

	let _fadeTimers = []
	let _fadeId = 0
	let _statusSaved = false

	function cancelFade() {
		_fadeTimers.forEach(t => clearTimeout(t))
		_fadeTimers = []
	}

	function printStatus(file, state, errors) {
		cancelFade()
		if (_statusSaved) {
			process.stdout.write('\x1b[u\x1b[J')
			_statusSaved = false
		}
		const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
		const status = state === 'ok' ? theme.success(' ok ') : theme.failure(' fail ')
		process.stdout.write('\x1b[s')
		_statusSaved = true
		if (errors?.length) {
			process.stdout.write(`  ${theme.folder(now)}  ${theme.filename(file)}  ${status}\n`)
			for (const err of errors) {
				try { printerr(err) } catch(_) { process.stdout.write('  ' + err.message + '\n') }
			}
		} else {
			const myId = ++_fadeId
			const plainLine = `  ${now}  ${file}   ok `
			const totalLen = plainLine.length
			const startDelay = 5000
			const charDelay = 22

			process.stdout.write(`  ${theme.folder(now)}  ${theme.filename(file)}  ${status}`)

			for (let i = 1; i <= totalLen; i++) {
				_fadeTimers.push(setTimeout(() => {
					if (_fadeId !== myId) return
					process.stdout.write('\x1b[1D \x1b[1D')
					if (i === totalLen) {
						_statusSaved = false
					}
				}, startDelay + i * charDelay))
			}
		}
	}

	const _debounce = new Map()

	watch(srcDir, { recursive: true }, async (_event, filename) => {
		if (!filename || !filename.endsWith('.imba')) return
		if (_debounce.has(filename)) return
		_debounce.set(filename, setTimeout(() => _debounce.delete(filename), 50))

		const filepath = path.join(srcDir, filename)
		const rel = path.join(path.relative('.', srcDir), filename).replaceAll('\\', '/')

		try {
			const out = await compileFile(filepath)

			if (out.errors?.length) {
				printStatus(rel, 'fail', out.errors)
				const payload = JSON.stringify({ type: 'error', file: rel, errors: out.errors.map(e => ({ message: e.message, line: e.range?.start?.line, snippet: e.toSnippet() })) })
				for (const socket of sockets) socket.send(payload)
				return
			}

			printStatus(rel, 'ok')
			for (const socket of sockets) socket.send(JSON.stringify({ type: 'clear-error' }))

			// Log to terminal what changed
			const changeLabel = out.changeType === 'css-only' ? theme.success(' CSS ') : out.changeType === 'full' ? theme.failure(' JS+CSS ') : theme.action(' none ')
			console.log(`  ${theme.folder(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}  ${changeLabel}  ${theme.filename(rel)}`)

			// Always send update — HMR client handles debouncing and element discard
			for (const socket of sockets) socket.send(JSON.stringify({ type: 'update', file: rel }))
		} catch (e) {
			printStatus(rel, 'fail', [{ message: e.message }])
			const payload = JSON.stringify({ type: 'error', file: rel, errors: [{ message: e.message, snippet: e.stack || e.message }] })
			for (const socket of sockets) socket.send(payload)
		}
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
					const file = pathname.replace(/^\//, '')
					if (out.errors?.length) {
						printStatus(file, 'fail', out.errors)
						const payload = JSON.stringify({ type: 'error', file, errors: out.errors.map(e => ({ message: e.message, line: e.range?.start?.line, snippet: e.toSnippet() })) })
						for (const socket of sockets) socket.send(payload)
						return new Response(out.errors.map(e => e.message).join('\n'), { status: 500 })
					}
					// Don't send HMR events from on-demand requests - only from file watcher
					return new Response(out.js, { headers: { 'Content-Type': 'application/javascript' } })
				} catch (e) {
					const file = pathname.replace(/^\//, '')
					printStatus(file, 'fail', [{ message: e.message }])
					const payload = JSON.stringify({ type: 'error', file, errors: [{ message: e.message, snippet: e.stack || e.message }] })
					for (const socket of sockets) socket.send(payload)
					return new Response(e.message, { status: 500 })
				}
			}

			// Static files: check htmlDir first (assets relative to HTML), then root (node_modules, src, etc.)
			const htmlDirFile = Bun.file(path.join(htmlDir, pathname))
			if (await htmlDirFile.exists()) return new Response(htmlDirFile)
			const file = Bun.file('.' + pathname)
			if (await file.exists()) return new Response(file)

			// SPA fallback: serve index.html only for URL-like paths (no file extension)
			const lastSegment = pathname.split('/').pop()
			if (!lastSegment.includes('.')) {
				let html = await Bun.file(htmlPath).text()
				if (!importMapTag) importMapTag = await buildImportMap()
				html = transformHtml(html, entrypoint, importMapTag)
				return new Response(html, { headers: { 'Content-Type': 'text/html' } })
			}
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
