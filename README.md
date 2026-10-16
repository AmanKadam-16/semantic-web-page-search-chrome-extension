# Semantic Ctrl+F

Ctrl+F that finds **meaning** instead of keywords. Ask a page *"where do they talk about refunds?"* and it highlights the paragraph about "crediting your original payment method", even though that paragraph never uses the word "refund".

Built on [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) ([ONNX build](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX)) running **entirely in your browser** with Transformers.js + WebGPU. Page text never leaves your machine.

## What it shows off

| EmbeddingGemma 2 feature | Where you see it |
| --- | --- |
| On-device, small | Text-only 270M model (4-bit, 157–174 MB, downloaded once and cached). Queries take ~70–130 ms on WebGPU. |
| Task prefixes | Queries use `task: search result \| query: …`; passages use `title: <nearest heading> \| text: …`. |
| Matryoshka (MRL) | The `768 / 512 / 256 / 128` toggle in the bar re-ranks live with truncated, re-normalized vectors. |
| 100+ languages | English queries find French passages and the other way round. |

## Install (Chrome / Edge / Brave)

```bash
npm install
```

```bash
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. On any page, press **Ctrl+Shift+F** (Mac: **Ctrl+Shift+F**) or click the toolbar icon.

The first use downloads the model (about 160 MB) and caches it. After that it works offline.

**Keys:** `Enter` / `Shift+Enter` or `↑` / `↓` move between matches, and `Esc` closes. Click a result or a tick on the scrollbar to jump to it. Matches are shaded by how close they are, and the bar follows your system light/dark theme.

**Themes:** the overlapping-squares button in the bar opens a theme picker. **Default** is solid and high contrast. **Glass** is a translucent, blurred panel in the style of macOS Spotlight. Both follow light/dark mode, and your choice is remembered. If your system asks to reduce transparency, Glass uses a solid background instead.

## Demo page (no extension needed)

```bash
npm run demo
```

This opens a fictional outdoor-gear help center at http://localhost:5173. The real find bar and model code run there against a mocked `chrome` API. Click a sample question to race the two searches: the Ctrl+F lane counts exact-text matches on the page (always 0 for these questions), and the semantic lane shows the passage the model found. Sections that contain a match are marked in the table of contents. Questions:

- "can I get my money back?" → returns policy
- "it arrived broken" → damaged-gear paragraph
- "is this ok for kids" → youth sizing and safety testing
- "parlez-vous français" → the French support line

## How it works

```
toolbar / Ctrl+Shift+F
        │ chrome.scripting (activeTab: no broad host permissions)
        ▼
content.js ── extracts visible blocks (p, li, td, headings, prose divs)
   │  port        with nearest heading as title, renders the find bar
   ▼              (shadow DOM) and highlights hits
background.js ── relays messages, creates the offscreen document
   │
   ▼
offscreen.js ── loads EmbeddingGemma 2 (WebGPU, falls back to WASM),
                embeds pages nearest-the-viewport first, ranks queries,
                keeps vectors in memory (20 pages) and IndexedDB (30 pages)
```

## Big pages

Before tuning, the full Wikipedia *World War II* article took **48 s** to index on WebGPU, and searches had to wait for all of it. Measured changes:

| Change | Effect on that article |
| --- | --- |
| Skip reference lists, navboxes and link-heavy lists, and merge short list items | 959 → 187 passages. Page read 588 → 110 ms. |
| `q4f16` on GPUs with `shader-f16` (plain `q4` otherwise) | 1.7× faster embedding (120 passages: 8.2 → 4.8 s) |
| Search while indexing, nearest-the-viewport passages first | First results as soon as the first batch is embedded. Results refresh as more passages arrive, without moving you off the match you're on. |
| Vectors saved in IndexedDB per page (keyed by URL + content hash + model build) | Revisiting a page skips embedding entirely |

Net: full index in about 25 s from a cold start (model start-up included), with partial results well before that. Batch size was benchmarked too: batches of 8 padded to their longest passage beat 32-wide batches and token-budget bucketing by 15–55%, because the model is compute-bound on WebGPU.

## Details

- **Relevance cutoff:** cosine scores shift from page to page and between MRL sizes, so a passage counts as a match when it scores ≥ 1.5 standard deviations above that page's mean. The best passage is always shown.
- **MV3 compliance:** ONNX Runtime's wasm is bundled in `dist/ort/` because Manifest V3 doesn't allow remote code. Only the model weights are fetched, from huggingface.co.
- **Scripting the bar:** `window.__semanticCtrlF.query(text)` opens the bar, searches, and resolves to `{ hits, ms }`. The demo page uses it. In the real extension it lives in the content script's isolated world, so web pages can't call it.
- **Opting out:** add the `data-sctrlf-ignore` attribute to any element that should be left out of search.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/engine.js` | Model loading, prefixes, batching, MRL ranking. Shared with the Node test. |
| `src/offscreen.js` | Model host inside the extension |
| `src/background.js` | Service worker: injection plus message relay |
| `src/content.js` | Find bar, text extraction, highlighting |
| `demo/` | Standalone demo page with a `chrome` mock |
| `test/engine.test.mjs` | `npm test`: real-model ranking checks at all four MRL sizes |
| `scripts/` | esbuild build (also draws the icons) and a static server |

## Limitations

- Pages Chrome doesn't allow scripting (`chrome://`, the Web Store, the built-in PDF viewer) show a red ✕ badge.
- Very long pages are capped at 2,000 passages of 1,500 characters each.
- Saved page vectors stay on this device in the extension's own IndexedDB. Removing the extension deletes them.
- Content loaded after indexing is picked up the next time you open the bar.
