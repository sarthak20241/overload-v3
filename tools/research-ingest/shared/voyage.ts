/**
 * Voyage 3 embedding wrappers. Same model and dimensionality (1024) as the
 * seed script — asymmetric input_type ('document' here, 'query' in the coach
 * edge function at retrieval time).
 *
 * Batches up to 128 inputs per call. Voyage's 320k-token total cap is well
 * above what we hit per single-paper passage, but we batch when we can.
 */
import { VOYAGE_API_KEY } from './env.js';
import { logUsage } from './usage.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';

async function embedBatch(
  inputs: string[],
  inputType: 'document' | 'query',
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const startMs = Date.now();
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: inputs,
      model: MODEL,
      input_type: inputType,
    }),
  });
  const latencyMs = Date.now() - startMs;

  // Pipeline name encodes whether this is ingest-time doc embed or
  // retrieval-time query embed — separate buckets on the Cost page.
  const pipeline = inputType === 'query' ? 'embed_query' : 'embed_ingest';

  if (!res.ok) {
    void logUsage({
      pipeline,
      provider: 'voyage',
      model: MODEL,
      latency_ms: latencyMs,
      status: 'error',
      error_message: `${res.status}`,
      metadata: { batch_size: inputs.length, input_type: inputType },
    });
    throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const tokens = body.usage?.total_tokens ?? 0;

  // Voyage charges only input tokens (no concept of output). Map to
  // input_tokens column so the cost calc works.
  void logUsage({
    pipeline,
    provider: 'voyage',
    model: MODEL,
    input_tokens: tokens,
    latency_ms: latencyMs,
    status: 'success',
    metadata: { batch_size: inputs.length, input_type: inputType },
  });
  return body.data.map((d: { embedding: number[] }) => d.embedding);
}

export async function embedDocument(input: string): Promise<number[]> {
  const [vec] = await embedBatch([input.slice(0, 32000)], 'document');
  return vec;
}

/**
 * Batch multiple document passages in a single Voyage call. Used by the
 * orchestrator to embed BOTH the HyDE passage AND the source abstract for
 * the plagiarism guard in one HTTP round-trip — halves API spend and rate-
 * limit pressure. Returns embeddings in the same order as inputs.
 */
export async function embedDocumentsBatch(inputs: string[]): Promise<number[][]> {
  return embedBatch(inputs.map((s) => s.slice(0, 32000)), 'document');
}

export async function embedQuery(input: string): Promise<number[]> {
  const [vec] = await embedBatch([input.slice(0, 8000)], 'query');
  return vec;
}

/**
 * Cosine similarity for the plagiarism guard. Voyage embeddings are not
 * pre-normalized — divide by magnitudes.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
