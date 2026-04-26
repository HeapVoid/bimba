This tool helps to work with [Imba](https://imba.io) projects under [Bun](https://bun.sh). That is why it is called Bun+IMBA = BIMBA 😉

It includes the plugin for Bun to compile .imba files and also the CLI tool for building .imba files, since the plugins can't be passed to Bun via shell command `bun build`.

First of all install this tool like any other npm package:
```bash
bun add bimba-cli -d
```

---

## Backend development

To run an .imba file in Bun's environment, create a `bunfig.toml` file in the root folder of your project:
```toml
preload = ["bimba-cli/plugin.js"]
```

Then use the usual Bun syntax:
```bash
bun run src/index.imba
bun --watch run src/index.imba
```

---

## Frontend development

### Dev server (HMR)

bimba includes a dev server with Hot Module Replacement for Imba custom elements:

```bash
bunx bimba src/index.imba --serve --port 5200 --html public/index.html
```

**How it works:**
- Serves your HTML file and compiles `.imba` files on demand (no bundling step)
- Watches `src/` for changes and pushes updates over WebSocket
- Rewrites bare package imports in served JS modules to `__bimba_vendor__/*` URLs
- CSS files imported from JS (e.g. `import 'some-lib/styles.css'`) are automatically wrapped as JS modules that inject `<style>` tags
- npm packages are bundled on demand by Bun (`target: "browser"`), so Bun owns `exports`, `browser`, CommonJS interop, and nested dependency resolution
- Injects an HMR client that swaps component prototypes without a full page reload

**HMR internals:**

When a file changes, the server recompiles it and sends an `update` message over WebSocket. The browser re-imports the module with a fresh `?t=` cache-bust query.

Since Imba custom elements can't be registered twice (`customElements.define` throws on duplicates), bimba intercepts all `define` calls. On first load the class is registered normally and stored in a map. On hot reload, instead of registering again, bimba copies all methods and static properties from the new class onto the original class prototype — so existing element instances in the DOM immediately get the new `render()` and other methods without losing their state (`el.active`, `el.count`, etc.).

After patching, bimba clears each element's Imba render cache (anonymous `Symbol` keys pointing to DOM nodes) and sets `innerHTML = ''`, so the new render method starts from a clean slate. Then `imba.commit()` triggers a re-render of all mounted components.

CSS is handled automatically: Imba's runtime calls `imba_styles.register()` during module execution, which updates the `<style>` tag in place — no extra DOM work needed. CSS files from npm packages (e.g. `import 'pkg/styles.css'`) are served as JS modules that inject and update `<style>` tags.

Duplicate root elements (caused by `imba.mount()` running again on re-import) are removed by a dedup pass over `document.body.children` before any other HMR logic runs.

**Smart HMR:** bimba detects whether a change affects the template structure (adding/removing elements) or just CSS/logic. CSS-only and logic-only changes patch prototypes in place without wiping innerHTML — preserving input focus, scroll position, and open popups. Template-structural changes do a full wipe-and-rerender to ensure correctness.

For a deep dive into how Imba compiles tags, how the render cache works, and how bimba hooks into it — see [INTERNALS.md](INTERNALS.md).

**HTML setup:** add a `data-entrypoint` attribute to the script tag that loads your bundle. The dev server will replace it with your `.imba` entrypoint and remove existing import maps, since package imports are rewritten in served modules instead:

```html
<script type='module' src="./js/index.js" data-entrypoint></script>
```

**Dev server flags:**

`--serve` — start dev server instead of bundling

`--port <number>` — port to listen on (default: `5200`)

`--html <path>` — path to your HTML file (auto-detected from `./index.html`, `./public/index.html`, `./src/index.html` if omitted)

Static files are resolved relative to the HTML file's directory first, then from the project root (for `node_modules`, `src`, etc.). Extensionless imports are resolved by trying `.imba`, `.js`, and `.mjs` extensions automatically.

**npm package resolution:** The dev server scans each served JS module and rewrites bare imports such as `imba/runtime`, `@scope/pkg`, and `pkg/subpath` to `__bimba_vendor__/*` URLs. Those vendor URLs are bundled on demand with Bun (`target: "browser"`). Imba source files still compile separately for HMR, while Bun owns dependency resolution, `exports`, `browser` fields, nested `node_modules`, and CommonJS interop.

---

### Production bundle

To compile and bundle your source code from .imba to .js:
```bash
bunx bimba src/index.imba --outdir public/js
```

With watch:
```bash
bunx bimba src/index.imba --outdir public/js --watch --clearcache
```

### TypeScript diagnostics for Imba files

To check TypeScript diagnostics reported by the Imba language-service plugin:
```bash
bunx bimba --typecheck
```

By default this scans `src/` when it exists, otherwise the project root. You can also pass a specific file or folder:
```bash
bunx bimba src/index.imba --typecheck
bunx bimba src --typecheck
```

This mode requires `typescript` in the project and `typescript-imba-plugin` either in `node_modules` or in an installed Imba editor extension.

---

### All CLI flags

`--outdir <path>` — output folder for compiled JS (required in bundle mode)

`--watch` — watch the entrypoint directory for changes and rebuild. Keep the entrypoint in a subfolder (e.g. `src/`), otherwise cache updates will trigger extra rebuilds.

`--clearcache` — delete the cache directory on exit (Ctrl+C). Works only in watch mode.

`--no-minify` — disable minification. Bundle mode minifies by default.

`--sourcemap <inline|external|none>` — how to include source maps in the output (default: `none`).

`--target <browser|node>` — platform flag passed to the Imba compiler (default: `browser`). The `node` value does not work under Bun.

`--typecheck` — check TypeScript diagnostics in `.imba` files using `tsserver` and `typescript-imba-plugin`.

`--tscheck` — alias for `--typecheck`.

`--serve` — start dev server with HMR instead of bundling.

`--port <number>` — port for the dev server (default: `5200`). Used with `--serve`.

`--html <path>` — custom HTML file path. Used with `--serve`.
