/**
 * OFF popularity-ranked GLOBAL pull (ODbL, source 'off') -> a separate server seed.
 *
 * The brand allowlist (ingest-off.ts) is curated + partly India-scoped. This adds
 * global BREADTH the neutral way: OFF's most-scanned products worldwide, sorted by
 * `-unique_scans_n`. Captures the globally-recognized items people actually log
 * (Nutella, Coca-Cola, Oreo/Prince, Lindt, nuts...). English-named + complete-macro
 * + plausibility filters (reused from ingest-off's toRow) keep it clean.
 *
 * Caveat: OFF's user base is Europe-heavy (French especially), so the long tail
 * skews European. That is the most global free branded data that exists; USDA (US
 * generics) + this + the curated dishes together span the catalog.
 *
 * Separate seed (off_popular.generated.sql) on purpose: loading it must NOT disturb
 * the already-enriched brand rows' servings. These rows keep search-a-licious macros
 * (incl. fiber/sugar/sat-fat/sodium) + a 100 g serving; product-API serving/micros
 * enrichment is optional and can run later (see enrich-off.ts).
 *
 * Run:    npx tsx scripts/diet-catalog/ingest-off-popular.ts
 * Output: supabase/seed/off_popular.generated.sql
 * Apply:  bash scripts/load-usda-seed.sh supabase/seed/off_popular.generated.sql
 * Reversible: rows are source='off' -> delete from public.foods where 'off'=any(sources);
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetchPage, toRow, emitSeed, type Row } from './ingest-off';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BRAND_SEED = path.join(REPO_ROOT, 'supabase/seed/off_foods.generated.sql');
const TARGET = 2500;      // usable global rows to collect
const MAX_PAGES = 90;     // 90 * 100 = 9000 scanned, inside OFF's 10k result window
const PAGE_SIZE = 100;    // must match ingest-off's PAGE_SIZE
const SORT = '-unique_scans_n';
const REQ_DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Barcodes already in the brand seed — skip so popular doesn't re-add brand rows. */
function existingBarcodes(): Set<string> {
  const set = new Set<string>();
  try {
    const sql = fs.readFileSync(BRAND_SEED, 'utf8');
    const re = /'(\d{6,14})','off',array\['off'\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) set.add(m[1]);
  } catch { /* no brand seed yet — fine */ }
  return set;
}

async function main() {
  const seenCode = existingBarcodes();
  const seenName = new Set<string>();
  console.log(`[popular] skipping ${seenCode.size} barcodes already in the brand seed`);
  const rows: Row[] = [];
  let page = 1, scanned = 0;

  while (page <= MAX_PAGES && rows.length < TARGET) {
    const { hits, count } = await fetchPage('', page, SORT);
    if (!hits.length) break;
    for (const hit of hits) {
      scanned++;
      const code = hit.code ? String(hit.code) : '';
      if (code && seenCode.has(code)) continue;
      // 'fmcg' kind -> keyword-based category (generic packaged food), not forced supplement.
      const row = toRow(hit, 'fmcg');
      if (!row) continue;
      row.region = 'global'; // global popularity pull, not India-specific
      const nameKey = row.name.toLowerCase();
      if (seenName.has(nameKey)) continue;
      seenName.add(nameKey);
      if (code) seenCode.add(code);
      rows.push(row);
    }
    if (page % 10 === 0) console.log(`  page ${page}: scanned ${scanned}, kept ${rows.length}/${TARGET}`);
    if (page * PAGE_SIZE >= count) break;
    page++;
    await sleep(REQ_DELAY_MS);
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const withExt = rows.filter((r) => r.fiber_g != null || r.sugar_g != null || r.sat_fat_g != null || r.sodium_mg != null).length;
  const cats = rows.reduce<Record<string, number>>((m, r) => ((m[r.food_category] = (m[r.food_category] ?? 0) + 1), m), {});
  console.log(`\n[popular] ${rows.length} global rows (scanned ${scanned} popular products, ${withExt} with extended nutrients)`);
  console.log(`[popular] categories: ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  emitSeed(rows, 'off_popular.generated.sql');
  console.log('[done] OFF popularity pull complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
