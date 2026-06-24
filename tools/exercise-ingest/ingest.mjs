// Phase E — free-exercise-db ingest EXECUTOR (writes to prod).
//
// Consumes the curated plan in dry-run-output.json:
//   - downloads each demo image from free-exercise-db
//   - uploads it to the public `exercise-images` Storage bucket (service role)
//   - rewrites image_urls to our own Storage public URLs
//   - inserts the row into `exercises` as a GLOBAL row (created_by null)
//
// Idempotent + resumable: re-running skips exercises whose name is already a
// global row, and image uploads use upsert. Run a small slice first to validate:
//
//   node tools/exercise-ingest/ingest.mjs --limit 3
//   node tools/exercise-ingest/ingest.mjs            # full run
//
// Needs EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read from .env.local).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BUCKET = 'exercise-images';
const CHUNK = 20;          // exercises per insert batch (resumable granularity)
const IMG_CONCURRENCY = 5; // parallel image up/downloads within a chunk

const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();

async function loadEnv() {
  const raw = await readFile(join(ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const contentTypeFor = (path) =>
  /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg';

// Run async tasks with a small concurrency cap.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

async function main() {
  const env = await loadEnv();
  const URL = env.EXPO_PUBLIC_SUPABASE_URL;
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  const plan = JSON.parse(await readFile(join(HERE, 'dry-run-output.json'), 'utf8'));
  let mapped = plan.mapped;
  if (Number.isFinite(argLimit)) mapped = mapped.slice(0, argLimit);
  console.log(`Plan: ${mapped.length} exercises${Number.isFinite(argLimit) ? ' (limited)' : ''}`);

  // Skip exercises already present as a global row (resumability).
  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('exercises').select('name').is('created_by', null).range(from, from + 999);
    if (error) throw error;
    data.forEach((r) => existing.add(r.name.toLowerCase()));
    if (!data.length || data.length < 1000) break;
  }
  const todo = mapped.filter((m) => !existing.has(m.name.toLowerCase()));
  console.log(`Already present: ${mapped.length - todo.length}.  To ingest: ${todo.length}\n`);

  let imgOk = 0, imgFail = 0, rowsIn = 0;

  for (let c = 0; c < todo.length; c += CHUNK) {
    const chunk = todo.slice(c, c + CHUNK);
    const rows = await pool(chunk, IMG_CONCURRENCY, async (ex) => {
      const ourUrls = [];
      for (const srcUrl of ex.image_urls) {
        const path = srcUrl.split('/exercises/')[1]; // e.g. "Decline_Push-Up/0.jpg"
        if (!path) continue;
        try {
          const resp = await fetch(srcUrl);
          if (!resp.ok) { imgFail++; continue; }
          const buf = Buffer.from(await resp.arrayBuffer());
          const { error } = await supabase.storage.from(BUCKET)
            .upload(path, buf, { contentType: contentTypeFor(path), upsert: true });
          if (error) { imgFail++; continue; }
          ourUrls.push(supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
          imgOk++;
        } catch { imgFail++; }
      }
      return {
        name: ex.name,
        muscle_group: ex.muscle_group,
        category: ex.category,
        metric_type: ex.metric_type,
        instructions: ex.instructions ?? [],
        image_urls: ourUrls,
        // created_by omitted -> null (service role has no JWT sub) -> global row.
      };
    });

    const { error } = await supabase.from('exercises').insert(rows);
    if (error) throw new Error(`insert failed at chunk ${c}: ${error.message}`);
    rowsIn += rows.length;
    console.log(`  +${rows.length} rows (${rowsIn}/${todo.length})  images ok:${imgOk} fail:${imgFail}`);
  }

  console.log(`\nDONE. rows inserted: ${rowsIn}, images uploaded: ${imgOk}, image failures: ${imgFail}`);
}

main().catch((e) => { console.error('INGEST FAILED:', e); process.exit(1); });
