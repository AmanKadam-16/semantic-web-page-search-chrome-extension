// Find bar injected into the page. Extracts readable blocks, asks the model
// (via the background worker) to index and rank them, and highlights hits.
// Injected on every toolbar click/shortcut, so it must be idempotent.

if (window.__semanticCtrlF) {
  window.__semanticCtrlF.toggle();
} else {
  window.__semanticCtrlF = createFindBar();
  window.__semanticCtrlF.open();
}

function createFindBar() {
  const MAX_CHUNKS = 2000;
  const MAX_CHARS = 1500;
  const TOP_K = 10;
  const MIN_Z = 1.5; // std-devs above the page mean to count as a match
  const DIMS = [768, 512, 256, 128];
  const HIT = "sctrlf-hit";
  const CURRENT = "sctrlf-current";

  let chunks = [];
  let pageKey = null;
  let indexed = null; // Promise while/after indexing
  let hits = [];
  let weak = false; // true when nothing cleared MIN_Z and we show the closest passage
  let current = -1;
  let searchSeq = 0;
  let dim = 768;
  let backend = null;
  let isOpen = false;
  let indexing = false; // an index request is in flight
  let lastPartial = false; // last results came from a partly indexed page
  let lastRefresh = 0;
  let navigated = false; // the reader stepped through matches since the last search

  // ---------- messaging ----------
  let port = null;
  let reqId = 0;
  const pending = new Map();
  function connect() {
    port = chrome.runtime.connect({ name: "sctrlf" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "progress") return onProgress(msg.payload);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const p of pending.values()) p.reject(new Error("Lost connection to the extension. Reload the page and try again."));
      pending.clear();
    });
  }
  function request(type, payload) {
    if (!port) connect();
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ id, type, payload });
    });
  }

  // ---------- page text extraction ----------
  const BLOCKS = "p,li,dd,dt,blockquote,pre,td,th,figcaption,summary,h1,h2,h3,h4,h5,h6,caption,label";
  const HEADINGS = /^H[1-6]$/;
  const SKIP = [
    "script,style,noscript,template,svg,nav,footer,[aria-hidden=true],[data-sctrlf-ignore],#sctrlf-host",
    "[role=navigation],[role=contentinfo]",
    // Reference lists and navigation boxes (Wikipedia and other MediaWiki sites):
    // on a long article they are over half the passages and nobody searches them.
    ".references,.reflist,.refbegin,.mw-references-wrap,.navbox,.catlinks,.mw-editsection,.metadata,.printfooter",
  ].join(",");
  const MAX_LINK_DENSITY = 0.6; // link lists, "see also" rows, tag clouds
  const SHORT_ITEM = 100; // list items shorter than this are merged per list

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  }

  function extract() {
    const root = document.querySelector("main, article, [role=main]") || document.body;
    const candidates = new Set(root.querySelectorAll(BLOCKS));
    // Many sites put prose straight into divs/spans.
    for (const el of root.querySelectorAll("div,section,span")) {
      if (ownText(el).length >= 60) candidates.add(el);
    }
    // Keep the innermost block so highlights stay tight: mark every ancestor
    // of a candidate that has text (one walk up per candidate, not a subtree scan).
    const hasInner = new Set();
    for (const el of candidates) {
      if (el.textContent.trim().length < 20) continue;
      for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
        if (hasInner.has(p)) break;
        hasInner.add(p);
      }
    }
    const out = [];
    let heading = document.title.trim();
    // Document order so each block knows its nearest preceding heading.
    const ordered = [...candidates].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    for (const el of ordered) {
      if (hasInner.has(el) || el.closest(SKIP)) continue;
      const text = el.innerText.replace(/\s+/g, " ").trim();
      if (HEADINGS.test(el.tagName)) {
        if (text) heading = text.slice(0, 120);
        if (text.length < 20) continue;
      }
      if (text.length < 20 || !isVisible(el)) continue;
      let linkChars = 0;
      for (const a of el.querySelectorAll("a")) linkChars += a.textContent.length;
      if (linkChars / text.length > MAX_LINK_DENSITY) continue;
      const prev = out.at(-1);
      // Fold runs of short list items into one passage for their list.
      if (el.tagName === "LI" && text.length < SHORT_ITEM && prev?.list === el.parentElement &&
          prev.text.length + text.length < MAX_CHARS) {
        prev.text += "; " + text;
        continue;
      }
      out.push({
        el: el.tagName === "LI" && text.length < SHORT_ITEM ? el.parentElement : el,
        list: el.tagName === "LI" && text.length < SHORT_ITEM ? el.parentElement : null,
        text: text.slice(0, MAX_CHARS),
        title: heading,
      });
      if (out.length >= MAX_CHUNKS) break;
    }
    return out;
  }

  function hashChunks(list) {
    let h = 2166136261;
    const s = location.href + "\n" + list.map((c) => c.title + "|" + c.text).join("\n");
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `${location.href}#${list.length}:${(h >>> 0).toString(36)}`;
  }

  function ensureIndexed() {
    const fresh = extract();
    const key = hashChunks(fresh);
    if (indexed && key === pageKey) return indexed;
    chunks = fresh;
    pageKey = key;
    clearHighlights();
    if (!chunks.length) {
      setStatus("No readable text on this page. Try a page with articles or paragraphs.", "err");
      return (indexed = Promise.resolve(false));
    }
    setStatus(`Reading ${chunks.length} passages…`, "busy");
    // Embed what's on screen first, then outward, so early searches cover it.
    const mid = window.innerHeight / 2;
    const dist = chunks.map(({ el }) => {
      const r = el.getBoundingClientRect();
      return Math.abs((r.top + r.bottom) / 2 - mid);
    });
    const priority = chunks.map((_, i) => i).sort((a, b) => dist[a] - dist[b]);
    indexing = true;
    const thisIndex = (indexed = request("index", { key, priority, docs: chunks.map(({ text, title }) => ({ text, title })) })
      .then((res) => {
        backend = res.backend;
        if (lastPartial && ui.input.value.trim()) search(ui.input.value, { refresh: true });
        else setStatus(`${res.count} passages ${res.cached ? "loaded from cache" : `read in ${fmtMs(res.ms)}`} · ${backendLabel()}`);
        renderResults();
        return true;
      })
      .catch((err) => {
        if (indexed === thisIndex) indexed = null;
        setStatus(err.message, "err");
        return false;
      })
      .finally(() => {
        if (indexed === thisIndex || indexed === null) indexing = false;
      }));
    return indexed;
  }

  // ---------- search ----------
  /**
   * Runs a search; resolves to { hits, ms, partial }, or null if a newer search
   * replaced it. Works while the page is still being indexed: it ranks the
   * passages embedded so far, and `refresh` re-runs keep the reader's place.
   */
  async function search(query, { refresh = false } = {}) {
    const seq = ++searchSeq;
    query = query.trim();
    ui.clear.hidden = !query;
    if (!query) {
      clearHighlights();
      hits = [];
      weak = false;
      lastPartial = false;
      renderResults();
      return { hits: [], ms: 0, partial: false };
    }
    // The page is re-read on open; keystrokes reuse that index.
    if (!indexed) ensureIndexed();
    if (!chunks.length) return null;
    ui.bar.classList.add("searching");
    let res;
    try {
      for (let attempt = 0; ; attempt++) {
        res = await request("search", { key: pageKey, query, dim, topK: TOP_K });
        if (seq !== searchSeq) return null; // a newer keystroke won
        if (!res.notIndexed) break;
        // The index request may still be in flight, or the model host restarted.
        if (!indexing) { indexed = null; ensureIndexed(); }
        if (attempt > 40) throw new Error("Couldn't read this page. Close the bar and try again.");
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (err) {
      if (seq === searchSeq) setStatus(err.message, "err");
      return null;
    } finally {
      if (seq === searchSeq) ui.bar.classList.remove("searching");
    }
    backend = res.backend;
    lastPartial = res.partial;
    lastRefresh = performance.now();
    const before = hits[current]?.chunk.el;
    const strong = res.hits.filter((h) => h.z >= MIN_Z);
    weak = !strong.length;
    hits = (weak ? res.hits.slice(0, 1) : strong)
      .map((h) => ({ ...h, chunk: chunks[h.index] }))
      .filter((h) => h.chunk?.el.isConnected);
    applyHighlights();
    setStatus(res.partial
      ? `Searched ${res.searched} of ${res.total} passages so far · results update as the page is read`
      : `${fmtMs(res.ms)} · ${backendLabel()} · on-device`, res.partial ? "busy" : undefined);
    if (res.partial) setProgress(res.searched / res.total);
    if (!refresh) {
      navigated = false;
      go(0);
    } else if (navigated) {
      // The reader is stepping through matches: stay on their passage.
      const keep = hits.findIndex((h) => h.chunk.el === before);
      go(Math.max(0, keep), { scroll: false });
    } else {
      // Only move the page if a better match turned up.
      go(0, { scroll: hits[0]?.chunk.el !== before });
    }
    const result = { query, ms: res.ms, partial: res.partial, hits: hits.map((h) => ({ score: h.score, title: h.chunk.title, text: h.chunk.text, el: h.chunk.el })) };
    api.onResults?.(result);
    return result;
  }

  // 0..1 strength of a hit relative to the others, used for every visual weight.
  function strength(h) {
    const top = hits[0]?.score ?? 0;
    const low = hits.at(-1)?.score ?? 0;
    return top === low ? 1 : (h.score - low) / (top - low);
  }

  function applyHighlights() {
    clearHighlights();
    for (const h of hits) {
      h.chunk.el.classList.add(HIT);
      h.chunk.el.style.setProperty("--sctrlf-a", (0.16 + 0.3 * strength(h)).toFixed(2));
    }
    renderResults();
    renderRail();
  }

  function clearHighlights() {
    for (const el of document.querySelectorAll(`.${HIT}`)) {
      el.classList.remove(HIT, CURRENT);
      el.style.removeProperty("--sctrlf-a");
    }
    current = -1;
    ui.rail.replaceChildren();
    updateCounter();
  }

  function go(i, { scroll = true, user = false } = {}) {
    if (user) navigated = true;
    if (!hits.length) return updateCounter();
    hits[current]?.chunk.el.classList.remove(CURRENT);
    current = (i + hits.length) % hits.length;
    const el = hits[current].chunk.el;
    // Re-adding the class restarts the pulse animation.
    void el.offsetWidth;
    el.classList.add(CURRENT);
    if (scroll) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    updateCounter();
    ui.list.querySelectorAll("li").forEach((li, j) => {
      li.classList.toggle("active", j === current);
      li.setAttribute("aria-selected", j === current);
      if (j === current) li.scrollIntoView({ block: "nearest" });
    });
    ui.rail.querySelectorAll(".tick").forEach((t, j) => t.classList.toggle("active", j === current));
  }

  // ---------- page styles ----------
  const pageStyle = document.createElement("style");
  pageStyle.id = "sctrlf-page-style";
  pageStyle.textContent = `
    .${HIT} { background-color: rgba(242, 194, 48, var(--sctrlf-a, .3)) !important;
      box-shadow: 0 0 0 4px rgba(242, 194, 48, var(--sctrlf-a, .3)) !important;
      border-radius: 3px !important; transition: background-color .25s, box-shadow .25s; }
    .${HIT}.${CURRENT} { background-color: rgba(242, 194, 48, .5) !important;
      box-shadow: 0 0 0 4px rgba(242, 194, 48, .5), 0 0 0 6px #b98500 !important;
      animation: sctrlf-pulse .9s ease-out 1; }
    @keyframes sctrlf-pulse {
      from { box-shadow: 0 0 0 4px rgba(242, 194, 48, .5), 0 0 0 6px #b98500, 0 0 0 6px rgba(242, 194, 48, .6); }
      to { box-shadow: 0 0 0 4px rgba(242, 194, 48, .5), 0 0 0 6px #b98500, 0 0 0 22px rgba(242, 194, 48, 0); }
    }
    @media (prefers-reduced-motion: reduce) { .${HIT}.${CURRENT} { animation: none; } }`;

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "sctrlf-host";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .bar, .rail, .menu {
        --bg: #ffffff; --surface: #f3f6f2; --ink: #18241f; --on-ink: #ffffff; --muted: #5b6962; --line: #dbe3dd;
        --menu-bg: var(--bg);
        --blaze: #f2c230; --blaze-ink: #8a6400; --err: #b8402b; --focus: #2f6f8f;
        --shadow: 0 1px 2px rgba(24,36,31,.08), 0 12px 32px -8px rgba(24,36,31,.28);
      }
      @media (prefers-color-scheme: dark) {
        .bar, .rail, .menu {
          --bg: #18201c; --surface: #212a25; --ink: #e8eee9; --on-ink: #18201c; --muted: #98a69e; --line: #313d37;
          --blaze-ink: #f2c230; --err: #ff8a72; --focus: #8cc3dc;
          --shadow: 0 1px 2px rgba(0,0,0,.4), 0 16px 40px -8px rgba(0,0,0,.6);
        }
      }
      .bar { position: fixed; top: 12px; right: 18px; z-index: 2147483647; width: 400px;
        max-width: calc(100vw - 32px); color: var(--ink); background: var(--bg);
        border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden;
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        animation: enter .16s ease-out; }
      @keyframes enter { from { opacity: 0; transform: translateY(-6px); } }
      @media (max-width: 480px) { .bar { top: 8px; right: 8px; left: 8px; width: auto; max-width: none; } }
      @media (prefers-reduced-motion: reduce) { .bar { animation: none; } }

      .row { display: flex; align-items: center; gap: 2px; padding: 6px 6px 6px 12px; }
      .glyph { flex: none; width: 18px; height: 18px; margin-right: 6px; color: var(--muted); }
      .bar.searching .glyph circle.core { animation: blink .7s ease-in-out infinite alternate; }
      @keyframes blink { to { opacity: .2; } }
      input { flex: 1; min-width: 0; height: 32px; background: transparent; border: 0; outline: 0;
        color: inherit; font: inherit; font-size: 15px; }
      input::placeholder { color: var(--muted); }
      .count { padding: 0 6px; color: var(--muted); font: 12px ui-monospace, "Cascadia Mono", Menlo, monospace;
        font-variant-numeric: tabular-nums; white-space: nowrap; }
      button { display: grid; place-items: center; min-width: 28px; height: 28px; padding: 0 6px;
        background: transparent; color: var(--muted); border: 0; border-radius: 8px; font: inherit; cursor: pointer; }
      button:hover { background: var(--surface); color: var(--ink); }
      button:focus-visible, input:focus-visible, li:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
      button[hidden] { display: none; }
      .sep { width: 1px; height: 18px; margin: 0 4px; background: var(--line); }
      svg { width: 16px; height: 16px; }

      .progress { height: 2px; background: var(--line); }
      .progress span { display: block; height: 100%; width: 0; background: var(--blaze); transition: width .2s; }
      .progress[hidden] { display: none; }

      .meta { display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 6px 8px 6px 12px; border-top: 1px solid var(--line); background: var(--surface); }
      .status { min-width: 0; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .status.err { color: var(--err); white-space: normal; }
      .dims { flex: none; display: flex; padding: 2px; gap: 2px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
      .dims button { min-width: 0; height: 22px; padding: 0 7px; border-radius: 6px;
        font: 11px ui-monospace, "Cascadia Mono", Menlo, monospace; }
      .dims button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }

      .notice { padding: 8px 12px 0; color: var(--muted); font-size: 12px; }
      .notice[hidden] { display: none; }
      ul { list-style: none; margin: 0; padding: 6px; max-height: min(320px, 50vh); overflow: auto; }
      ul:empty { display: none; }
      li { display: grid; grid-template-columns: 4px 1fr auto; gap: 10px; padding: 8px 8px 8px 6px;
        border-radius: 9px; cursor: pointer; }
      li:hover { background: var(--surface); }
      li.active { background: color-mix(in srgb, var(--blaze) 18%, var(--bg)); }
      .swatch { border-radius: 2px; background: var(--blaze); }
      .body { min-width: 0; }
      .title { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .02em;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .snip { color: var(--ink); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .score { align-self: start; padding-top: 1px; color: var(--blaze-ink);
        font: 600 11px ui-monospace, "Cascadia Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
      /* The empty-state hint is an li but not a result row: plain flowing text. */
      li.hint { display: block; padding: 10px 8px; color: var(--muted); cursor: default; }
      li.hint:hover { background: none; }
      .hint b { color: var(--ink); font-weight: 600; }
      .keys { display: flex; flex-wrap: wrap; gap: 12px; padding: 7px 12px; border-top: 1px solid var(--line);
        color: var(--muted); font-size: 11px; }
      kbd { font: 10.5px ui-monospace, "Cascadia Mono", Menlo, monospace; padding: 1px 4px;
        border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; background: var(--bg); }
      @media (max-width: 480px) { .keys { display: none; } }

      /* Theme picker. A sibling of the bar, not a child: the bar clips its overflow,
         and when it's short (no results yet) a child menu got cut off. */
      .menu { position: fixed; z-index: 2147483647; width: 224px; padding: 4px; color: var(--ink);
        background: var(--menu-bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .menu[hidden] { display: none; }
      .menu button { display: grid; grid-template-columns: 16px 1fr; place-items: start; gap: 2px 8px;
        width: 100%; height: auto; padding: 7px 8px; text-align: left; color: var(--ink); }
      .menu button::before { content: ""; grid-row: span 2; width: 14px; height: 14px; margin-top: 2px;
        border: 1.5px solid var(--muted); border-radius: 50%; }
      .menu button[aria-checked="true"]::before { border-color: var(--ink); background: radial-gradient(var(--ink) 0 3.5px, transparent 4px); }
      .menu b { font-weight: 600; }
      .menu small { grid-column: 2; color: var(--muted); font-size: 11.5px; }

      /* Glass theme, modelled on Apple's guidance: a regular-to-thick material
         (heavy blur, mostly opaque) because the bar is text-heavy, and solid
         secondary text instead of vibrancy, which CSS can't reproduce. Muted
         colors keep >= 4.5:1 contrast even over the worst-case page behind
         them (a dark page under light glass, a white page under dark glass). */
      .bar.glass, .menu.glass {
        --bg: rgba(250, 250, 252, .8); --menu-bg: rgba(250, 250, 252, .86);
        --surface: rgba(118, 118, 128, .12); --line: rgba(60, 60, 67, .14);
        --ink: #1d1d1f; --muted: #3f4448; --blaze-ink: #7a5800;
        -webkit-backdrop-filter: blur(40px) saturate(180%); backdrop-filter: blur(40px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, .55);
        /* Hairline outer edge, specular top highlight, soft lift. */
        box-shadow: 0 0 0 .5px rgba(0, 0, 0, .16), inset 0 1px 0 rgba(255, 255, 255, .75), 0 24px 60px -16px rgba(0, 0, 0, .38);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      }
      .bar.glass { border-radius: 18px; }
      .menu.glass { border-radius: 14px; }
      .bar.glass kbd { background: rgba(255, 255, 255, .5); }
      @media (prefers-color-scheme: dark) {
        .bar.glass, .menu.glass {
          --bg: rgba(30, 30, 34, .78); --menu-bg: rgba(38, 38, 42, .88);
          --surface: rgba(255, 255, 255, .08); --line: rgba(255, 255, 255, .12);
          --ink: #f5f5f7; --muted: #d0d5da; --blaze-ink: #f2c230;
          border-color: rgba(255, 255, 255, .16);
          box-shadow: 0 0 0 .5px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .12), 0 24px 60px -16px rgba(0, 0, 0, .6);
        }
        .bar.glass kbd { background: rgba(255, 255, 255, .08); }
      }
      .bar.glass .row { padding: 8px 8px 8px 14px; }
      .bar.glass input { height: 36px; font-size: 17px; }
      .bar.glass .meta { background: transparent; }
      .bar.glass .dims { background: var(--surface); border-color: transparent; }
      .bar.glass li { border-radius: 10px; }
      .bar.glass li.active { background: rgba(242, 194, 48, .26); }
      /* Respect "reduce transparency": same shape, solid material. */
      @media (prefers-reduced-transparency: reduce) {
        .bar.glass, .menu.glass { --bg: #f5f5f7; --menu-bg: #f5f5f7; backdrop-filter: none; -webkit-backdrop-filter: none; }
      }
      @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) {
        .bar.glass, .menu.glass { --bg: #242428; --menu-bg: #2a2a2e; }
      }

      /* Match markers along the scrollbar, like the browser's own Ctrl+F. */
      .rail { position: fixed; top: 0; right: 0; bottom: 0; width: 10px; z-index: 2147483646; pointer-events: none; }
      .tick { position: absolute; right: 1px; width: 8px; height: 4px; border-radius: 2px; padding: 0;
        min-width: 0; background: var(--blaze); pointer-events: auto; box-shadow: 0 0 0 1px rgba(0,0,0,.15); }
      .tick:hover { background: var(--blaze); }
      .tick.active { right: 0; width: 10px; height: 6px; background: var(--ink); }
    </style>
    <div class="bar" role="search" aria-label="Semantic Ctrl+F">
      <div class="row">
        <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/>
          <circle class="core" cx="10.5" cy="10.5" r="2" fill="#f2c230" stroke="none"/>
        </svg>
        <input type="text" placeholder="Ask this page anything…" aria-label="Search this page by meaning"
          spellcheck="false" autocomplete="off" aria-controls="sctrlf-results" />
        <button class="clear" title="Clear" aria-label="Clear search" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>
        </button>
        <span class="count" aria-live="polite"></span>
        <button class="prev" title="Previous match (Shift+Enter)" aria-label="Previous match">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>
        </button>
        <button class="next" title="Next match (Enter)" aria-label="Next match">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <span class="sep"></span>
        <button class="theme" title="Theme" aria-label="Theme" aria-haspopup="menu" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.2" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="7.6" r="1.2" fill="currentColor" stroke="none"/></svg>
        </button>
        <button class="close" title="Close (Esc)" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="progress" hidden><span></span></div>
      <div class="meta">
        <span class="status" aria-live="polite"></span>
        <div class="dims" role="group" aria-label="Embedding size (Matryoshka)" title="Embedding size: smaller vectors are cheaper to store, slightly less precise">
          ${DIMS.map((d) => `<button type="button" data-dim="${d}" aria-pressed="false">${d}</button>`).join("")}
        </div>
      </div>
      <div class="notice" hidden>No strong match on this page. Showing the closest passage.</div>
      <ul id="sctrlf-results" role="listbox" aria-label="Matches"></ul>
      <div class="keys" aria-hidden="true">
        <span><kbd>Enter</kbd> next</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> previous</span>
        <span><kbd>↑</kbd><kbd>↓</kbd> results</span><span><kbd>Esc</kbd> close</span>
      </div>
    </div>
    <div class="menu" role="menu" aria-label="Theme" hidden>
      <button type="button" role="menuitemradio" data-theme="default" aria-checked="true"><b>Default</b><small>Solid and high contrast</small></button>
      <button type="button" role="menuitemradio" data-theme="glass" aria-checked="false"><b>Glass</b><small>Translucent, like macOS</small></button>
    </div>
    <div class="rail"></div>`;

  const $ = (s) => shadow.querySelector(s);
  const ui = {
    bar: $(".bar"), input: $("input"), clear: $(".clear"), count: $(".count"), status: $(".status"),
    progress: $(".progress"), progressFill: $(".progress span"), list: $("ul"), notice: $(".notice"),
    dims: $(".dims"), rail: $(".rail"), themeButton: $(".theme"), menu: $(".menu"),
  };

  // Keep the page's own shortcuts from firing while typing in the bar.
  for (const t of ["keydown", "keyup", "keypress"]) host.addEventListener(t, (e) => e.stopPropagation());

  let debounce = null;
  ui.input.addEventListener("input", () => {
    clearTimeout(debounce);
    ui.clear.hidden = !ui.input.value;
    debounce = setTimeout(() => { debounce = null; search(ui.input.value); }, 300);
  });
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter") {
      e.preventDefault();
      // Enter right after typing searches immediately instead of waiting.
      if (debounce) { clearTimeout(debounce); debounce = null; search(ui.input.value); }
      else go(current + (e.shiftKey ? -1 : 1), { user: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      go(current + (e.key === "ArrowDown" ? 1 : -1), { user: true });
    }
  });
  ui.clear.addEventListener("click", () => {
    ui.input.value = "";
    search("");
    ui.input.focus();
  });
  $(".next").addEventListener("click", () => go(current + 1, { user: true }));
  $(".prev").addEventListener("click", () => go(current - 1, { user: true }));
  $(".close").addEventListener("click", () => close());
  ui.dims.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-dim]");
    if (b) setDim(Number(b.dataset.dim), true);
  });
  function setDim(d, persist) {
    dim = d;
    ui.dims.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", Number(b.dataset.dim) === d));
    if (!persist) return;
    chrome.storage?.local.set({ dim });
    if (ui.input.value.trim()) search(ui.input.value);
  }
  setDim(dim, false);

  // ---------- theme picker ----------
  function setTheme(theme, persist) {
    ui.bar.classList.toggle("glass", theme === "glass");
    ui.menu.classList.toggle("glass", theme === "glass");
    ui.menu.querySelectorAll("[data-theme]").forEach((b) => b.setAttribute("aria-checked", b.dataset.theme === theme));
    if (persist) chrome.storage?.local.set({ theme });
  }
  function toggleMenu(show = ui.menu.hidden) {
    if (show) {
      const r = ui.themeButton.getBoundingClientRect();
      ui.menu.style.top = `${r.bottom + 6}px`;
      ui.menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    }
    ui.menu.hidden = !show;
    ui.themeButton.setAttribute("aria-expanded", show);
    if (show) ui.menu.querySelector('[aria-checked="true"]').focus();
  }
  ui.themeButton.addEventListener("click", () => toggleMenu());
  ui.menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme]");
    if (!b) return;
    setTheme(b.dataset.theme, true);
    toggleMenu(false);
    ui.themeButton.focus();
  });
  ui.menu.addEventListener("keydown", (e) => {
    const items = [...ui.menu.querySelectorAll("[data-theme]")];
    const i = items.indexOf(shadow.activeElement);
    if (e.key === "Escape") { e.preventDefault(); toggleMenu(false); ui.themeButton.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  // Click anywhere else in the bar closes the menu.
  shadow.addEventListener("pointerdown", (e) => {
    if (!ui.menu.hidden && !e.composedPath().some((n) => n === ui.menu || n === ui.themeButton)) toggleMenu(false);
  });
  chrome.storage?.local.get("theme").then(({ theme } = {}) => theme && setTheme(theme, false)).catch(() => {});
  chrome.storage?.local.get("dim").then(({ dim: saved } = {}) => saved && setDim(saved, false)).catch(() => {});

  let railFrame = 0;
  const onLayout = () => {
    if (!ui.menu.hidden) toggleMenu(false); // its position is tied to the old layout
    cancelAnimationFrame(railFrame);
    railFrame = requestAnimationFrame(renderRail);
  };

  function renderResults() {
    ui.notice.hidden = !(weak && hits.length);
    if (!hits.length) {
      const indexedOk = indexed && !ui.status.classList.contains("err");
      ui.list.innerHTML = ui.input.value.trim() || !indexedOk ? "" :
        `<li class="hint" role="presentation">Describe what you're looking for, like <b>"how do I cancel?"</b> or <b>"who wrote this?"</b>. Any language works.</li>`;
      return;
    }
    ui.list.replaceChildren(
      ...hits.map((h, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.opacity = (0.3 + 0.7 * strength(h)).toFixed(2);
        const body = document.createElement("div");
        body.className = "body";
        if (h.chunk.title && h.chunk.title !== h.chunk.text) {
          const t = document.createElement("div");
          t.className = "title";
          t.textContent = h.chunk.title;
          body.append(t);
        }
        const snip = document.createElement("div");
        snip.className = "snip";
        snip.textContent = h.chunk.text.slice(0, 240);
        body.append(snip);
        const score = document.createElement("span");
        score.className = "score";
        score.textContent = h.score.toFixed(2);
        score.title = "Cosine similarity to your question";
        li.append(swatch, body, score);
        li.addEventListener("click", () => go(i, { user: true }));
        return li;
      }),
    );
  }

  function renderRail() {
    const docH = document.documentElement.scrollHeight;
    const viewH = window.innerHeight;
    ui.rail.replaceChildren(
      ...hits.map((h, i) => {
        const t = document.createElement("button");
        t.className = "tick" + (i === current ? " active" : "");
        t.tabIndex = -1;
        t.setAttribute("aria-label", `Match ${i + 1}`);
        const y = h.chunk.el.getBoundingClientRect().top + window.scrollY;
        t.style.top = `${Math.min(viewH - 6, (y / docH) * viewH)}px`;
        t.style.opacity = (0.45 + 0.55 * strength(h)).toFixed(2);
        t.addEventListener("click", () => go(i, { user: true }));
        return t;
      }),
    );
  }

  function updateCounter() {
    ui.count.textContent = hits.length ? `${current + 1} of ${hits.length}` : ui.input.value.trim() && indexed ? "0 of 0" : "";
  }

  function setStatus(text, kind) {
    ui.status.textContent = text;
    ui.status.title = text;
    ui.status.classList.toggle("err", kind === "err");
    if (kind !== "busy") ui.progress.hidden = true;
  }

  function setProgress(fraction) {
    ui.progress.hidden = false;
    ui.progressFill.style.width = `${Math.round(fraction * 100)}%`;
  }

  function onProgress(p) {
    if (p.phase === "download" && p.total) {
      setProgress(p.loaded / p.total);
      setStatus(p.loaded >= p.total
        ? "Starting the model…"
        : `Downloading EmbeddingGemma 2 · ${mb(p.loaded)} of ${mb(p.total)} MB · first time only`, "busy");
    } else if (p.phase === "index") {
      setProgress(p.done / p.total);
      const query = ui.input.value.trim();
      setStatus(query && lastPartial
        ? `Searched ${p.done} of ${p.total} passages so far · results update as the page is read`
        : `Reading the page · ${p.done} of ${p.total} passages${query ? "" : " · you can search already"}`, "busy");
      // Fold newly embedded passages into the current results now and then.
      if (query && lastPartial && p.done < p.total && performance.now() - lastRefresh > 1500) {
        lastRefresh = performance.now();
        search(query, { refresh: true });
      }
    }
  }

  const mb = (b) => (b / 1e6).toFixed(0);
  const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
  const backendLabel = () => (backend === "webgpu" ? "WebGPU" : backend === "wasm" ? "CPU (WASM)" : "on-device");
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function open() {
    if (!host.isConnected) {
      document.documentElement.append(pageStyle, host);
      addEventListener("resize", onLayout);
    }
    isOpen = true;
    ui.input.focus();
    ui.input.select();
    ensureIndexed();
    // Re-run the previous query on reopen; it searches whatever is indexed so far.
    if (ui.input.value.trim()) search(ui.input.value);
  }

  function close() {
    isOpen = false;
    toggleMenu(false);
    searchSeq++;
    clearHighlights();
    removeEventListener("resize", onLayout);
    host.remove();
    pageStyle.remove();
  }

  /** Opens the bar with `text` and searches it. Used by the demo page. */
  function query(text) {
    if (!isOpen) open();
    ui.input.value = text;
    clearTimeout(debounce);
    debounce = null;
    return search(text);
  }

  // onResults(result) fires after every search, including refreshes while the
  // page is still being indexed. Used by the demo page.
  const api = { open, close, query, toggle: () => (isOpen ? close() : open()), onResults: null };
  return api;
}
