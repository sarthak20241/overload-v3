/**
 * Open Food Facts (ODbL) SUPPLEMENT / HEALTH-BRAND ingest from the BULK export.
 *
 * Used when OFF's search API is degraded (search-a-licious 502, legacy /api/v2/search
 * throttled). Instead of crawling per-brand, we stream the full nightly dump
 * (`openfoodfacts-products.jsonl.gz`, ~12 GB gz) once and keep every product that
 * matches a supplement CATEGORY tag OR a supplement/health BRAND tag
 * (allowlist.ts SUPPLEMENT_FILTER). Category-first = "all brands at once".
 *
 * Same segregation contract as ingest-off.ts: kept rows are source='off',
 * sources=['off'], complete per-100 macro panel + plausibility guarded, English/India
 * relevance filtered, brand-prefixed name. Emits a SEGREGATION-SAFE seed
 * (DO NOTHING on a name conflict with a non-off row; OFF servings attach only to OFF
 * rows). Reversible: delete from public.foods where 'off' = any(sources);
 *
 * Run:    npx tsx scripts/diet-catalog/ingest-off-supplements.ts <path-to-products.jsonl.gz>
 * Output: supabase/seed/off_supplements.generated.sql  (+ a .report.json summary)
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { SUPPLEMENT_FILTER } from './allowlist';
import { cleanName, emitSeed, type OffHit, type Row } from './ingest-off';

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmtAmount = (n: number) => (Number.isInteger(n) ? String(n) : String(round1(n)));

// Normalize a brand string to an OFF brand slug ("As-It-Is Nutrition" -> "as-it-is-nutrition").
const toTag = (b: string) => b.toLowerCase().trim().replace(/[\s']+/g, '-').replace(/-+/g, '-');
// OFF brands_tags carry a language prefix ("xx:optimum-nutrition", sometimes "en:..."),
// so compare on the prefix-stripped slug.
const stripPrefix = (t: string) => t.replace(/^[a-z]{2,3}:/, '');
const BRAND_TAGS = new Set(SUPPLEMENT_FILTER.brands.map(toTag));
const CATEGORY_TAGS = new Set(SUPPLEMENT_FILTER.categoryTags);

/** Liquids -> base_unit 'ml' (RTD shakes, protein waters). Mirrors ingest-off.ts. */
const LIQUID_RE = /\b(milk|milkshake|shake|smoothie|juice|drink|beverage|soda|water|latte|iced\s*tea|electrolyte|isotonic|hydration|rtd)\b/i;

/** Category for a supplement-sweep hit: powders/gainers/aminos -> supplement,
 *  bars -> snack, RTD shakes/waters -> beverage, else supplement (this is a
 *  supplement pass, so default to supplement rather than 'other'). */
function categoryFor(hit: OffHit, name: string): string {
  const tags = (hit.categories_tags ?? []).filter((t) => !t.includes('foods-and-beverages'));
  const hay = (tags.join(' ') + ' ' + name).toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => hay.includes(w));
  if (has('bar', 'cookie', 'wafer', 'brownie', 'flapjack')) return 'snack';
  if (has('shake', 'drink', 'beverage', 'juice', 'water', 'rtd', 'smoothie', 'latte', 'electrolyte', 'isotonic', 'hydration')) return 'beverage';
  return 'supplement';
}

function baseUnitFor(category: string, name: string): 'g' | 'ml' {
  if (category === 'beverage') return 'ml';
  if (LIQUID_RE.test(name)) return 'ml';
  return 'g';
}

/** Does this product fall in our supplement/health net? */
function matches(hit: OffHit): boolean {
  const cats = hit.categories_tags ?? [];
  for (const c of cats) if (CATEGORY_TAGS.has(c)) return true;
  const brands = hit.brands_tags ?? [];
  for (const b of brands) if (BRAND_TAGS.has(stripPrefix(b))) return true;
  return false;
}

/** Bulk-dump row builder. Same guards/naming as ingest-off.ts toRow, but classifies
 *  category with the supplement-biased mapper and region from countries_tags. */
function toRow(hit: OffHit): Row | null {
  const n = hit.nutriments ?? {};
  const kcal = n['energy-kcal_100g'];
  const protein = n['proteins_100g'];
  const carb = n['carbohydrates_100g'];
  const fat = n['fat_100g'];
  if ([kcal, protein, carb, fat].some((v) => v == null || Number.isNaN(v))) return null;
  if (!(kcal > 0) || kcal > 900) return null;
  for (const v of [protein, carb, fat]) if (v < 0 || v > 100) return null;
  if (protein + carb + fat > 105) return null;
  // Atwater consistency: the label's kcal should roughly track its macros. OFF has
  // crowd-sourced rows where they wildly disagree (e.g. "37 kcal" with 25 g protein +
  // 48 g carb). Drop gross mismatches; keep a wide band so fiber / sugar-alcohols
  // (which read low) and rounding don't cause false drops.
  const atwater = 4 * (protein + carb) + 9 * fat;
  if (atwater > 80 && (kcal < atwater * 0.4 || kcal > atwater * 1.8)) return null;

  const isIndia = (hit.countries_tags ?? []).includes('en:india');
  const nameEn = (hit.product_name_en ?? '').trim();
  const rawName = nameEn || ((hit.lang === 'en' || isIndia) ? (hit.product_name ?? '').trim() : '');
  if (rawName.length < 2) return null;

  // `brands` in the bulk dump is a comma-separated string ("Optimum Nutrition, ON");
  // take the first listed brand.
  const brandStr = Array.isArray(hit.brands) ? hit.brands[0] : hit.brands ? String(hit.brands) : '';
  const brandRaw = (brandStr.split(',')[0] ?? '').trim();
  const brand = brandRaw ? cleanName(brandRaw).slice(0, 80) : null;
  let name = cleanName(rawName);
  if (brand && !name.toLowerCase().startsWith(brand.toLowerCase())) name = `${brand} ${name}`;
  name = name.slice(0, 120).trim();
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  if (letters < 2) return null;
  if (brand && name.toLowerCase() === brand.toLowerCase()) return null;
  const symbols = (name.match(/[^\p{L}\p{N}\s()&%.,'/\-]/gu) ?? []).length;
  if (symbols > 2) return null;

  const category = categoryFor(hit, name);
  const base_unit = baseUnitFor(category, name);

  const sodium_mg =
    n['sodium_100g'] != null ? Math.round(n['sodium_100g'] * 1000)
    : n['salt_100g'] != null ? Math.round((n['salt_100g'] / 2.5) * 1000)
    : null;

  const servings: Row['servings'] = [];
  const sq = typeof hit.serving_quantity === 'string' ? Number(hit.serving_quantity) : hit.serving_quantity;
  if (sq != null && sq > 0 && sq < 2000) {
    const label = (hit.serving_size && hit.serving_size.trim()) ? cleanName(hit.serving_size) : `1 serving (${fmtAmount(round1(sq))} ${base_unit})`;
    servings.push({ label: label.slice(0, 60), grams: round1(sq), is_default: true, seq: 0 });
  }
  // Add the canonical 100-unit fallback ONLY if the real serving didn't already clean
  // to exactly "100 g"/"100 ml" — otherwise both rows share (food_id, lower(label)),
  // which trips the servings upsert's ON CONFLICT ("cannot affect row a second time").
  const fallbackLabel = `100 ${base_unit}`;
  if (!servings.some((s) => s.label.toLowerCase() === fallbackLabel.toLowerCase())) {
    servings.push({ label: fallbackLabel, grams: 100, is_default: servings.length === 0, seq: 999 });
  }

  return {
    name,
    food_category: category,
    base_unit,
    kcal: Math.round(kcal),
    protein_g: round1(protein), carb_g: round1(carb), fat_g: round1(fat),
    fiber_g: n['fiber_100g'] != null ? round1(n['fiber_100g']) : null,
    sugar_g: n['sugars_100g'] != null ? round1(n['sugars_100g']) : null,
    sat_fat_g: n['saturated-fat_100g'] != null ? round1(n['saturated-fat_100g']) : null,
    sodium_mg,
    brand: brand ? brand.slice(0, 80) : null,
    barcode: hit.code ? String(hit.code).slice(0, 32) : null,
    region: isIndia ? 'india' : 'global',
    servings,
  };
}

async function main() {
  const gzPath = process.argv[2];
  // '-' reads plain (already-decompressed) JSONL from stdin — handy for piping a
  // partial `gzcat file | tsx ... -` while the full .gz is still downloading.
  const fromStdin = gzPath === '-';
  if (!fromStdin && (!gzPath || !fs.existsSync(gzPath))) {
    console.error('usage: npx tsx ingest-off-supplements.ts <path-to-products.jsonl.gz | ->');
    process.exit(1);
  }
  console.log(`[supp] streaming ${fromStdin ? 'stdin (plain jsonl)' : gzPath}`);
  console.log(`[supp] ${CATEGORY_TAGS.size} category tags, ${BRAND_TAGS.size} brand tags`);

  const input = fromStdin
    ? process.stdin
    : fs.createReadStream(gzPath).pipe(zlib.createGunzip());
  // tolerate a truncated tail (e.g. testing against a partial download)
  input.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'Z_BUF_ERROR' || /unexpected end/i.test(e.message)) return;
    console.warn(`[supp] stream error: ${e.message}`);
  });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const rows: Row[] = [];
  const seenName = new Set<string>();
  const seenCode = new Set<string>();
  const brandCounts = new Map<string, number>();
  let lines = 0, matched = 0, kept = 0, badJson = 0;
  const t0 = Date.now();

  for await (const line of rl) {
    lines++;
    if (lines % 200000 === 0) {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ...scanned ${lines.toLocaleString()} | matched ${matched} | kept ${kept} | ${secs}s`);
    }
    if (!line || line.length < 2) continue;
    let hit: OffHit;
    try { hit = JSON.parse(line) as OffHit; } catch { badJson++; continue; }
    if (!matches(hit)) continue;
    matched++;
    const code = hit.code ? String(hit.code) : '';
    if (code && seenCode.has(code)) continue;
    const row = toRow(hit);
    if (!row) continue;
    const nameKey = row.name.toLowerCase();
    if (seenName.has(nameKey)) continue;
    seenName.add(nameKey);
    if (code) seenCode.add(code);
    rows.push(row);
    kept++;
    if (row.brand) brandCounts.set(row.brand, (brandCounts.get(row.brand) ?? 0) + 1);
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const withServing = rows.filter((r) => r.servings.some((s) => s.seq === 0)).length;
  const withExt = rows.filter((r) => r.fiber_g != null || r.sugar_g != null || r.sat_fat_g != null || r.sodium_mg != null).length;
  const byRegion = rows.reduce<Record<string, number>>((a, r) => ((a[r.region ?? '?'] = (a[r.region ?? '?'] ?? 0) + 1), a), {});
  const byCategory = rows.reduce<Record<string, number>>((a, r) => ((a[r.food_category] = (a[r.food_category] ?? 0) + 1), a), {});
  const topBrands = [...brandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

  console.log(`\n[supp] scanned ${lines.toLocaleString()} lines in ${secs}s (${badJson} bad json)`);
  console.log(`[supp] matched ${matched} supplement/health products -> ${rows.length} kept after guards`);
  console.log(`[supp]   ${withServing} with a real serving, ${withExt} with extended nutrients`);
  console.log(`[supp]   region:`, byRegion);
  console.log(`[supp]   category:`, byCategory);
  console.log(`[supp]   top brands:`, topBrands.map(([b, c]) => `${b}(${c})`).join(', '));

  emitSeed(rows, 'off_supplements.generated.sql');

  const report = {
    generatedAt: new Date(t0).toISOString(),
    scannedLines: lines, matched, kept: rows.length,
    withRealServing: withServing, withExtendedNutrients: withExt,
    byRegion, byCategory, topBrands,
  };
  fs.writeFileSync(gzPath.replace(/[^/]+$/, '') + 'off_supplements.report.json', JSON.stringify(report, null, 2));
  console.log('[done] supplement ingest complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
