# Bimba Internals: How Imba Rendering Works and How Bimba HMR Hooks Into It

Technical reference for debugging and extending bimba's dev server (`serve.js`).

---

## 1. How Imba Compiles Tags to JS

Imba source:
```imba
tag my-popup
    name = ''

    def mount
        name = 'hello'

    <self @click.self=(emit('close'))>
        <div.dialog>
            <span.title> "Settings"
            if condition
                <img src=url>
            else
                <span.placeholder> "?"
            <button @click=save> "Save"
```

Compiled JS (simplified):
```js
import { Component, defineTag, createElement, createComponent, ... } from 'imba';
const $beforeReconcile$ = Symbol.for('#beforeReconcile');
const $afterVisit$ = Symbol.for('#afterVisit');
const $placeChild$ = Symbol.for('#placeChild');
const $$up$ = Symbol.for('##up');

// Anonymous Symbols — one per DOM slot in the render tree.
// These are the RENDER CACHE KEYS.
var $7 = Symbol(), $11 = Symbol(), $13 = Symbol(), $19 = Symbol(), $24 = Symbol(), ...;
let c$0 = Symbol(); // class identity symbol

class MyPopupComponent extends Component {
    [__init__$]($$ = null) {
        super[__init__$](...arguments);
        this.name = ($$ && $$.name !== undefined) ? $$.name : '';
    }

    mount() { this.name = 'hello'; }

    render() {
        var $4, $5, $6, $8 = this._ns_ || '', $9, $18, ...;
        $4 = this;                          // $4 = the element itself
        $4[$beforeReconcile$]();

        // ── "First render" check ──
        // $7 is a Symbol. this[$7] is stored on the INSTANCE.
        // First render: this[$7] is undefined → $5=0 (CREATE mode)
        // Re-render:   this[$7] === 1        → $5=1 (REUSE mode)
        ($5=$6=1, $4[$7] === 1) || ($5=$6=0, $4[$7] = 1);

        // ── Static children: created only on first render ($5=0) ──
        $5 || ($4.on$('click', {self: true, ...}));
        $5 || ($9 = createElement('div', $4, `dialog ${$8}`, null));
        //       ↑ createElement appends $9 as child of $4

        // ── Cached children: checked on every render ──
        ($10 = $4[$11]) || ($4[$11] = $10 = createElement('span', $9, ...));
        //  ↑ try cache          ↑ miss → create and cache

        // ── Conditional blocks ──
        $18 = null;
        if (this.condition) {
            ($20=$21=1, $18=$4[$19]) || ($20=$21=0, $4[$19]=$18=createElement('img',...));
        } else {
            ($25=$26=1, $18=$4[$24]) || ($25=$26=0, $4[$24]=$18=createElement('span',...));
        }
        // placeChild manages which branch is in the DOM
        ($4[$30] = $16[$placeChild$]($18, 0, $4[$30]));

        $4[$afterReconcile$]($6);
        return $4;
    }

    // Static block runs at class definition time
    static {
        register$(this, c$0, 'my-popup', 2);    // → calls customElements.define
        defineTag('my-popup', this, {cssns: 'z1abc_xy', cssid: 'z1abc-xy'});
    }
}

// CSS is registered as a global stylesheet
imba_styles.register('z1abc', "...");
```

### Key points

| Concept | Details |
|---------|---------|
| **Render cache** | Each DOM node is cached on the element instance under an anonymous `Symbol()` key. `this[$sym] \|\| (this[$sym] = createElement(...))`. |
| **Create vs Reuse** | `this[$7] === 1` is the master flag. `$5=0` = first render (create all), `$5=1` = re-render (reuse cached). |
| **Static children** | Guarded by `$5 \|\| (...)` — created only on first render, never recreated. |
| **Conditional children** | Each branch has its own cache slot (`$19` for `if`, `$24` for `else`). `$placeChild$` swaps them in/out. |
| **CSS namespace** | `_ns_` on prototype (e.g. `"z1abc_xy "`). Used as className prefix. Hash changes when CSS content changes. |
| **Tag registration** | `register$` → `customElements.define()`. `defineTag` → sets `_ns_`, `cssid`, registers in Imba's internal tag registry (`J[name]`, `xh[name]`). |
| **Lifecycle** | `__init__$` (property defaults), `connectedCallback` (DOM attachment), `mount` (post-connect, user code), `render` (DOM creation/update). |

### Imba runtime functions

| Function | What it does |
|----------|-------------|
| `createElement(tag, parent, className, text)` | `document.createElement` + `parent[appendChild$](el)`. For plain HTML elements. |
| `createComponent(name, parent, className, text)` | Same but for custom elements. If `name` is a string, uses `document.createElement(name)`. |
| `imba_styles.register(id, css)` | Injects/updates a `<style>` element in `<head>`. Idempotent by `id`. |
| `defineTag(name, klass, opts)` | Registers tag in Imba's internal registry. Sets `_ns_`, `cssid`, `flags$ns` on prototype. |
| `register$(klass, symbol, name, flags)` | Sets up class metadata (`__meta__$`), calls `customElements.define`. |
| `imba.commit()` | Schedules a render tick via `requestAnimationFrame`. All scheduled components re-render. |
| `$beforeReconcile$` | Called at start of render. Clears internal child tracking state. |
| `$afterReconcile$` | Called at end of render. Finalizes child list. |
| `$placeChild$(child, type, prev)` | Manages conditional/dynamic child placement. Inserts/removes/replaces nodes. |
| `$afterVisit$(flag)` | Post-render hook on a component child. Triggers its own render if needed. |

---

## 2. The Problem Bimba Solves

Browsers have no built-in HMR for custom elements:
- `customElements.define(name, class)` can only be called ONCE per tag name
- Re-importing a module creates fresh `Symbol()` instances — old cache keys become orphans
- Without intervention, re-importing causes full duplication of DOM children

---

## 3. How Bimba's HMR Works

### 3.1 Symbol Stabilization (server-side)

**Problem:** Each `var $7 = Symbol()` creates a unique symbol. Re-importing the module creates a NEW `$7` symbol. Existing elements have DOM cached under the OLD `$7`. The new render method looks up `this[NEW_$7]` — not found → creates duplicate DOM.

**Solution:** Rewrite `Symbol()` calls to use a persistent global cache:

```
$7 = Symbol()
  ↓
$7 = (__bsyms__["$7"] ||= Symbol())
```

Where `__bsyms__` is keyed by absolute file path:
```js
const __bsyms__ = ((globalThis.__bimba_syms ||= {})["/abs/path/to/file.imba"] ||= {});
```

First load: creates symbols, stores in cache.
HMR reload: reuses same symbols from cache → render finds cached DOM → REUSE mode.

**Critical:** The file path key MUST be normalized (absolute via `path.resolve`). Different string representations of the same file (e.g., `./src/foo.imba` vs `src/foo.imba`) produce different cache keys → different symbols → duplication. This was the root cause of the v0.7.8 fix.

### 3.2 Slot Stability Detection

If the user adds/removes template elements, the number of `Symbol()` declarations changes. Variable names shift (`$7` now means a different DOM slot). Even with stable symbols, the SEMANTICS change.

Detection: count `Symbol()` calls per file. Compare to previous compilation:
- Same count → `slots: 'stable'`
- Different count → `slots: 'shifted'`

These are diagnostic hints, not proof that the render cache can be reused. The client always rebuilds the affected inner DOM (see 3.5).

### 3.3 Prototype Patching (browser-side)

`customElements.define` is hooked:

```
First call (page load):  register normally, save class in _classes map
Repeat calls (HMR):      _patchClass(originalClass, newClass)
```

`_patchClass` copies ALL own property descriptors (string + symbol keys) from the new class prototype to the original class prototype, skipping `constructor`. Also copies static properties (skipping `length`, `name`, `prototype`, `caller`, `arguments`).

Effect: all existing element instances immediately get new methods via the prototype chain. No need to recreate elements.

### 3.4 CSS Namespace Sync

Imba exposes scoped CSS through `_ns_` and root CSS classes through `flags$ns`. The current runtime sets this metadata in `defineTag` before custom-element registration; older versions used a different order. Bimba saves the previous values before patching and synchronizes both fields after the module finishes loading.

Existing DOM elements also need their classes updated: adding the first `css self` rule does not rerun the constructor that initially installs `flags$ns`. Bimba adds/removes these tokens while preserving application classes. Subclasses can have their own copies of inherited CSS metadata, so those copies are updated too.

### 3.5 Always-Destructive HMR

> **History:** Earlier versions (≤0.7.8) had two paths — "stable" (in-place
> prototype patching + `imba.commit()`) and "shifted" (destructive wipe +
> re-render). The stable path was meant to preserve DOM state (inputs, focus,
> popups) when only CSS or logic changed without adding/removing template
> elements. However, it fundamentally didn't work: imba's reconciliation uses
> slot-tracking symbols (`this[$sym] === 1`) to skip re-creating elements on
> re-render. Even when `_patchClass` installs a new `render()` method, calling
> `render()` (or `imba.commit()`) does nothing — the slot check says "already
> created" and skips `createElement`. Static text, attributes, and other
> arguments baked into `createElement` calls never update.
>
> Since 0.7.9, bimba always takes the destructive path.

The `slots` field is still computed and broadcast (for potential future use),
but the client ignores it. Every HMR update does:

1. `_patchClass` updates prototype (during import)
2. CSS metadata and classes are synced
3. For existing instances of affected tags and their subclasses, in DOM order:
   - Skip descendants already replaced by an affected parent
   - Remove listeners installed on the retained element during its previous render
   - Delete all anonymous Symbol properties (render cache) — skip `Symbol.for(...)` ones
   - `innerHTML = ''` — wipe DOM; the browser disconnects descendants once
   - `el.render()` — rebuild DOM from scratch with new render method
4. `imba.commit()` for final sync

The retained element's fields and mount-installed listeners stay in place. Do not manually invoke `connectedCallback`, `mount`, or `remount`: the element has not moved or disconnected. In Imba 2.0.0-alpha.253, the default `remount()` calls `mount()`, so substituting it would still duplicate subscriptions. Render failures propagate to the reload fallback.

**Trade-off:** Input focus, scroll position, and popup state are lost on every
edit. This is acceptable because correctness beats convenience — a "stable"
update that silently ignores the change is far more confusing than losing
transient UI state.

### 3.6 Entrypoint and Update Delivery

Entrypoint edits trigger a full page reload before re-importing any bootstrap code. This avoids repeated mounts and application subscriptions. Component modules should not bootstrap the application. The legacy body-child deduplication remains for other modules, but cannot undo arbitrary module side effects. It runs immediately after import, before rendering: running it after rendering mistakenly removes replacement `<global>` portals with the same tag name as their previous body content.

The compile cache and delivered-update baseline are separate. HTTP requests and error reconciliation may compile a saved file before the watcher's debounce expires. They must not advance `_prevJs` after its initial baseline; only publishing an update does that. Otherwise the watcher sees a cache hit and silently skips an edit still needed by connected browsers. The watcher also rechecks its version after asynchronous error reconciliation.

`tests/serve-hmr.test.js` exercises the injected client with native event dispatch and a small DOM model, plus real Bun HTTP/WebSocket/watch integration. Browser verification should additionally cover repeated sidebar edits, self handlers, inherited templates, and adding/removing `css self`.

---

## 4. Server Architecture

```
serve.js
├── HMR Client (injected as <script> into HTML)
│   ├── customElements.define hook
│   ├── _patchClass / _copyDescriptors
│   ├── _doUpdate (stable/shifted paths)
│   ├── WebSocket connection
│   └── Error overlay
│
├── Symbol Stabilization
│   ├── stabilizeSymbols(js, absPath)
│   └── Slot count tracking (_prevSlots)
│
├── Compiler
│   ├── compileFile(filepath) — compile + stabilize + cache
│   ├── _compileCache (abs path → {mtime, result})
│   └── _prevJs (abs path → js string, for change detection)
│
├── Local Source Modules
│   ├── *.imba → compileFile() + symbol stabilization
│   ├── *.ts / *.tsx → Bun.Transpiler → browser ESM
│   └── *.js / *.mjs → bare-import rewriting
│
├── File Watcher
│   ├── *.imba → compile → component HMR update
│   └── *.ts / *.tsx / *.js / *.mjs → full-page reload
│
├── HTTP Server
│   ├── / → HTML with injected entrypoint + HMR client
│   ├── *.imba → compile on demand → serve as JS
│   ├── *.ts / *.tsx → transpile on demand → serve as JS
│   ├── *.css → wrap as JS module (style injection)
│   ├── /__bimba_vendor__/* → bundle package through Bun
│   ├── /node_modules/* → resolve and bundle through Bun
│   └── Static files (htmlDir, then root)
│
└── Module Resolution
    ├── bare specifier → /__bimba_vendor__/*
    └── Extension fallback (.imba → .ts → .tsx → .js → .mjs)
```

---

## 5. Common Pitfalls and Debugging

### Symptom: Elements duplicate on first edit, not on second
**Cause:** Symbol cache key mismatch between initial load and HMR. Check that `stabilizeSymbols` receives the same file path from both the HTTP handler and the file watcher. Must use `path.resolve()` for normalization.

### Symptom: CSS changes don't apply after HMR
**Cause:** `_ns_` not synced. Check the `_nsPatches` logic — `defineTag` sets `_ns_` AFTER `register$`, so `_patchClass` misses it. The post-import sync block must handle this.

### Symptom: Methods don't update after HMR
**Cause:** `_patchClass` might not be running. Check that `customElements.get(name)` returns the existing class. Verify the hook on `customElements.define` is active.

### Symptom: State lost on edit (inputs clear, popups close)
**Cause:** Taking the shifted path when stable would suffice. Check slot count — adding a comment or whitespace shouldn't change `Symbol()` count. If it does, the stabilization regex might be too broad/narrow.

### Symptom: 500 errors on node_modules subpaths
**Cause:** `serveResolved` trying `.imba` extension without existence check. The `.imba` path calls `compileFile()` which throws on non-existent files.

### Debugging approach
Add to HMR client `_doUpdate`:
```js
console.log('[bimba]', file, 'slots=' + slots, 'tags:', collected);
```
Check `globalThis.__bimba_syms` in browser console — keys should be absolute paths, values should be objects with `$7`, `$11`, etc. If you see two entries for the same file with different path formats, that's the symbol mismatch bug.
