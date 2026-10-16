// Entry for the demo page: mock chrome APIs, start the model host, then
// drive the real find bar from the "race" card.
import "./chrome-mock.js";
import "../src/offscreen.js";

const main = document.querySelector("main");
const kwLane = document.querySelector("#kw");
const semLane = document.querySelector("#sem");
const chips = [...document.querySelectorAll(".chip")];

drawContours(document.querySelector("svg.topo"));

let loaded = false;
async function bar() {
  if (!loaded) {
    loaded = true;
    await import("../src/content.js"); // first import opens the bar
  }
  return window.__semanticCtrlF;
}

document.addEventListener("keydown", async (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    const wasLoaded = loaded;
    const b = await bar();
    if (wasLoaded) b.toggle();
  }
});

let raceSeq = 0;
for (const chip of chips) {
  chip.addEventListener("click", async () => {
    const seq = ++raceSeq;
    const q = chip.textContent.trim();
    chips.forEach((c) => c.setAttribute("aria-pressed", c === chip));

    // Lane 1: what the browser's Ctrl+F would find, an exact case-insensitive match.
    const n = main.innerText.toLowerCase().split(q.toLowerCase()).length - 1;
    kwLane.innerHTML = `<div class="big">${n} ${n === 1 ? "match" : "matches"}</div>
      <div class="sub">for “${escapeHtml(q)}”</div>`;

    // Lane 2: the semantic bar.
    const firstRun = !loaded;
    semLane.innerHTML = `<span class="idle">${firstRun
      ? "Loading the model. The first run downloads about 160 MB; progress shows in the search bar."
      : "Searching…"}</span>`;
    activeQuery = q;
    const b = await bar();
    b.onResults = renderSemantic;
    const res = await b.query(q);
    if (seq === raceSeq && !res) activeQuery = null;
  });
}

// Fires for every search, including refreshes while the page is still being
// read, so the lane always shows the bar's latest answer.
let activeQuery = null;
function renderSemantic(res) {
  if (res.query !== activeQuery) return;
  const top = res.hits[0];
  if (!top) {
    semLane.innerHTML = `<span class="idle">No passage found. Reload the page and try again.</span>`;
    return;
  }
  semLane.innerHTML = `
    <div class="big">${escapeHtml(top.title)}</div>
    <p class="quote">${escapeHtml(top.text)}</p>
    <div class="sub"><span class="num">${top.score.toFixed(2)} similarity</span> · ${res.ms} ms ·
      ${res.partial ? "still reading the page" : `<button class="jump" type="button">Show me</button>`}</div>`;
  semLane.querySelector(".jump")?.addEventListener("click", () =>
    top.el.scrollIntoView({ behavior: "smooth", block: "center" }));
}

// Blaze the table-of-contents entries whose section holds a highlighted
// match, whichever way the search was started.
const tocLinks = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.hash.slice(1), a]));
let tocFrame = 0;
new MutationObserver(() => {
  cancelAnimationFrame(tocFrame);
  tocFrame = requestAnimationFrame(() => {
    const found = new Set();
    for (const el of main.querySelectorAll(".sctrlf-hit")) {
      let h = el.previousElementSibling;
      while (h && h.tagName !== "H2") h = h.previousElementSibling;
      if (h) found.add(h.id);
    }
    for (const [id, a] of tocLinks) a.classList.toggle("found", found.has(id));
  });
}).observe(main, { subtree: true, attributes: true, attributeFilter: ["class"] });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Topographic contour rings around two summits, the header's backdrop.
function drawContours(svg) {
  const W = 1200, H = 600;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const summits = [
    { x: 980, y: 140, rings: 14, step: 30, seed: 0.7 },
    { x: 140, y: 560, rings: 11, step: 34, seed: 2.1 },
  ];
  const paths = [];
  for (const s of summits) {
    for (let k = 1; k <= s.rings; k++) {
      let d = "";
      for (let i = 0; i <= 96; i++) {
        const t = (i / 96) * Math.PI * 2;
        const wobble = 1 + 0.11 * Math.sin(3 * t + k * 0.35 + s.seed) + 0.06 * Math.sin(5 * t + s.seed * 2) + 0.04 * Math.sin(2 * t + k * 0.21);
        const r = k * s.step * wobble;
        d += `${i ? "L" : "M"}${(s.x + r * Math.cos(t)).toFixed(1)} ${(s.y + r * 0.78 * Math.sin(t)).toFixed(1)}`;
      }
      paths.push(`<path d="${d}Z"${k % 5 === 0 ? ' class="index"' : ""}/>`);
    }
  }
  svg.innerHTML = paths.join("");
}
