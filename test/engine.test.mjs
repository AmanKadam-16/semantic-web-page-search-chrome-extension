// Smoke test: loads the real model on CPU and checks semantic ranking.
// Run with `npm test` (first run downloads ~175 MB).
import assert from "node:assert/strict";
import { loadEngine, rank, MRL_DIMS } from "../src/engine.js";

const docs = [
  { title: "Shipping", text: "Orders ship within 2 business days from our warehouse in Ohio." },
  { title: "Returns", text: "Changed your mind? Send the item back within 30 days and we'll credit your card in full." },
  { title: "About us", text: "We started in a garage in 2014 making handmade leather wallets." },
  { title: "Care", text: "Wipe the leather with a damp cloth and apply conditioner twice a year." },
  { title: "Privacy", text: "Nous ne vendons jamais vos données personnelles à des tiers." },
];

const t0 = performance.now();
const engine = await loadEngine({ device: "cpu", dtype: "q4" });
console.log(`model loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const t1 = performance.now();
const vecs = await engine.embedDocs(docs);
console.log(`embedded ${docs.length} docs in ${(performance.now() - t1).toFixed(0)}ms`);

const cases = [
  ["where do they talk about refunds?", 1], // no word overlap with "credit your card"
  ["how do I clean it", 3],
  ["do they sell my data", 4], // cross-lingual: English query, French doc
];
for (const [query, expected] of cases) {
  const q = await engine.embedQuery(query);
  for (const dim of MRL_DIMS) {
    const top = rank(vecs, q, dim, 3);
    console.log(`[${dim}d] "${query}" →`, top.map((r) => `${docs[r.index].title} ${r.score.toFixed(3)}`).join(", "));
    assert.equal(top[0].index, expected, `${dim}d top hit for "${query}"`);
  }
}
console.log("ok");
