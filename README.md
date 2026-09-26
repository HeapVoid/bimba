This tool helps to work with [Imba](https://imba.io) projects under [Bun](https://bun.sh). That is why it is called Bun+IMBA = BIMBA 😉

It includes the plugin for Bun to compile .imba files and also the CLI tool for building .imba files, since the plugins can't be passed to Bun via shell command `bun build`.

First of all install this tool like any other npm package:
```bash
bun add bimba-cli -d
```

---

## Backend development

To run an .imba file in Bun's environment, Bun needs the bimba preload plugin in `bunfig.toml`:
```toml
preload = ["bimba-cli/plugin.js"]
```

bimba creates this minimal `bunfig.toml` automatically when you run a bimba CLI command in a project that does not have one yet. If `bunfig.toml` already exists, bimba leaves it unchanged and prints the line to add manually.

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
- Transpiles local `.ts` and `.tsx` modules on demand through Bun
- Watches `src/` for changes and pushes updates over WebSocket
- Rewrites bare package imports in served JS modules to `__bimba_vendor__/*` URLs
- CSS files imported from JS (e.g. `import 'some-lib/styles.css'`) are automatically wrapped as JS modules that inject `<style>` tags
- npm packages are bundled on demand by Bun (`target: "browser"`), so Bun owns `exports`, `browser`, CommonJS interop, and nested dependency resolution
- Injects an HMR client that swaps component prototypes without a full page reload
- Reloads the page when JavaScript in the entrypoint, shared TypeScript/JavaScript, or data-only Imba modules changes

**HMR internals:**

Imba compiles JavaScript and CSS separately in development (`hmr: true`, `styles: 'extern'`). The server compares executable JavaScript independently of CSS, comments, formatting and source maps.

- **CSS edits:** update the existing stylesheet without importing the component module or rendering it again. Open popups, input values, focus, selection and scroll stay in place. This also covers first/last CSS rules, inline tag styles, global styles and CSS-only edits in the entrypoint. Local `.css` files in the watched source tree update their imported style node or stylesheet link.
- **Ordinary method edits:** patch component prototypes and rerender using the existing caches. DOM nodes and descendant state survive when templates and module-level code are unchanged.
- **Template edits:** rebuild only components whose render, named-element getter or tag-producing helper changed. An unchanged owner in the same file keeps its child references. Caller-owned slots and parent loop caches are preserved; descendants created by the changed template may be recreated.
- **Module-level code edits:** invalidate component templates conservatively so cached event closures cannot keep old module variables. JavaScript changes in the entrypoint, shared TypeScript/JavaScript, and Imba modules without components still reload the page. Component modules should keep application bootstrapping in the entrypoint.

Bimba intercepts repeated `customElements.define` calls and copies methods onto the original registered class. Fields on retained component instances survive. Compiler-generated cache Symbols, including Unicode identifiers, are stable across imports. Named DOM caches are made removable in development so template resets cannot append duplicate slot contents.

Template resets remove render-installed listeners and owned caches, then rebuild inner DOM. Mount-installed listeners remain; Bimba does not call `mount()`, `remount()` or `connectedCallback()` on retained components. Detached components reset stale templates on their next render. An HMR failure falls back to a page reload.

Run `bun test` for compiler classification, HTTP/WebSocket/watch integration, and tests with the real Imba compiler/runtime. The popup regression opens the popup once, applies repeated CSS edits, and checks exact DOM identities, input state, focus, selection and scroll without reopening it.

After upgrading bimba, restart the dev server and reload existing browser tabs once to load the updated HMR client and compiler output.

For a deep dive into how Imba compiles tags, how the render cache works, and how bimba hooks into it — see [INTERNALS.md](INTERNALS.md).

**HTML setup:** add a `data-entrypoint` attribute to the script tag that loads your bundle. The dev server will replace it with your `.imba` entrypoint and remove existing import maps, since package imports are rewritten in served modules instead:

```html
<script type='module' src="./js/index.js" data-entrypoint></script>
```

**Dev server flags:**

`--serve` — start dev server instead of bundling

`--port <number>` — port to listen on (default: `5200`)

`--html <path>` — path to your HTML file (auto-detected from `./index.html`, `./public/index.html`, `./src/index.html` if omitted)

Static files are resolved relative to the HTML file's directory first, then from the project root (for `node_modules`, `src`, etc.). Extensionless imports are resolved by trying `.imba`, `.ts`, `.tsx`, `.js`, and `.mjs` extensions automatically.

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

By default this scans `src/` when it exists, otherwise the project root. A file path checks exactly that file; a folder path checks its `.imba` files recursively. Pass several paths to check them in one TypeScript session:
```bash
bunx bimba src/index.imba --typecheck
bunx bimba src/chat/history.imba src/chat/panel.imba --typecheck
bunx bimba src --typecheck
```

The check still uses the project's TypeScript configuration and resolves imports;
the paths limit which Imba files receive direct diagnostics and syntax checks.

This mode requires `typescript` and `imba` in the project, and `typescript-imba-plugin` either in `node_modules` or in an installed Imba editor extension. The scanned files must be included in a real `tsconfig.json` or `jsconfig.json` (for example, `"include": ["src/**/*"]`). Files excluded from the project and unconfigured projects fail with an actionable error rather than silently passing.

The project Imba compiler checks syntax before TypeScript diagnostics. The CLI registers `.imba` before loading projects, waits for project initialization, and reports configuration errors and unexpected server exits directly. A successful result requires syntax, semantic, and suggestion diagnostic responses for every scanned file. If a project refresh interrupts a diagnostic batch, the CLI checks the remaining files within the same timeout. Run `bun test tests/typecheck.test.js` for the real compiler/tsserver regressions.

The TypeScript session timeout defaults to 120 seconds to accommodate larger projects. Set `BIMBA_TYPECHECK_TIMEOUT` (milliseconds) to override it.

### Releasing

The `publish.yml` workflow publishes a `v<package version>` tag from GitHub
Actions after installing locked dependencies and passing `bun test`. It uses
npm Trusted Publishing (OIDC), with no stored npm token. Configure the
`bimba-cli` trusted publisher on npmjs.com for GitHub repository
`HeapVoid/bimba`, workflow filename `publish.yml`, and allow direct
`npm publish`. The tag must match `package.json` exactly.

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
