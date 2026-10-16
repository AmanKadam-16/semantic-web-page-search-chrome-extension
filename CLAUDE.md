# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Semantic Ctrl+F: a Chrome MV3 extension that searches the current page by meaning using EmbeddingGemma 2 (`onnx-community/embeddinggemma-2-ONNX`, text-only) via Transformers.js, entirely on-device (WebGPU, falling back to WASM). There is no backend. The privacy promise ("page text never leaves the device") is a product decision; don't add cloud calls to the search path.

## Commands

```bash
npm run build   # esbuild -> dist/ (unpacked extension) and demo-dist/ (demo page)
npm run watch   # rebuild on change
npm run demo    # build, then serve demo-dist/ at http://localhost:5173 (also .claude/launch.json "demo")
npm test        # node test/engine.test.mjs: real model on CPU, ranking assertions at 768/512/256/128d
```

- There is no linter or test runner; `npm test` is a single script. The first run downloads about 175 MB of model weights.
- To try the real extension: run the build, then load `dist/` via chrome://extensions → Load unpacked. After rebuilding, reload the extension and the tab.
- `npm run build` deletes and recreates `dist/` and `demo-dist/`. Anything placed there by hand, such as benchmark pages, is wiped.

## Architecture

Three extension contexts, wired by messages:

- **`src/content.js`** is injected on demand by the background via `chrome.scripting` (toolbar click or the `_execute_action` command, using activeTab; there are no host permissions). It must be idempotent: the IIFE toggles `window.__semanticCtrlF` if it is already present. It owns:
  - DOM text extraction into passages, with boilerplate filters (MediaWiki refs/navboxes, link density, short `li` merging).
  - The shadow-DOM find bar, highlights, scrollbar ticks and the theme menu.
  - Persisted UI settings (`dim`, `theme`) in `chrome.storage.local`.

  Content scripts never receive embeddings, only ranked indices.
- **`src/background.js`** is the service worker. It creates the offscreen document and relays `{id, type, payload}` requests from the content script's long-lived port (`name: "sctrlf"`) to the offscreen document using `chrome.runtime.sendMessage({target: "offscreen", portKey, ...})`. Progress events come back as `{target: "background", type: "progress", portKey}` and are forwarded to the matching port.
- **`src/offscreen.js`** hosts the model and all page vectors.
  - Handlers: `index({key, docs, priority})` and `search({key, query, dim, topK})`.
  - Entries are searchable while indexing: a per-row `ready` mask; `search` waits for `firstBatch` and returns `partial/searched/total`.
  - Completed vectors are cached in memory (LRU) and in IndexedDB (`sctrlf` db). The storage key is `${device}/${dtype}|${pageKey}`, so vectors from a different model build are never mixed.
  - `pageKey` (computed in content) is the URL plus a hash of the passage texts.
- **`src/engine.js`** is shared by the offscreen document and the Node test, so it must not touch `chrome.*`.
  - Loads the model with `vision_config`/`audio_config` nulled (text-only).
  - Applies EmbeddingGemma task prefixes: `task: search result | query: …` for queries, `title: … | text: …` for documents.
  - Embeds in viewport-priority waves, in batches of 8.
  - `rank()` truncates to the Matryoshka dimension and re-normalizes.

Key behaviours that span files:

- **Relevance:** a match is a passage scoring at least `MIN_Z` (1.5) standard deviations above the page mean, computed in offscreen; the filter lives in content. If nothing qualifies, the single best passage is shown with a "weak" notice.
- **Device and dtype:** chosen in offscreen. WebGPU with `shader-f16` uses `q4f16` (benchmarked about 1.7× faster than `q4`); other WebGPU uses `q4`; WASM uses `q4`. `BATCH_SIZE = 8` was benchmarked as faster than larger or token-budgeted batches.
- **Progressive search:** content re-runs the query with `{refresh: true}` while indexing. A refresh must not scroll the page out from under a reader who is stepping through matches (`navigated` flag).
- **MV3 constraints:**
  - ONNX Runtime wasm (`ort-wasm-simd-threaded.asyncify.*`) is copied into `dist/ort/` by the build, and `env.backends.onnx.wasm.wasmPaths` points there.
  - `env.useWasmCache = false`, because blob-URL imports break under the extension CSP (`script-src 'self' 'wasm-unsafe-eval'`).
  - Never load code from a CDN.

## Demo page

`demo/` runs the real `offscreen.js` and `content.js` on an ordinary page. `demo/chrome-mock.js` fakes `runtime.connect/sendMessage/onMessage/getURL` and backs `storage.local` with localStorage. `demo/demo.js` drives the bar through `window.__semanticCtrlF.query(text)` (resolves to `{query, hits, ms, partial}`) and `onResults` (fires on every search, including refreshes). The same mock pattern is the way to test extension code in a plain browser tab. Elements with `data-sctrlf-ignore` are excluded from search.

## UI notes

- The find bar's styles live in a template string inside `content.js`.
- Theme tokens are CSS variables on `.bar, .rail, .menu`, with dark-mode overrides under `prefers-color-scheme`.
- Glass is `.bar.glass, .menu.glass`. Its muted colours were chosen for ≥ 4.5:1 contrast over worst-case backdrops; re-check if you change opacity.
- The theme menu is a sibling of `.bar` (positioned `fixed` from the button rect), because `.bar` has `overflow: hidden`.
- Page highlight CSS is injected into the host page as a `<style>` (`.sctrlf-hit`, `.sctrlf-current`).
