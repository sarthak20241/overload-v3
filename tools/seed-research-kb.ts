/**
 * One-off seeding script. Loads supabase/seed/research_kb.json, embeds each
 * entry via Voyage 3 (document-mode), and UPSERTs into research_kb on prod.
 *
 * Why not an edge function: this is a manual one-shot before Phase 3's
 * pipeline lands. Easier to debug locally with fast iteration than to deploy
 * + invoke an edge function.
 *
 * Required env vars:
 *   VOYAGE_API_KEY              — https://www.voyageai.com/ -> dashboard -> API keys
 *   SUPABASE_URL                — falls back to EXPO_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — Supabase Dashboard -> Settings -> API
 *
 * Run with:
 *   npx tsx tools/seed-research-kb.ts
 *
 * Idempotent — UPSERTs on the url unique constraint, so re-running is safe.
 */
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Auto-load .env.local so the user only has to export the secret-ish keys.
// Tiny .env parser — no dotenv dep needed for a one-off script.
const ENV_LOCAL = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(ENV_LOCAL)) {
  for (const raw of readFileSync(ENV_LOCAL, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!VOYAGE_API_KEY) {
  console.error('VOYAGE_API_KEY env var is required.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.');
  process.exit(1);
}

interface SeedEntry {
  source: string;
  url: string;
  title: string;
  authors: string[];
  journal: string;
  year: number;
  topic_tags: string[];
  population: string;
  intervention: string;
  key_finding: string;
  practical_takeaway: string;
  study_design: string;
  confidence: string;
  trust_score: number;
}

// Voyage 3 — asymmetric retrieval: input_type="document" for ingest, "query" at lookup.
// Up to 128 inputs and 320k total tokens per request. 30 entries fits one call.
async function embedDocuments(inputs: string[]): Promise<number[][]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: inputs,
      model: 'voyage-3',
      input_type: 'document',
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  console.log(
    `  Voyage tokens: ${body.usage?.total_tokens ?? '?'}, model: ${body.model}`,
  );
  return body.data.map((d: { embedding: number[] }) => d.embedding);
}

// Build the passage we embed. Title + key finding + takeaway + topical
// hooks gives a balanced representation. Phase 2.5 can swap this for a
// HyDE-on-write generation if eval shows retrieval misses.
function passageFor(e: SeedEntry): string {
  return [
    e.title,
    `Key finding: ${e.key_finding}`,
    `Practical takeaway: ${e.practical_takeaway}`,
    `Topics: ${e.topic_tags.join(', ')}`,
    `Population: ${e.population}`,
    `Study design: ${e.study_design}`,
  ].join('\n\n');
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const seedPath = join(here, '..', 'supabase', 'seed', 'research_kb.json');
  const entries: SeedEntry[] = JSON.parse(await readFile(seedPath, 'utf8'));
  console.log(`Loaded ${entries.length} seed entries from ${seedPath}\n`);

  // No-op guard: empty seed file would crash on `embeddings[0].length` below.
  // Treat zero entries as a successful no-op so re-runs on an empty seed
  // (or accidental empty array) don't blow up.
  if (entries.length === 0) {
    console.log('Seed file is empty — nothing to embed or upsert. Exiting.');
    return;
  }

  console.log(`Embedding ${entries.length} passages via Voyage 3 …`);
  const embeddings = await embedDocuments(entries.map(passageFor));
  if (embeddings.length !== entries.length) {
    throw new Error(
      `Voyage returned ${embeddings.length} embeddings for ${entries.length} inputs`,
    );
  }
  console.log(`  ✓ ${embeddings.length} embeddings received, dim=${embeddings[0].length}\n`);

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`UPSERTing into research_kb …`);
  const rows = entries.map((e, i) => ({
    source: e.source,
    url: e.url,
    title: e.title,
    authors: e.authors,
    journal: e.journal ?? null,
    pub_year: e.year ?? null,
    topic_tags: e.topic_tags,
    study_design: e.study_design ?? null,
    confidence: e.confidence ?? null,
    population: e.population ?? null,
    intervention: e.intervention ?? null,
    key_finding: e.key_finding,
    practical_takeaway: e.practical_takeaway,
    trust_score: e.trust_score ?? 0.5,
    license: 'manual-curated',
    // pgvector accepts arrays serialized as JSON strings via the REST API.
    embedding: JSON.stringify(embeddings[i]),
    updated_at: new Date().toISOString(),
  }));

  // Batch in chunks to stay under PostgREST request size limits.
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('research_kb')
      .upsert(slice, { onConflict: 'url' });
    if (error) {
      console.error(`  ✗ chunk ${i / CHUNK + 1} failed:`, error);
      process.exit(1);
    }
    console.log(`  ✓ chunk ${i / CHUNK + 1}: ${slice.length} rows`);
  }

  const { count } = await supabase
    .from('research_kb')
    .select('*', { count: 'exact', head: true });
  console.log(`\nDone. research_kb row count: ${count}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
