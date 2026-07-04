// Phase E — free-exercise-db ingest EXECUTOR (writes to prod).
//
// Consumes the curated plan in dry-run-output.json:
//   - downloads each demo image from free-exercise-db
//   - uploads it to the public `exercise-images` Storage bucket (service role)
//   - rewrites image_urls to our own Storage public URLs
//   - inserts the row into `exercises` as a GLOBAL row (created_by null)
//
// Idempotent + resumable: re-running skips exercises whose name is already a
// global row with all its images, repairs rows whose image set came up short
// (transient fetch/upload failures), and image uploads use upsert. Run a
// small slice first to validate:
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

  // Global rows already present, with their stored image count (resumability).
  // Name alone isn't enough: a row inserted by an earlier run can hold a
  // partial/empty image_urls after transient fetch/upload failures, and
  // skipping it by name would leave it without thumbnails forever.
  const existing = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('exercises').select('id, name, image_urls').is('created_by', null).range(from, from + 999);
    if (error) throw error;
    data.forEach((r) => existing.set(r.name.toLowerCase(), { id: r.id, imgCount: r.image_urls?.length ?? 0 }));
    if (!data.length || data.length < 1000) break;
  }
  const todo = mapped.filter((m) => !existing.has(m.name.toLowerCase()));
  const repair = mapped.filter((m) => {
    const row = existing.get(m.name.toLowerCase());
    return row && row.imgCount < m.image_urls.length;
  });
  console.log(`Already present: ${mapped.length - todo.length} (${repair.length} missing images).  To ingest: ${todo.length}\n`);

  let imgOk = 0, imgFail = 0, rowsIn = 0, rowsRepaired = 0;

  // Mirror an exercise's demo images into our Storage bucket, returning our
  // public URLs for the ones that made it. Uploads upsert, so re-runs are safe.
  const mirrorImages = async (ex) => {
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
    return ourUrls;
  };

  for (let c = 0; c < todo.length; c += CHUNK) {
    const chunk = todo.slice(c, c + CHUNK);
    const rows = await pool(chunk, IMG_CONCURRENCY, async (ex) => ({
      name: ex.name,
      muscle_group: ex.muscle_group,
      category: ex.category,
      metric_type: ex.metric_type,
      instructions: ex.instructions ?? [],
      image_urls: await mirrorImages(ex),
      // created_by omitted -> null (service role has no JWT sub) -> global row.
    }));

    const { error } = await supabase.from('exercises').insert(rows);
    if (error) throw new Error(`insert failed at chunk ${c}: ${error.message}`);
    rowsIn += rows.length;
    console.log(`  +${rows.length} rows (${rowsIn}/${todo.length})  images ok:${imgOk} fail:${imgFail}`);
  }

  // Repair pass: rows from earlier runs that are short on images. Only write
  // when this run recovered more than what's stored, so a still-failing image
  // can't regress a previously good (but shorter) URL list.
  await pool(repair, IMG_CONCURRENCY, async (ex) => {
    const row = existing.get(ex.name.toLowerCase());
    const ourUrls = await mirrorImages(ex);
    if (ourUrls.length <= row.imgCount) return;
    const { error } = await supabase.from('exercises')
      .update({ image_urls: ourUrls }).eq('id', row.id);
    if (error) throw new Error(`image repair failed for "${ex.name}": ${error.message}`);
    rowsRepaired++;
  });
  if (repair.length) console.log(`  repaired images on ${rowsRepaired}/${repair.length} existing rows`);

  console.log(`\nDONE. rows inserted: ${rowsIn}, rows repaired: ${rowsRepaired}, images uploaded: ${imgOk}, image failures: ${imgFail}`);
}

main().catch((e) => { console.error('INGEST FAILED:', e); process.exit(1); });
