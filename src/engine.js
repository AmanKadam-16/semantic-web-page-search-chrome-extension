// Text-only EmbeddingGemma 2 engine. Shared by the extension's offscreen
// document and the Node smoke test, so it must not touch `chrome.*`.
import { AutoConfig, AutoModel, AutoTokenizer } from "@huggingface/transformers";

export const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
export const FULL_DIM = 768;
export const MRL_DIMS = [768, 512, 256, 128];

// EmbeddingGemma 2 is trained with task prefixes; retrieval is asymmetric.
export const queryPrefix = (q) => `task: search result | query: ${q}`;
export const docPrefix = (text, title) => `title: ${title || "none"} | text: ${text}`;

const MAX_TOKENS = 512; // page paragraphs rarely need more; keeps batches fast
// Benchmarked on WebGPU (q4, 300 passages): batches of 8 padded to their longest
// beat 32-wide batches and token-budget bucketing by 15–55%; the model is
// compute-bound, so extra padding costs more than fewer dispatches save.
const BATCH_SIZE = 8;
// Passages are embedded in growing waves in the caller's priority order
// (nearest the viewport first), so early searches already cover what the
// reader is looking at. Within a wave they are sorted by length to cut padding.
const WAVES = [16, 48, 128, 256];

export async function loadEngine({ device, dtype = "q4", onProgress } = {}) {
  // Drop the vision and audio encoders: 270M text-only instead of 740M.
  const config = await AutoConfig.from_pretrained(MODEL_ID);
  config.vision_config = null;
  config.audio_config = null;

  const progress_callback = (p) => {
    if (p.status === "progress_total") onProgress?.({ phase: "download", loaded: p.loaded, total: p.total });
  };
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback });
  const model = await AutoModel.from_pretrained(MODEL_ID, { config, device, dtype, progress_callback });

  async function embed(texts) {
    const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: MAX_TOKENS });
    const { sentence_embedding } = await model(inputs);
    return sentence_embedding.data; // Float32Array, rows of FULL_DIM, L2-normalized
  }

  return {
    /**
     * Embeds page chunks into `out` (n * FULL_DIM floats, row per doc).
     * `priority` lists doc indices in the order they should become searchable;
     * `onBatch(ids)` fires after each batch's rows are written. `isCancelled`
     * stops the work early (e.g. the page changed).
     */
    async embedDocs(docs, { out = new Float32Array(docs.length * FULL_DIM), priority, onBatch, isCancelled } = {}) {
      const queue = priority ?? docs.map((_, i) => i);
      let start = 0;
      for (let w = 0; start < queue.length; w++) {
        const size = WAVES[w] ?? Infinity;
        const wave = queue.slice(start, start + size).sort((a, b) => docs[a].text.length - docs[b].text.length);
        start += wave.length;
        for (let b = 0; b < wave.length; b += BATCH_SIZE) {
          if (isCancelled?.()) return out;
          const ids = wave.slice(b, b + BATCH_SIZE);
          const vecs = await embed(ids.map((i) => docPrefix(docs[i].text, docs[i].title)));
          ids.forEach((docIdx, row) => out.set(vecs.subarray(row * FULL_DIM, (row + 1) * FULL_DIM), docIdx * FULL_DIM));
          onBatch?.(ids);
        }
      }
      return out;
    },
    async embedQuery(query) {
      return (await embed([queryPrefix(query)])).slice(0, FULL_DIM);
    },
  };
}

/**
 * Cosine-ranks docs against a query at a Matryoshka dimension. Truncated
 * vectors are re-normalized, as the model card requires.
 */
export function rank(docVecs, queryVec, dim = FULL_DIM, topK = 10, ready = null) {
  const n = docVecs.length / FULL_DIM;
  const q = normalized(queryVec, 0, dim);
  const scores = [];
  for (let i = 0; i < n; i++) {
    if (ready && !ready[i]) continue; // not embedded yet
    const off = i * FULL_DIM;
    let dot = 0, norm = 0;
    for (let d = 0; d < dim; d++) {
      const v = docVecs[off + d];
      dot += v * q[d];
      norm += v * v;
    }
    scores.push({ index: i, score: dot / (Math.sqrt(norm) || 1) });
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, topK);
}

function normalized(vec, off, dim) {
  const out = new Float32Array(dim);
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += vec[off + d] ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) out[d] = vec[off + d] / norm;
  return out;
}
