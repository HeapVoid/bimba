import { serve as bunServe } from 'bun'
import * as compiler from 'imba/compiler'
import { watch, existsSync } from 'fs'
import path from 'path'
import { theme } from './utils.js'
import { printerr } from './plugin.js'

// ─── HMR Client (injected into browser) ──────────────────────────────────────

const hmrClient = `
<script>
(function() {
	// ── Custom element registry with prototype patching ────────────────────────
	//
	// On initial page load: tags are not registered yet → call original define,
	// store the class in _classes map.
	//
	// On hot reload: the re-imported module calls customElements.define() again.
	// The tag is already registered (browser ignores duplicate defines).
	// Instead of ignoring the new class, we patch the prototype of the original
	// class with all new methods. This means:
	//   - Existing element instances immediately get new render/methods
	//   - Instance properties (el.active, el.count, etc.) are preserved
	//   - CSS is auto-updated by imba_styles.register() during module execution
	//
	const _origDefine = customElements.define.bind(customElements);
	const _classes = new Map(); // tagName → first-registered constructor
	let _hotTags = [];          // tags defined during the current hot import

	customElements.define = function(name, cls, opts) {
		_hotTags.push(name);
		const existing = customElements.get(name);
		if (!existing) {
			_origDefine(name, cls, opts);
			_classes.set(name, cls);
		} else {
			const target = _classes.get(name);
			if (target) _patchClass(target, cls);
		}
	};

	const _skipStatics = new Set(['length', 'name', 'prototype', 'caller', 'arguments']);

	// Copy all own property descriptors from source to target, skipping keys
	// that match the shouldSkip predicate. Handles both string and symbol keys.
	function _copyDescriptors(target, source, shouldSkip) {
		for (const key of Object.getOwnPropertyNames(source)) {
			if (shouldSkip(key)) continue;
			const d = Object.getOwnPropertyDescriptor(source, key);
			if (d) try { Object.defineProperty(target, key, d); } catch(_) {}
		}
		for (const key of Object.getOwnPropertySymbols(source)) {
			const d = Object.getOwnPropertyDescriptor(source, key);
			if (d) try { Object.defineProperty(target, key, d); } catch(_) {}
		}
	}

	function _patchClass(target, source) {
		_copyDescriptors(target.prototype, source.prototype, k => k === 'constructor');
		_copyDescriptors(target, source, k => _skipStatics.has(k));
	}

	// ── HMR update handler ─────────────────────────────────────────────────────

	function _applyUpdate(file) {
		clearError();
		_hotTags = [];

		import('/' + file + '?t=' + Date.now()).then(() => {
			_hotTags = [];

			// Remove duplicate root elements. Re-importing a module with a fresh
			// ?t= query causes top-level code (e.g. imba.mount()) to run again,
			// which can append a second copy of the root tag to body.
			const seen = new Set();
			[...document.body.children].forEach(el => {
				const tag = el.tagName.toLowerCase();
				if (seen.has(tag)) el.remove();
				else seen.add(tag);
			});

			// Let Imba re-render in place from the patched prototypes. We do NOT
			// touch instance DOM (no innerHTML reset, no symbol cleanup) — that
			// would destroy rendered children like open popups / dropdowns and
			// collapse any transient UI state. Prototype patching already makes
			// the next render use the new methods; imba.commit() triggers it.
			if (typeof imba !== 'undefined') imba.commit();
		});
	}

	// ── WebSocket connection ───────────────────────────────────────────────────

	let _connected = false;

	function connect() {
		const ws = new WebSocket('ws://' + location.host + '/__hmr__');

		ws.onopen = () => {
			// If we reconnect after a disconnect, reload to get fresh state
			if (_connected) location.reload();
			else _connected = true;
		};

		ws.onmessage = (e) => {
			const msg = JSON.parse(e.data);
			if      (msg.type === 'update')      _applyUpdate(msg.file);
			else if (msg.type === 'reload')      location.reload();
			else if (msg.type === 'error')       showError(msg.file, msg.errors);
			else if (msg.type === 'clear-error') clearError();
		};

		ws.onclose = () => setTimeout(connect, 1000);
	}

	// ── Error overlay ──────────────────────────────────────────────────────────

	function showError(file, errors) {
		let overlay = document.getElementById('__bimba_error__');
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = '__bimba_error__';
			overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;font-family:monospace;padding:24px;box-sizing:border-box';
			overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
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
})();
</script>`

// ─── Server-side compile cache ────────────────────────────────────────────────

const _compileCache = new Map()  // filepath → { mtime, result }
const _prevJs = new Map()  // filepath → compiled js — for change detection

async function compileFile(filepath) {
	const file = Bun.file(filepath)
	const stat = await file.stat()
	const mtime = stat.mtime.getTime()

	const cached = _compileCache.get(filepath)
	if (cached && cached.mtime === mtime) return { ...cached.result, changeType: 'cached' }

	const code = await file.text()
	const result = compiler.compile(code, {
		sourcePath: filepath,
		platform: 'browser',
		sourcemap: 'inline',
	})

	const changeType = _prevJs.get(filepath) === result.js ? 'none' : 'full'
	_prevJs.set(filepath, result.js)
	_compileCache.set(filepath, { mtime, result })
	return { ...result, changeType }
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function findHtml(flagHtml) {
	if (flagHtml) return flagHtml;
	const candidates = ['./index.html', './public/index.html', './src/index.html'];
	return candidates.find(p => existsSync(p)) || './index.html';
}

// Build an ES import map from package.json dependencies.
// Packages with an .imba entry point are served locally; others via esm.sh.
async function buildImportMap() {
	const imports = {
		'imba/runtime': 'https://esm.sh/imba/runtime',
		'imba': 'https://esm.sh/imba',
	};
	try {
		const pkg = JSON.parse(await Bun.file('./package.json').text());
		for (const [name] of Object.entries(pkg.dependencies || {})) {
			if (name === 'imba') continue;
			try {
				const depPkg = JSON.parse(await Bun.file(`./node_modules/${name}/package.json`).text());
				const entry = depPkg.module || depPkg.main;
				imports[name] = (entry && entry.endsWith('.imba'))
					? `/node_modules/${name}/${entry}`
					: `https://esm.sh/${name}`;
			} catch(_) {
				imports[name] = `https://esm.sh/${name}`;
			}
		}
	} catch(_) { /* no package.json */ }

	return `\t\t<script type="importmap">\n\t\t\t${JSON.stringify({ imports }, null, '\t\t\t\t')}\n\t\t</script>`;
}

// Rewrite production HTML for the dev server:
// strips existing importmap + data-entrypoint script, injects importmap +
// entrypoint module + HMR client before </head>.
function transformHtml(html, entrypoint, importMapTag) {
	html = html.replace(/<script\s+type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi, '');
	html = html.replace(/<script([^>]*)\bdata-entrypoint\b([^>]*)><\/script>/gi, '');
	const entryUrl = '/' + entrypoint.replace(/^\.\//, '').replaceAll('\\', '/');
	html = html.replace('</head>',
		`${importMapTag}\n\t\t<script type='module' src='${entryUrl}'></script>\n${hmrClient}\n\t</head>`
	);
	return html;
}

// ─── Dev server ───────────────────────────────────────────────────────────────

export function serve(entrypoint, flags) {
	const port    = flags.port || 5200
	const htmlPath = findHtml(flags.html)
	const htmlDir  = path.dirname(htmlPath)
	const srcDir   = path.dirname(entrypoint)
	const sockets  = new Set()
	let importMapTag = null

	// ── Status line (prints current compile result, fades out on success) ──────

	let _fadeTimers = []
	let _fadeId = 0
	let _statusSaved = false
	const _isTTY = process.stdout.isTTY

	function cancelFade() {
		_fadeTimers.forEach(t => clearTimeout(t))
		_fadeTimers = []
	}

	function printStatus(file, state, errors) {
		// non-TTY (pipes, Claude Code bash, CI): plain newline-terminated output,
		// no ANSI cursor tricks, no fade-out — so logs stay readable.
		if (!_isTTY) {
			const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
			const tag = state === 'ok' ? 'ok' : 'fail'
			process.stdout.write(`  ${now}  ${file}  ${tag}\n`)
			if (errors?.length) {
				for (const err of errors) {
					const msg = err.message || String(err)
					const line = err.range?.start?.line
					process.stdout.write(`    ${msg}${line ? ` (line ${line})` : ''}\n`)
				}
			}
			return
		}

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
			const total = plainLine.length
			process.stdout.write(`  ${theme.folder(now)}  ${theme.filename(file)}  ${status}`)
			for (let i = 1; i <= total; i++) {
				_fadeTimers.push(setTimeout(() => {
					if (_fadeId !== myId) return
					process.stdout.write('\x1b[1D \x1b[1D')
					if (i === total) _statusSaved = false
				}, 5000 + i * 22))
			}
		}
	}

	// ── File watcher ───────────────────────────────────────────────────────────

	function broadcast(payload) {
		const msg = JSON.stringify(payload)
		for (const socket of sockets) socket.send(msg)
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
				broadcast({ type: 'error', file: rel, errors: out.errors.map(e => ({
					message: e.message,
					line: e.range?.start?.line,
					snippet: e.toSnippet(),
				})) })
				return
			}

			// No change at all — skip
			if (out.changeType === 'none' || out.changeType === 'cached') return

			printStatus(rel, 'ok')
			broadcast({ type: 'clear-error' })
			broadcast({ type: 'update', file: rel })
		} catch(e) {
			printStatus(rel, 'fail', [{ message: e.message }])
			broadcast({ type: 'error', file: rel, errors: [{ message: e.message, snippet: e.stack || e.message }] })
		}
	})

	// ── HTTP + WebSocket server ────────────────────────────────────────────────

	bunServe({
		port,
		development: true,

		fetch: async (req, server) => {
			const url = new URL(req.url)
			const pathname = url.pathname

			// WebSocket upgrade for HMR
			if (pathname === '/__hmr__') {
				if (server.upgrade(req)) return undefined
			}

			// HTML: index or any .html file
			if (pathname === '/' || pathname.endsWith('.html')) {
				const htmlFile = pathname === '/' ? htmlPath : '.' + pathname
				let html = await Bun.file(htmlFile).text()
				if (!importMapTag) importMapTag = await buildImportMap()
				return new Response(transformHtml(html, entrypoint, importMapTag), {
					headers: { 'Content-Type': 'text/html' },
				})
			}

			// Imba files: compile on demand and serve as JS
			if (pathname.endsWith('.imba')) {
				const filepath = '.' + pathname
				try {
					const out = await compileFile(filepath)
					if (out.errors?.length) {
						const file = pathname.replace(/^\//, '')
						printStatus(file, 'fail', out.errors)
						broadcast({ type: 'error', file, errors: out.errors.map(e => ({
							message: e.message,
							line: e.range?.start?.line,
							snippet: e.toSnippet(),
						})) })
						return new Response(out.errors.map(e => e.message).join('\n'), { status: 500 })
					}
					return new Response(out.js, { headers: { 'Content-Type': 'application/javascript' } })
				} catch(e) {
					const file = pathname.replace(/^\//, '')
					printStatus(file, 'fail', [{ message: e.message }])
					broadcast({ type: 'error', file, errors: [{ message: e.message, snippet: e.stack || e.message }] })
					return new Response(e.message, { status: 500 })
				}
			}

			// Static files: check htmlDir first (for assets relative to HTML), then root
			const inHtmlDir = Bun.file(path.join(htmlDir, pathname))
			if (await inHtmlDir.exists()) return new Response(inHtmlDir)
			const inRoot = Bun.file('.' + pathname)
			if (await inRoot.exists()) return new Response(inRoot)

			// SPA fallback for extension-less paths
			const lastSegment = pathname.split('/').pop()
			if (!lastSegment.includes('.')) {
				let html = await Bun.file(htmlPath).text()
				if (!importMapTag) importMapTag = await buildImportMap()
				return new Response(transformHtml(html, entrypoint, importMapTag), {
					headers: { 'Content-Type': 'text/html' },
				})
			}

			return new Response('Not Found', { status: 404 })
		},

		websocket: {
			open:    ws => sockets.add(ws),
			close:   ws => sockets.delete(ws),
			message: () => {},
		},
	})

	console.log(theme.folder('──────────────────────────────────────────────────────────────────────'))
	console.log(theme.start('Dev server running at ') + theme.success(`http://localhost:${port}`))
	console.log(theme.folder('──────────────────────────────────────────────────────────────────────'))
}
