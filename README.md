This tool helps to work with [Imba](https://imba.io) projects under [Bun](https://bun.sh). That is why it is called Bun+IMBA = BIMBA 😉

It includes the plugin for Bun to compile .imba files and also the CLI tool for building .imba files, since the plugins can't be passed to Bun via shell command `bun build`.

First of all install this tool like any other npm package:
```bash
bun add bimba-cli -d
```

## Runtime compatibility and integration

Bimba 0.7.51 requires Bun 1.3.6 or newer. Bun 1.4.3 is recommended and is
pinned in the release workflow, but upgrading to it is required only for the
new native `--check` option. Bimba uses the Bun installed in the consuming
project's environment; installing or updating `bimba-cli` does not install,
bundle, or upgrade Bun.

| Operation | Bun version | Type-checking engine |
| --- | --- | --- |
| Normal bundle or `--serve` HMR | 1.3.6+ | No native Bun type-check gate |
| Bundle with `--check` | 1.4.3+ | Bun's built-in TypeScript checker |
| `--typecheck` / `--tscheck` | 1.3.6+ | Project TypeScript + `typescript-imba-plugin` for original Imba sources |
| `--frontend-check` or background `--frontend` | 1.3.6+ | The same Imba checker with shared compilation and diagnostic coverage |

Bun owns the runtime, package resolution, bundler, TypeScript transpilation,
HTTP server and WebSockets. Bimba owns Imba compilation, source diagnostics,
compilation caches and component-preserving HMR. Vendor wrappers now use
Bun's in-memory `Bun.build({ files })` API by default; this API was introduced
in Bun 1.3.6 and works without the new native type checker.

### Guidance for coding agents

- Read the project's scripts and check `bun --version` before choosing a
  command. Existing builds on older supported Bun versions continue to work.
- Use `--check` explicitly for native checking during bundling. It cannot be
  combined with `--serve`, `--typecheck`, or `--frontend-check`; on Bun older
  than 1.4.3 it fails with an upgrade message instead of silently skipping.
- For original `.imba` diagnostics, use `--typecheck` with selected files or
  directories, or the project's `--frontend-check` workflow. Bun's checker
  sees compiled JavaScript and does not load `typescript-imba-plugin`.
- Keep the project's TypeScript and Imba language-service plugin for Imba
  diagnostics. Bun's native checker is independent of that TypeScript
  version; installing newer Bun is not a reason to remove or upgrade them.

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
- Loads local `.cjs` modules through the same browser bundler used for npm packages; edits to their watched dependencies reload using tabs
- Preserves spaces, Unicode, `#`, `?` and `%` in local filenames through encoded module URLs
- Watches `src/` for changes and pushes updates over WebSocket
- Rewrites bare package imports in served JS modules to `__bimba_vendor__/*` URLs
- CSS files imported from JS (e.g. `import 'some-lib/styles.css'`) are automatically wrapped as JS modules that inject `<style>` tags
- npm packages are bundled on demand by Bun (`target: "browser"`), so Bun owns `exports`, `browser`, CommonJS interop, and nested dependency resolution
- Injects an HMR client that swaps component prototypes without a full page reload
- Applies updates only in tabs that loaded the changed module; unused files cause no import, render or reload
- Reloads using tabs when JavaScript in the entrypoint, shared TypeScript/JavaScript, or data-only Imba modules changes

**HMR internals:**

Imba compiles JavaScript and CSS separately in development (`hmr: true`, `styles: 'extern'`). The server compares executable JavaScript independently of CSS, comments, formatting and source maps.

Each tab tracks completed module executions and requested script/stylesheet URLs. Unused and not-yet-loaded lazy modules are ignored. Failed initial imports are remembered so fixing them can reload the incomplete module graph. Reload notices identify the changed file and its served URL aliases, including extensionless imports. Reconnecting after a dev-server restart still reloads the page.

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

**npm package resolution:** The dev server scans each served JS module and rewrites bare imports such as `imba/runtime`, `@scope/pkg`, and `pkg/subpath` to `__bimba_vendor__/*` URLs. Those vendor URLs are bundled on demand with Bun (`target: "browser"`). Package wrappers use Bun's native in-memory `files` option, so serving packages does not create generated JS files in `node_modules`. Imba source files still compile separately for HMR, while Bun owns dependency resolution, `exports`, `browser` fields, nested `node_modules`, and CommonJS interop.

---

### Embedding the dev server

Applications can share Bimba's listener with their own HTTP endpoints:

```js
import { serve } from 'bimba-cli/serve.js';

const server = serve('src/page/app.imba', {
  port: 0,
  hostname: '127.0.0.1',
  html: 'public/index.html',
  watchRoot: 'src',
  imports: { 'project:previews': '/previews.js' },
  async fetch(request, server) {
    if (new URL(request.url).pathname === '/api/ready') {
      return Response.json({ ready: true });
    }
    // Return null or undefined to use Bimba's normal routes and WebSocket.
  },
});

console.log(server.url);
// On application shutdown: await server.stop(true);
```

`serve(entrypoint, options = {})` returns the `Bun.Server`. `port` defaults to
5200; zero asks Bun for a free port. `hostname` is passed to Bun. `html` retains
the CLI's automatic discovery when omitted. Filesystem paths and HTTP module
paths are relative to the process working directory unless registered below.

`watchRoot` selects the recursively watched source directory; its default is the
entrypoint directory. Include any local dependencies that should update in this
tree. `imports` injects an import map before the entrypoint. `fetch(request,
server)` may return a `Response` or a Promise; null/undefined delegates to Bimba.
The host owns its API and project configuration. Bimba owns module compilation,
vendor conversion, WebSocket updates and frontend watching. `server.stop()` also
closes Bimba's watcher and cancels pending frontend updates.

### Modules from another source root

`server.moduleUrl(filepath, root = process.cwd())` registers a local source root
and returns a stable, encoded browser URL for an existing file inside it. Hosts
can use the returned URLs in generated modules or import maps, including when
multiple projects contain the same relative filenames. Paths are resolved through
realpath; a file outside the declared root, including a symlink escape, is rejected.
Only roots registered on that server can be requested through these source URLs.
For the host root, existing local URLs are reused so imports from the entrypoint
and generated modules execute one shared module instance.

```js
const url = server.moduleUrl('/work/project/examples/plugin.ts', '/work/project');
// In a generated browser module:
const source = `export {default} from ${JSON.stringify(url)};`;
```

Mounted files use the normal Imba, JS/CommonJS, TypeScript and resource loaders.
Relative imports and CSS URLs stay within their registered root; npm imports use
the source project's browser exports, while Imba uses the host's shared runtime.
Registered roots are watched recursively, with the same HMR messages and module
URLs as local sources. Registration is idempotent; `server.stop()` closes all
additional watchers and clears source registrations. Hosts own which roots to
expose and which modules to list. This API carries no project configuration or
application-specific preview behavior.

### Resource imports

Local JavaScript, TypeScript and Imba can import JSON, stylesheets and files
without application-specific HTTP adapters. Relative resource imports receive
an `?import` module URL automatically; direct script requests use the same
contract. A normal request without that query returns the original file and MIME
type. JSON modules expose Bun's default and named exports. Other non-source files
(images, fonts, documents and custom extensions) export their encoded public URL.

CSS imports load one shared `<link rel="stylesheet">` per file and await its load.
This keeps `@import`, images and font URLs relative to the original stylesheet.
The same loader handles CSS package exports and CSS imported by JavaScript
packages; Bun still owns browser-condition and package resolution. Symlinked
dependencies outside the checkout receive a package-scoped resource address.
Stylesheet failures reject module loading. Native CSS HMR refreshes linked styles,
including nested CSS imports; watched JSON and file changes reload using tabs.

### Production bundle

To compile and bundle your source code from .imba to .js:
```bash
bunx bimba src/index.imba --outdir public/js
```

With watch:
```bash
bunx bimba src/index.imba --outdir public/js --watch --clearcache
```

### Automatic tag dependencies (opt-in prototype)

The browser build plugin can discover dependencies of selected lazy Imba
modules without a handwritten tag-to-file mapping:

Projects can enable it through the CLI:

```sh
bunx bimba src/index.imba --outdir public/js --splitting --auto-tags
```

`--splitting` controls Bun's code splitting; `--auto-tags` supplies the missing
tag dependencies. The flag is opt-in. Without configuration it indexes `src/`
(or the entrypoint directory if there is no `src/`) and discovers lazy boundaries
from literal relative `import('./page.imba')` expressions in Imba modules.
The shell retains its lazy imports. The CLI prints the discovered dependency
manifest and writes outputs only after the inventory has passed validation.

To include tags outside that directory, configure the existing project manifest:

```json
{
  "bimba": {
    "tags": {
      "roots": ["src", "components"]
    }
  }
}
```

The configuration does not activate the mode by itself. Use `--auto-tags` in the
project's build script, or `--no-auto-tags` to disable it. `entries` can optionally
select explicit module paths when lazy imports are computed or originate in JS;
this selection is the project's loading contract. `external` lists tags supplied
by an existing loader or outside the indexed source tree and keeps that contract.

The CLI currently rejects `--watch`, `--serve`, type-checking modes, non-browser
targets and source maps with `--auto-tags`. Ordinary builds and HMR are unchanged.
This mode is tested with Bun 1.4.3 and Imba 2.0.0-alpha.253.

For the public Bun build plugin:

```js
import { ImbaPlugin } from 'bimba-cli/compile-cache.js';
import { IMBA_RUNTIME_DEFINES } from 'bimba-cli/utils.js';

const plugin = new ImbaPlugin(undefined, {
  tags: {
    roots: ['src'],
  },
});
const result = await Bun.build({
  entrypoints: ['src/index.imba'],
  target: 'browser', splitting: true, define: IMBA_RUNTIME_DEFINES,
  plugins: [plugin],
});
console.log(plugin.tags.dependencies);
```

`roots` is the source inventory. Without `entries`, literal relative lazy imports
in Imba select the modules to link. An explicit `entries` array selects the modules
whose static dependency closure may be linked automatically. Keep `import()` in the shell
to declare the lazy boundary. A tag reference in that shell does not create an
eager import. Every dependency is discovered from compiler tokens and the AST
of generated JavaScript, including results restored from the compilation cache.
Only reached modules are compiled; unrelated declarations in `roots` are indexed
without adding their code to the build.

Selected modules receive ordinary named ESM imports and internal constructor
exports. Custom tag inheritance uses an imported class instead of looking up
its superclass in the runtime registry. Nested component references create the
same value dependencies, recursively. Existing explicit static imports remain
part of the closure when they are relative `.imba` imports; dynamic imports retain
their own boundaries. Bundling and
browser ESM evaluation own loading, deduplication and execution order.

Missing or ambiguous owners and module cycles involving a superclass reject the
build with source paths, including cycles closed by rendering or static imports.
Render-only cycles retain live ESM bindings. Every
build refreshes the index, including sequential reuse of a plugin instance;
a changed source, added or removed source file during
linking rejects that snapshot, including declarations not emitted into the bundle.
An optional `external: ['package-owned-tag']` declares tags supplied outside the
indexed sources, whose existing loading contract remains the caller's concern.

An inferred static dependency on a module also selected by a literal `import()`
rejects the build: it could silently move an action dialog into its catalogue's
initial code. An explicit static import declares that this eager dependency is
intentional. If an existing loader already awaits the dialog, put its supplied
tag in `external`; the dialog remains independently linked and loaded. The
linker does not infer the meaning of arbitrary async application operations.

This prototype covers top-level global tags containing a hyphen and literal
tag references emitted by the current Imba compiler. Runtime-computed tag names
are rejected in linked modules: use literal tags or directly imported constructors
(including PascalCase tags) so their module ownership is explicit.
HMR, route declaration generation and source-map rewriting
are not integrated yet. Use the default compiler options and no bundle source maps.
When using the public plugin, discard outputs if Bun reports a failure; the CLI
does this before writing them.

The focused regression matrix is `tests/tag-dependencies.test.js` and
`tests/auto-tags-cli.test.js`: recursive components and bases, two lazy pages
sharing one provider, static imports, render cycles, unsafe superclass cycles,
colocated order, native HTML/SVG, duplicate/missing/ambiguous declarations,
literal dynamic templates, imported constructors, conditional registration,
source and inventory changes, preserved action boundaries, reused plugins, name
collisions, external loading, CLI configuration and unsupported modes.

These checks validate supported Imba tag ownership and generated imports. They
do not ensure that a server still retains a chunk referenced by an old browser
tab, that the network delivers it, or that a component's own initialization succeeds.
A failed `import()` must reach the application's existing load-error and
document-reload flow; failed module evaluation is not a reliable same-document retry.
An open tab referencing a removed chunk can recover through a hard document reload.

### Native Bun type checking during bundling

With Bun 1.4.3 or newer, add `--check` to use Bun's built-in type checker:

```bash
bunx bimba src/index.imba --outdir public/js --check
```

Bimba passes `check: true` to `Bun.build`. Bun checks the modules read by the
bundler, including `.ts`/`.tsx` imported from Imba, and fails before writing
output when it finds a type error. `--watch --check` repeats the check on each
rebuild. Normal builds and HMR retain their existing fast iteration behavior;
`--check` applies to bundle mode only.

This does not replace Imba source diagnostics below. Bun sees the JavaScript
produced by the Imba build plugin and does not load TypeScript language-service
plugins. Use `--typecheck` or `--frontend-check` to check the original `.imba`
sources. Bun's checker follows TypeScript 7 semantics independently of the
project's installed TypeScript version: old options such as `baseUrl` may need
migration, and ambient packages must be listed explicitly in
`compilerOptions.types` (for example, `["bun"]` with `@types/bun` installed).
See [Bun type checking](https://bun.com/docs/runtime/check).

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

When `bimba --serve` is running, Bimba starts and warms a project TypeScript server alongside the dev server. File, directory, and full-project checks reuse its type graph. Bimba synchronizes changed Imba sources before requesting diagnostics and stops the TypeScript server when the dev server exits. Without a dev server, checks use a fresh TypeScript session. Checks in CI always use a fresh session. Set `BIMBA_NO_TYPECHECK_DAEMON=1` to force a fresh session while the dev server is running. Set `BIMBA_PROFILE_TYPECHECK=1` to print timings for each phase. The resident TypeScript server holds the project type graph in memory while the dev server is running.

Selected files open in one TypeScript `updateOpen` request. Project membership is
still validated for every file; project-info requests are pipelined without
inferring coverage from config patterns. The dev daemon tracks batch-opened
files in the same state used for dependency refresh and deletion.

### Reusing frontend work

Bimba owns one content cache for HMR, browser builds, model builds and syntax
checks. Keys include source bytes, the actual compiler bytes, compiler options
and source environment flags. Project-relative paths make CSS identifiers and
outputs reproducible across checkouts. Each file/variant keeps its latest
successful result; failed diagnostics or unrelated tests do not discard it.
Set `BIMBA_CACHE_DIR` to choose a cache location. The default is a project-name
namespace under `~/.cache/bimba/projects/` (unnamed projects use their real path).

Opt into development checks for any Imba frontend:

```bash
bimba src/index.imba --serve --frontend
bimba src --frontend-check
bimba src/panel.imba --frontend-check
bimba src --frontend-check --force
```

`--frontend` keeps HMR responsive while a background process checks saves using
the warm TypeScript server and primes the production compiler variant. Save
bursts coalesce. The resident TypeScript language service updates its affected type graph; complete
Imba diagnostic coverage also catches implicit tag/global consumers. The first
check establishes coverage. Subsequent exact snapshots reuse it. CSS-only
changes compare virtual TypeScript for the changed files only; an unsupported
plugin/configuration, changed types/imports/JS/dependencies, added/deleted files
or incomplete coverage request diagnostics. Failures and concurrent edits do
not publish success. Installed dependency bytes, external project files and
configuration are part of the snapshot. A file check cannot prove other files.

`--frontend-check` uses the same snapshot in development, CI and another
checkout. It does not run tests or bundle the app. Production bundling still
links/minifies current modules. `--force` bypasses compilation and diagnostic
reuse. Alternatively, `package.json` can opt in with `"bimba":{"frontend":true}`.
The background mode is opt-in and contains no application-specific behavior.

The public APIs are `CompilerCache`, `compileImba` and `ImbaPlugin` from
`bimba-cli/compile-cache.js`, and `FrontendProject` from
`bimba-cli/frontend-project.js`. They share the CLI's implementation.

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

`--splitting` — split dynamic imports and shared modules into chunks.

`--auto-tags` — automatically link lazy Imba tag dependencies; source roots can be
configured with `package.json` → `bimba.tags`. See the supported modes above.

`--sourcemap <inline|external|none>` — how to include source maps in the output (default: `none`).

`--target <browser|node>` — platform flag passed to the Imba compiler (default: `browser`). The `node` value does not work under Bun.

`--typecheck` — check TypeScript diagnostics in `.imba` files using `tsserver` and `typescript-imba-plugin`.

`--tscheck` — alias for `--typecheck`.

`--check` — use Bun's native type checker during bundling (requires Bun 1.4.3+); type errors prevent writing output. Use `--typecheck` for original Imba source diagnostics.

`--serve` — start dev server with HMR instead of bundling.

`--port <number>` — port for the dev server (default: `5200`). Used with `--serve`.

`--html <path>` — custom HTML file path. Used with `--serve`.
