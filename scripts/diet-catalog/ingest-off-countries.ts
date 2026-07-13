/**
 * OFF per-country popularity pull (ODbL, source 'off') -> a separate server seed.
 *
 * ingest-off-popular.ts pulls the GLOBAL most-scanned products (Europe-skewed). This
 * adds regional breadth: the most-scanned products WITHIN each target country, so the
 * catalog carries what people actually buy in the US, EU, UK, etc. — not just the
 * global head. Same English-name + complete-macro + plausibility filters (toRow) keep
 * it clean; dedupes against the brand + global-popular seeds so nothing is re-added.
 *
 * Run:    npx tsx scripts/diet-catalog/ingest-off-countries.ts
 * Output: supabase/seed/off_countries.generated.sql
 * Apply:  bash scripts/load-usda-seed.sh supabase/seed/off_countries.generated.sql
 * Reversible: rows are source='off' -> delete from public.foods where 'off'=any(sources);
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetchPage, toRow, emitSeed, type Row } from './ingest-off';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PRIOR_SEEDS = ['off_foods.generated.sql', 'off_popular.generated.sql'].map((f) => path.join(REPO_ROOT, 'supabase/seed', f));

// Target countries + how many usable rows to keep from each (India gets a deeper pull).
// `region` tags each row's origin for later region-biased suggestions.
const COUNTRIES: { tag: string; label: string; region: string; target: number }[] = [
  { tag: 'en:united-states', label: 'US', region: 'usa', target: 600 },
  { tag: 'en:united-kingdom', label: 'UK', region: 'uk', target: 500 },
  { tag: 'en:india', label: 'India', region: 'india', target: 700 },
  { tag: 'en:france', label: 'France', region: 'france', target: 400 },
  { tag: 'en:germany', label: 'Germany', region: 'germany', target: 400 },
  { tag: 'en:italy', label: 'Italy', region: 'italy', target: 300 },
  { tag: 'en:spain', label: 'Spain', region: 'spain', target: 300 },
  { tag: 'en:canada', label: 'Canada', region: 'canada', target: 300 },
  { tag: 'en:australia', label: 'Australia', region: 'australia', target: 300 },
];
const MAX_PAGES = 60;        // 60 * 100 = 6000 scanned/country, inside the 10k window
const PAGE_SIZE = 100;
const SORT = '-unique_scans_n';
const REQ_DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Barcodes already in the brand + global-popular seeds — skip so we don't re-add them. */
function priorBarcodes(): Set<string> {
  const set = new Set<string>();
  for (const file of PRIOR_SEEDS) {
    try {
      const sql = fs.readFileSync(file, 'utf8');
      const re = /'(\d{6,14})','off',array\['off'\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) set.add(m[1]);
    } catch { /* seed may not exist yet */ }
  }
  return set;
}

async function collectCountry(tag: string, label: string, region: string, target: number, seenCode: Set<string>, seenName: Set<string>, out: Row[]) {
  const query = `countries_tags:"${tag}"`;
  let page = 1, scanned = 0, kept = 0;
  while (page <= MAX_PAGES && kept < target) {
    const { hits, count } = await fetchPage(query, page, SORT);
    if (!hits.length) break;
    for (const hit of hits) {
      scanned++;
      const code = hit.code ? String(hit.code) : '';
      if (code && seenCode.has(code)) continue;
      const row = toRow(hit, 'fmcg'); // keyword category, base_unit auto (ml for liquids)
      if (!row) continue;
      row.region = region; // tag with the country this pull is scoped to
      const nameKey = row.name.toLowerCase();
      if (seenName.has(nameKey)) continue;
      seenName.add(nameKey);
      if (code) seenCode.add(code);
      out.push(row);
      kept++;
      if (kept >= target) break;
    }
    if (page * PAGE_SIZE >= count) break;
    page++;
    await sleep(REQ_DELAY_MS);
  }
  console.log(`  ${label.padEnd(10)} scanned ${String(scanned).padStart(4)} -> kept ${kept}`);
}

async function main() {
  const seenCode = priorBarcodes();
  const seenName = new Set<string>();
  console.log(`[countries] skipping ${seenCode.size} barcodes already in the brand + popular seeds`);
  const rows: Row[] = [];
  for (const c of COUNTRIES) await collectCountry(c.tag, c.label, c.region, c.target, seenCode, seenName, rows);

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const ml = rows.filter((r) => r.base_unit === 'ml').length;
  const cats = rows.reduce<Record<string, number>>((m, r) => ((m[r.food_category] = (m[r.food_category] ?? 0) + 1), m), {});
  console.log(`\n[countries] ${rows.length} new rows (${ml} liquid/ml)`);
  console.log(`[countries] categories: ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  emitSeed(rows, 'off_countries.generated.sql');
  console.log('[done] OFF per-country pull complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
