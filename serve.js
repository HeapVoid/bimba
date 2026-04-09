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
	let _collector = null;      // when set, captures tag names defined during one HMR import

	customElements.define = function(name, cls, opts) {
		if (_collector) _collector.push(name);
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

	// Updates are serialized via a promise queue. Without this, two file edits
	// arriving back-to-back would race on the shared collector and on imba's
	// reconcile loop, with the second update potentially missing tags from
	// the first.
	let _queue = Promise.resolve();

	function _applyUpdate(file, slots) {
		_queue = _queue.then(() => _doUpdate(file, slots)).catch(err => {
			// Safety net: any uncaught failure during HMR → full reload.
			// Better to lose state than to leave a broken page.
			console.error('[bimba HMR] reload due to error:', err);
			location.reload();
		});
	}

	// Walk a subtree and call disconnectedCallback on each custom element.
	// Used before destroying inner DOM on the shifted path so imba/web-component
	// teardown logic (event listeners, observers, etc.) runs cleanly.
	function _disconnectDescendants(root) {
		const all = root.querySelectorAll('*');
		for (const el of all) {
			if (el.tagName.includes('-')) {
				try { el.disconnectedCallback && el.disconnectedCallback(); } catch(_) {}
			}
		}
	}

	async function _doUpdate(file, slots) {
		clearError();

		// Snapshot direct body children BEFORE importing the new module, so we
		// know which elements pre-existed. After commit we only dedupe NEW
		// elements whose tag also existed before — this preserves legitimate
		// multi-instance roots like toasts and parallel popups, while still
		// catching accidental re-mounts from re-running top-level code.
		const bodyBefore = new Set(document.body.children);
		const tagsBefore = new Set();
		for (const el of bodyBefore) tagsBefore.add(el.tagName.toLowerCase());

		// Use a local collector instead of a shared variable so concurrent
		// imports can't clobber each other's tag lists.
		const collected = [];
		const prev = _collector;
		_collector = collected;
		try {
			await import('/' + file + '?t=' + Date.now());
		} finally {
			_collector = prev;
		}

		// Two HMR paths depending on whether render-cache slot symbols are
		// stable across this re-import:
		//
		// 'stable': server-side symbol stabilization made the new module's
		//   anonymous Symbols identical (by reference) to the previous
		//   compilation. Live element instances still have valid slot
		//   references → imba's renderer will diff and update the existing
		//   DOM in place. We just patch class prototypes (already done in
		//   the customElements.define hook above) and call imba.commit().
		//   No DOM destruction, full inner state preserved.
		//
		// 'shifted': slot count changed (user added/removed elements), so
		//   stabilization can't safely reuse symbols. Fall back to the
		//   destructive path: snapshot own enumerable properties, wipe
		//   ANONYMOUS symbol slots only (preserve global Symbol.for keys
		//   that imba's runtime uses for lifecycle), clear innerHTML,
		//   restore state, re-render. Loses inner DOM state for instances
		//   of the patched tags, but preserves their instance fields.
		// Snapshot child counts of the patched tags BEFORE commit. On the
		// stable path, child count must not grow — if it does, it means slot
		// stabilization failed for this edit and imba's renderer appended
		// fresh children alongside the old ones. That's the duplication bug
		// we cannot recover from in-place → trigger a reload.
		const childSnap = new Map();
		for (const tag of collected) {
			const list = document.querySelectorAll(tag);
			for (const el of list) childSnap.set(el, el.children.length);
		}

		if (slots === 'shifted') {
			for (const tag of collected) {
				document.querySelectorAll(tag).forEach(el => {
					const state = {};
					for (const k of Object.keys(el)) state[k] = el[k];
					_disconnectDescendants(el);
					for (const sym of Object.getOwnPropertySymbols(el)) {
						if (Symbol.keyFor(sym) !== undefined) continue;
						try { delete el[sym]; } catch(_) {}
					}
					el.innerHTML = '';
					Object.assign(el, state);
					try { el.render && el.render(); } catch(_) {}
					// Re-fire lifecycle for the top tag itself: imba compiles
					// "def mount" to a mount() instance method, and standard
					// connectedCallback may also matter for descendants created
					// by render(). The element is still attached to its parent,
					// so we just call them directly.
					try { el.connectedCallback && el.connectedCallback(); } catch(_) {}
					try { el.mount && el.mount(); } catch(_) {}
				});
			}
		}

		if (typeof imba !== 'undefined') imba.commit();

		// Stable-path duplication check.
		if (slots !== 'shifted') {
			for (const [el, before] of childSnap) {
				if (el.children.length > before) {
					console.warn('[bimba HMR] slot stabilization failed, reloading');
					location.reload();
					return;
				}
			}
		}

		// Smart body dedupe: remove only elements that were ADDED during this
		// HMR cycle and whose tag already existed in body before. This catches
		// accidental re-mounts from top-level imba.mount() re-runs, but
		// preserves toasts, multiple modals, and devtools-injected siblings.
		for (const el of [...document.body.children]) {
			if (bodyBefore.has(el)) continue;
			if (tagsBefore.has(el.tagName.toLowerCase())) el.remove();
		}

		// Reap orphaned imba style blocks. Each compilation that produces a
		// different content hash leaves behind a <style> whose rules target
		// classnames no element in the DOM uses anymore. Walk our tracked
		// styles and drop the unused ones — keeps head clean and removes
		// stale rules that would otherwise still apply to live elements with
		// matching classnames (e.g. a "stuck" old text color).
		_reapStyles();
	}

	// ── Style reaper ───────────────────────────────────────────────────────────

	// imba_styles.register inserts <style data-id="<hash>"> blocks into <head>.
	// Walk them, sample a few class selectors, and check whether any element
	// in the document still uses one of those classnames. If not, the block
	// is dead (its tag was hot-replaced with a new content hash and the old
	// classnames are gone from the DOM) — remove it.
	function _reapStyles() {
		const styles = document.head.querySelectorAll('style[data-id]');
		for (const style of styles) {
			try {
				const sheet = style.sheet;
				if (!sheet || !sheet.cssRules) continue;
				const probes = [];
				for (const rule of sheet.cssRules) {
					if (probes.length >= 4) break;
					const sel = rule.selectorText;
					if (!sel) continue;
					const m = sel.match(/\.(z[a-z0-9_-]+)/i);
					if (m && !probes.includes(m[1])) probes.push(m[1]);
				}
				if (!probes.length) continue;
				let used = false;
				for (const cls of probes) {
					if (document.querySelector('.' + CSS.escape(cls))) { used = true; break; }
				}
				if (!used) style.remove();
			} catch(_) { /* cross-origin or detached */ }
		}
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
			if      (msg.type === 'update')      _applyUpdate(msg.file, msg.slots);
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
const _prevSlots = new Map()  // filepath → previous symbol slot count

// ─── Import dependency graph ──────────────────────────────────────────────────
//
// When a non-tag module (utility functions, constants, shared state) is edited,
// the existing class-prototype patching does nothing for the modules that
// imported it — they hold their own captured references. To make those
// updates flow into the UI, we track who imports whom and, on every change,
// re-broadcast updates for the transitive importer set. The client's existing
// HMR queue then re-imports each in turn; their top-level code reruns, picks
// up the new symbols, and any tag re-registrations patch instances in place.
//
// Keys are absolute, normalized paths (path.resolve). Edges are added during
// compilation by scanning the produced JS for relative .imba imports.

const _imports = new Map()    // absFile → Set<absFile> (what it imports)
const _importers = new Map()  // absFile → Set<absFile> (who imports it)

function extractImports(js, fromAbs) {
	const dir = path.dirname(fromAbs)
	const out = new Set()
	const re = /(?:^|[\s;])(?:import|from)\s*['"]([^'"]+)['"]/g
	let m
	while ((m = re.exec(js))) {
		const spec = m[1]
		if (!spec.startsWith('.') && !spec.startsWith('/')) continue
		if (!spec.endsWith('.imba')) continue
		const resolved = spec.startsWith('/')
			? path.resolve('.' + spec)
			: path.resolve(dir, spec)
		out.add(resolved)
	}
	return out
}

function updateImportGraph(fromAbs, newDeps) {
	const old = _imports.get(fromAbs)
	if (old) {
		for (const d of old) {
			if (newDeps.has(d)) continue
			const set = _importers.get(d)
			if (set) { set.delete(fromAbs); if (!set.size) _importers.delete(d) }
		}
	}
	for (const d of newDeps) {
		let set = _importers.get(d)
		if (!set) { set = new Set(); _importers.set(d, set) }
		set.add(fromAbs)
	}
	_imports.set(fromAbs, newDeps)
}

function transitiveImporters(absFile) {
	const out = new Set()
	const stack = [absFile]
	while (stack.length) {
		const cur = stack.pop()
		const ups = _importers.get(cur)
		if (!ups) continue
		for (const u of ups) if (!out.has(u)) { out.add(u); stack.push(u) }
	}
	return out
}

// Imba compiles tag render-cache slots as anonymous local Symbols at module top
// level: `var $4 = Symbol(), $11 = Symbol(), ...; let c$0 = Symbol();`. Each
// re-import of the file creates fresh Symbol objects, so old slot data on live
// element instances no longer matches the new render's keys, and imba's diff
// can't reuse cached children — it appends new ones, causing duplication.
//
// We rewrite each `<name> = Symbol()` clause so that the Symbol is read from a
// per-file global cache, keyed by the variable name. On the first compilation
// the cache is populated; on every subsequent compilation the same Symbol
// objects are reused, slot keys stay stable, and imba's renderer happily
// diff-updates existing DOM in place.
//
// Caveat: stability is keyed by name. If the user adds/removes elements in the
// template, slot indices shift and the same name now points to a semantically
// different slot. We detect this by counting slots — if the count changes vs
// the previous compilation, we mark the file `slots: 'shifted'` and the client
// falls back to the destructive wipe-and-render path. Pure CSS/text edits keep
// counts unchanged → true in-place HMR.
function stabilizeSymbols(js, filepath) {
	let count = 0
	const out = js.replace(
		/([A-Za-z_$][\w$]*)\s*=\s*Symbol\(\)/g,
		(_m, name) => { count++; return `${name} = (__bsyms__[${JSON.stringify(name)}] ||= Symbol())` }
	)
	if (count === 0) return { js, slotCount: 0 }
	const fileKey = JSON.stringify(filepath)
	const bootstrap = `const __bsyms__ = ((globalThis.__bimba_syms ||= {})[${fileKey}] ||= {});\n`
	return { js: bootstrap + out, slotCount: count }
}

async function compileFile(filepath) {
	const abs = path.resolve(filepath)
	const file = Bun.file(filepath)
	const stat = await file.stat()
	const mtime = stat.mtime.getTime()

	const cached = _compileCache.get(abs)
	if (cached && cached.mtime === mtime) return { ...cached.result, changeType: 'cached', slots: cached.slots }

	const code = await file.text()
	const result = compiler.compile(code, {
		sourcePath: filepath,
		platform: 'browser',
		sourcemap: 'inline',
	})

	if (!result.errors?.length && result.js) {
		const { js, slotCount } = stabilizeSymbols(result.js, filepath)
		result.js = js
		const prev = _prevSlots.get(filepath)
		result.slots = (prev === undefined || prev === slotCount) ? 'stable' : 'shifted'
		_prevSlots.set(filepath, slotCount)
		updateImportGraph(abs, extractImports(js, abs))
	}

	const changeType = _prevJs.get(abs) === result.js ? 'none' : 'full'
	_prevJs.set(abs, result.js)
	_compileCache.set(abs, { mtime, result, slots: result.slots })
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
			broadcast({ type: 'update', file: rel, slots: out.slots || 'shifted' })

			// Cascade: re-import every module transitively importing this file.
			// They don't need recompilation (their source didn't change), but
			// their captured references to the changed module are stale, so we
			// tell the client to re-import them. The client's HMR queue
			// processes these in order; tag classes get re-patched, plain
			// utility modules get fresh top-level state.
			const ups = transitiveImporters(path.resolve(filepath))
			for (const upAbs of ups) {
				const upRel = path.relative('.', upAbs).replaceAll('\\', '/')
				const cached = _compileCache.get(upAbs)
				const slots = cached?.slots || 'shifted'
				broadcast({ type: 'update', file: upRel, slots })
			}
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
