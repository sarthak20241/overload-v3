/**
 * Backfill voyage-3 document embeddings for global catalog foods (0080).
 *
 * Embeds "name [brand], category" per food so search_foods_semantic can
 * bridge synonyms the trigram search cannot ("roasted edamame" -> "Soybeans,
 * mature seeds, roasted, salted"). Idempotent: only rows with a null
 * embedding are touched, so rerun after any large seed load (OFF-backfilled
 * rows from parse_meal accumulate without embeddings until the next run).
 *
 * Run from a checkout root that has .env.local (or export the vars):
 *   npx tsx scripts/diet-catalog/backfill-food-embeddings.ts
 * Needs: EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY
 * Cost: ~32k foods = ~200k voyage tokens (~$0.02).
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadDotEnvLocal(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const dotenv = loadDotEnvLocal();
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";

const SUPABASE_URL = env("EXPO_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const VOYAGE_API_KEY = env("VOYAGE_API_KEY");
if (!SUPABASE_URL || !SERVICE_KEY || !VOYAGE_API_KEY) {
  console.error("Need EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY (env or .env.local).");
  process.exit(1);
}

const VOYAGE_BATCH = 128;          // voyage-3 max inputs per request
const UPDATE_CONCURRENCY = 16;
// Free-tier voyage keys are limited to 3 RPM / 10K TPM; a paid key takes
// VOYAGE_RPM=60 or higher. Batches of 128 short names stay well under TPM.
// A bad value here silently disables pacing (NaN gap) and turns the 429 retry
// into a hot loop, so refuse it rather than fall back to something plausible.
const VOYAGE_RPM = Number(process.env.VOYAGE_RPM || "3");
if (!Number.isFinite(VOYAGE_RPM) || VOYAGE_RPM <= 0) {
  console.error(`VOYAGE_RPM must be a positive number, got ${JSON.stringify(process.env.VOYAGE_RPM)}.`);
  process.exit(1);
}
const REQUEST_GAP_MS = Math.ceil(60_000 / VOYAGE_RPM);

interface FoodRow { id: string; name: string; brand: string | null; food_category: string | null }

function embedText(f: FoodRow): string {
  const brand = f.brand ? ` ${f.brand}` : "";
  const cat = f.food_category && f.food_category !== "other" ? `, ${f.food_category}` : "";
  return `${f.name}${brand}${cat}`.slice(0, 200);
}

let lastRequestMs = 0;

async function voyageEmbed(texts: string[]): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestMs + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestMs = Date.now();
    let res: Response;
    try {
      res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${VOYAGE_API_KEY}` },
        body: JSON.stringify({ input: texts, model: "voyage-3", input_type: "document" }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      // Network blip / laptop sleep: wait out and retry rather than dying
      // 20k rows into a paced overnight run.
      if (attempt >= 30) throw e;
      console.error(`  voyage fetch retry after: ${String(e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
      continue;
    }
    if (res.status === 429 && attempt < 30) {
      await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
      continue;
    }
    if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const out: number[][] = new Array(texts.length);
    for (const d of data.data) out[d.index] = d.embedding;
    return out;
  }
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let done = 0, failed = 0;
  // Cursor, not "always page 0": a row whose update fails keeps its null
  // embedding and would otherwise be re-selected at the head of the queue
  // forever. Walking id forward guarantees the sweep terminates; failures are
  // counted and can be picked up by a second run.
  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    // (idx_foods_embedding_pending keeps this fast; retry transient timeouts.)
    let rows: FoodRow[] = [];
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await supabase
        .from("foods")
        .select("id, name, brand, food_category")
        .is("embedding", null)
        .is("created_by", null)
        .gt("id", lastId)
        .order("id")
        .limit(VOYAGE_BATCH * 4);
      if (!error) { rows = (data ?? []) as FoodRow[]; break; }
      if (attempt >= 3) throw new Error(`select failed: ${error.message}`);
      console.error(`  select retry after: ${error.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    if (rows.length === 0) break;

    for (let i = 0; i < rows.length; i += VOYAGE_BATCH) {
      const batch = rows.slice(i, i + VOYAGE_BATCH);
      const vectors = await voyageEmbed(batch.map(embedText));
      for (let j = 0; j < batch.length; j += UPDATE_CONCURRENCY) {
        const slice = batch.slice(j, j + UPDATE_CONCURRENCY);
        const results = await Promise.all(slice.map(async (row, k) => {
          const vec = vectors[j + k];
          if (!vec) return false;
          const { error: upErr } = await supabase
            .from("foods")
            .update({ embedding: JSON.stringify(vec) })
            .eq("id", row.id);
          if (upErr) console.error(`  update failed ${row.id} (${row.name}): ${upErr.message}`);
          return !upErr;
        }));
        done += results.filter(Boolean).length;
        failed += results.filter((r) => !r).length;
      }
      process.stdout.write(`\r[embed] ${done} done, ${failed} failed`);
    }
    lastId = rows[rows.length - 1].id;
  }
  console.log(`\n[embed] complete: ${done} embedded, ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
