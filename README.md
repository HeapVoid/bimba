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
- Injects an importmap built from your `package.json` dependencies
- Injects an HMR client that swaps component prototypes without a full page reload

**HTML setup:** add a `data-entrypoint` attribute to the script tag that loads your bundle. The dev server will replace it with your `.imba` entrypoint and inject the importmap above it:

```html
<script type='module' src="./js/index.js" data-entrypoint></script>
```

**Dev server flags:**

`--serve` — start dev server instead of bundling

`--port <number>` — port to listen on (default: `5200`)

`--html <path>` — path to your HTML file (auto-detected from `./index.html`, `./public/index.html`, `./src/index.html` if omitted)

Static files are resolved relative to the HTML file's directory first, then from the project root (for `node_modules`, `src`, etc.).

---

### Production bundle

To compile and bundle your source code from .imba to .js:
```bash
bunx bimba src/index.imba --outdir public/js --minify
```

With watch:
```bash
bunx bimba src/index.imba --outdir public/js --watch --clearcache
```

---

### All CLI flags

`--outdir <path>` — output folder for compiled JS (required in bundle mode)

`--watch` — watch the entrypoint directory for changes and rebuild. Keep the entrypoint in a subfolder (e.g. `src/`), otherwise cache updates will trigger extra rebuilds.

`--clearcache` — delete the cache directory on exit (Ctrl+C). Works only in watch mode.

`--minify` — minify the output JS. Enabled by default in bundle mode.

`--sourcemap <inline|external|none>` — how to include source maps in the output (default: `none`).

`--target <browser|node>` — platform flag passed to the Imba compiler (default: `browser`). The `node` value does not work under Bun.

`--serve` — start dev server with HMR instead of bundling.

`--port <number>` — port for the dev server (default: `5200`). Used with `--serve`.

`--html <path>` — custom HTML file path. Used with `--serve`.
