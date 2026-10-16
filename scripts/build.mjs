// Builds the unpacked extension into dist/. Load it via chrome://extensions →
// "Load unpacked". Pass --watch to rebuild on change.
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "ort"), { recursive: true });
mkdirSync(path.join(dist, "icons"), { recursive: true });

// Static files.
for (const f of ["manifest.json", "offscreen.html"]) cpSync(path.join(root, "src", f), path.join(dist, f));

// ONNX Runtime wasm must be packaged (MV3 bans remote code). Pick the files
// matching the onnxruntime-web version transformers.js actually resolves.
const ortDist = [
  "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist",
  "node_modules/onnxruntime-web/dist",
].map((p) => path.join(root, p)).find(existsSync);
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  cpSync(path.join(ortDist, f), path.join(dist, "ort", f));
}

for (const size of [16, 32, 48, 128]) writeFileSync(path.join(dist, "icons", `${size}.png`), drawIcon(size));

const common = { bundle: true, target: "chrome116", logLevel: "info", legalComments: "none" };
const configs = [
  { ...common, entryPoints: ["src/background.js"], outfile: "dist/background.js", format: "esm" },
  { ...common, entryPoints: ["src/offscreen.js"], outfile: "dist/offscreen.js", format: "esm", platform: "browser", minify: true },
  { ...common, entryPoints: ["src/content.js"], outfile: "dist/content.js", format: "iife" },
];

// Standalone demo page (mocked chrome APIs) for presenting and smoke-testing.
const demo = path.join(root, "demo-dist");
rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { recursive: true });
cpSync(path.join(root, "demo/index.html"), path.join(demo, "index.html"));
cpSync(path.join(dist, "ort"), path.join(demo, "ort"), { recursive: true });
configs.push({ ...common, entryPoints: ["demo/demo.js"], outfile: "demo-dist/demo.js", format: "esm", platform: "browser" });

if (watch) {
  for (const c of configs) await (await context({ ...c, absWorkingDir: root })).watch();
} else {
  await Promise.all(configs.map((c) => build({ ...c, absWorkingDir: root })));
}

// ---- icon: magnifier over a gradient tile, rasterized with simple AA ----
function drawIcon(n) {
  const px = Buffer.alloc(n * n * 4);
  const s = n / 128;
  const cx = 54 * s, cy = 54 * s, r = 30 * s, ring = 10 * s;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const fx = x + 0.5, fy = y + 0.5;
      // Rounded-square tile.
      const rad = 28 * s;
      const qx = Math.max(Math.abs(fx - n / 2) - (n / 2 - rad), 0);
      const qy = Math.max(Math.abs(fy - n / 2) - (n / 2 - rad), 0);
      const tile = clamp(rad - Math.hypot(qx, qy) + 0.5);
      const t = (fx + fy) / (2 * n);
      let [R, G, B] = [lerp(66, 156, t), lerp(133, 76, t), lerp(244, 230, t)];
      // Lens ring + handle in white.
      const dRing = Math.abs(Math.hypot(fx - cx, fy - cy) - r) - ring / 2;
      const hx0 = cx + r * 0.72, hy0 = cy + r * 0.72, hx1 = 104 * s, hy1 = 104 * s;
      const dHandle = segDist(fx, fy, hx0, hy0, hx1, hy1) - 8 * s;
      // Sparkle dot inside the lens: "meaning".
      const dDot = Math.hypot(fx - cx, fy - cy) - 9 * s;
      const white = Math.max(clamp(0.5 - Math.min(dRing, dHandle)), clamp(0.5 - dDot) * 0.9);
      R = lerp(R, 255, white); G = lerp(G, 255, white); B = lerp(B, 255, white);
      const i = (y * n + x) * 4;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = Math.round(255 * tile);
    }
  }
  return encodePng(n, n, px);
}
function segDist(px, py, ax, ay, bx, by) {
  const t = clamp(((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}
function clamp(v) { return Math.min(1, Math.max(0, v)); }
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
