// Offscreen document: owns the model and every page's vectors. Content
// scripts never see embeddings, only ranked indices.
import { env } from "@huggingface/transformers";
import { FULL_DIM, loadEngine, rank } from "./engine.js";

// MV3 forbids remote code, so ONNX Runtime's wasm ships inside the extension.
// Its blob-URL cache would also break under the extension CSP.
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.mjs"),
  wasm: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.wasm"),
};

const MAX_MEMORY_PAGES = 20;
const MAX_STORED_PAGES = 30;

/**
 * key -> { vecs, ready, done, total, complete, cancelled, portKey, firstBatch, finished }
 * Map insertion order doubles as LRU order.
 */
const pages = new Map();

let enginePromise = null;
let backend = null;

// q4f16 runs ~1.7x faster than q4 on WebGPU (benchmarked: 120 passages in
// 4.8 s vs 8.2 s) with the same quality per the model card, but needs 16-bit
// shader support. CPU/WASM stays on q4.
let devicePick = null;
const pickDevice = () => (devicePick ??= detectDevice());
async function detectDevice() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) return { device: "webgpu", dtype: adapter.features.has("shader-f16") ? "q4f16" : "q4" };
  } catch {}
  return { device: "wasm", dtype: "q4" };
}

function getEngine(report) {
  enginePromise ??= (async () => {
    const onProgress = (p) => report(p);
    const { device, dtype } = await pickDevice();
    try {
      const engine = await loadEngine({ device, dtype, onProgress });
      backend = device;
      return engine;
    } catch (err) {
      if (device !== "webgpu") throw err;
      console.warn("WebGPU failed, falling back to WASM:", err);
      const engine = await loadEngine({ device: "wasm", dtype: "q4", onProgress });
      backend = "wasm";
      return engine;
    }
  })().catch((err) => {
    enginePromise = null; // allow retry
    throw err;
  });
  return enginePromise;
}

function touch(key) {
  const entry = pages.get(key);
  pages.delete(key);
  pages.set(key, entry);
  return entry;
}

function trimMemory() {
  for (const [key, entry] of pages) {
    if (pages.size <= MAX_MEMORY_PAGES) break;
    if (entry.complete) pages.delete(key);
  }
}

function completeEntry(vecs) {
  const total = vecs.length / FULL_DIM;
  return { vecs, ready: null, done: total, total, complete: true };
}

const handlers = {
  async index({ key, docs, priority }, report, portKey) {
    const t0 = performance.now();
    if (pages.has(key)) {
      const entry = touch(key);
      await entry.finished;
      return { backend, count: entry.total, ms: Math.round(performance.now() - t0), cached: true };
    }

    // A tab that re-reads its page (SPA navigation, edits) supersedes its old index.
    for (const [k, e] of pages) {
      if (e.portKey === portKey && !e.complete) {
        e.cancelled = true;
        pages.delete(k);
      }
    }

    const total = docs.length;
    const entry = {
      vecs: new Float32Array(total * FULL_DIM), ready: new Uint8Array(total), done: 0, total,
      complete: false, cancelled: false, portKey,
    };
    let firstBatchResolve;
    entry.firstBatch = new Promise((r) => (firstBatchResolve = r));
    pages.set(key, entry);

    entry.finished = (async () => {
      // Stored vectors are only valid for the same model build.
      const { device, dtype } = await pickDevice();
      const storeKey = `${device}/${dtype}|${key}`;
      const stored = await loadStored(storeKey);
      if (stored && stored.length === total * FULL_DIM) {
        Object.assign(entry, completeEntry(stored));
        firstBatchResolve();
        return true;
      }
      const engine = await getEngine(report);
      report({ phase: "index", done: 0, total });
      await engine.embedDocs(docs, {
        out: entry.vecs,
        priority,
        isCancelled: () => entry.cancelled,
        onBatch(ids) {
          for (const i of ids) entry.ready[i] = 1;
          entry.done += ids.length;
          firstBatchResolve();
          report({ phase: "index", done: entry.done, total });
        },
      });
      if (entry.cancelled) return false;
      entry.complete = true;
      entry.ready = null;
      if (backend === device) saveStored(storeKey, entry.vecs).catch((err) => console.warn("Could not store page vectors:", err));
      return false;
    })();
    entry.finished.catch(() => {
      pages.delete(key); // let a retry start fresh
      firstBatchResolve();
    });

    const cached = await entry.finished;
    trimMemory();
    if (entry.cancelled) throw new Error("Page changed while it was being read");
    return { backend, count: total, ms: Math.round(performance.now() - t0), cached };
  },

  async search({ key, query, dim, topK }, report) {
    const entry = pages.get(key);
    if (!entry) return { notIndexed: true };
    // While indexing, search whatever is embedded so far (at least one batch).
    await entry.firstBatch;
    if (!pages.has(key)) return { notIndexed: true };
    const engine = await getEngine(report);
    const t0 = performance.now();
    const q = await engine.embedQuery(query);
    const all = rank(entry.vecs, q, dim, Infinity, entry.ready);
    // Absolute cosine scores shift with page and dimension, so relevance is
    // judged against this page's own score distribution.
    const mean = all.reduce((s, h) => s + h.score, 0) / all.length;
    const std = Math.sqrt(all.reduce((s, h) => s + (h.score - mean) ** 2, 0) / all.length);
    const hits = all.slice(0, topK).map((h) => ({ ...h, z: std ? (h.score - mean) / std : 0 }));
    return {
      hits, backend, ms: Math.round(performance.now() - t0),
      partial: !entry.complete, searched: entry.complete ? entry.total : entry.done, total: entry.total,
    };
  },
};

// ---------- vectors persisted across visits (IndexedDB, this device only) ----------
let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("sctrlf", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("pages", { keyPath: "key" }).createIndex("savedAt", "savedAt");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction("pages", mode);
    const req = fn(t.objectStore("pages"));
    t.oncomplete = () => resolve(req instanceof IDBRequest ? req.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

async function loadStored(key) {
  try {
    const row = await tx("readonly", (s) => s.get(key));
    if (!row) return null;
    tx("readwrite", (s) => s.put({ ...row, savedAt: Date.now() })).catch(() => {});
    return new Float32Array(row.vecs);
  } catch {
    return null; // storage unavailable: just re-embed
  }
}

async function saveStored(key, vecs) {
  await tx("readwrite", (s) => s.put({ key, vecs: vecs.buffer.slice(0), savedAt: Date.now() }));
  // Keep only the most recently used pages.
  const keys = await tx("readonly", (s) => s.index("savedAt").getAllKeys());
  const stale = keys.length - MAX_STORED_PAGES;
  if (stale > 0) await tx("readwrite", (s) => keys.slice(0, stale).forEach((k) => s.delete(k)));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  const handler = handlers[msg.type];
  if (!handler) return;
  const report = (payload) =>
    chrome.runtime.sendMessage({ target: "background", type: "progress", portKey: msg.portKey, payload }).catch(() => {});
  handler(msg.payload, report, msg.portKey).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true; // async response
});
