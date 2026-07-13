/**
 * Open Food Facts (ODbL) branded ingest -> the SERVER catalog seed.
 *
 * Layer 2 of the sourcing model (README.md): branded/packaged SKUs that USDA's
 * generic catalog can't cover. SEGREGATED per ODbL — every row is source='off',
 * sources=['off'], and we NEVER merge OFF values into a non-off (USDA/curated)
 * row. Attribution ships in-app (Settings -> Licenses); see README.
 *
 * Source: search-a-licious (https://search.openfoodfacts.org) — the modern OFF
 * query backend. The legacy /cgi/search.pl and /api/v2/search were returning 503
 * at build time; search-a-licious is up and is the supported programmatic search.
 *
 * Scope (allowlist.ts OFF_FILTER):
 *   - gym/supplement brands: kept GLOBALLY (relevant to lifters regardless of the
 *     product's country tag; India availability overlaps).
 *   - Indian FMCG brands: scoped server-side to countries_tags "en:india" (so we
 *     get Amul/Britannia/Nestlé-India, not Nestlé's 10k global SKUs).
 * Only products with a COMPLETE per-100 g macro panel (kcal+protein+carb+fat) and
 * plausible values are kept.
 *
 * Run:    npx tsx scripts/diet-catalog/ingest-off.ts
 * Output: supabase/seed/off_foods.generated.sql
 * Reversible: delete from public.foods where 'off' = any(sources);
 */

import fs from 'node:fs';
import path from 'node:path';
import { OFF_FILTER } from './allowlist';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SEARCH = 'https://search.openfoodfacts.org/search';
const UA = 'OverloadDietCatalog/1.0 (sarthakkumar131@gmail.com; https://tryoverload.app)';
const PAGE_SIZE = 100;
const GYM_MAX_PAGES = 6;   // cap global gym brands (e.g. myprotein 2288 -> <=600 raw)
const FMCG_MAX_PAGES = 12; // India-scoped FMCG brands are already small
const REQ_DELAY_MS = 350;  // be polite to the shared instance
const CHUNK = 300;         // foods per SQL batch

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmtAmount = (n: number) => (Number.isInteger(n) ? String(n) : String(round1(n)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Brand tier: gym supplements (global), Indian FMCG (India-scoped), QSR chains (global). */
export type Kind = 'gym' | 'fmcg' | 'restaurant';

const FIELDS = [
  'code', 'product_name', 'product_name_en', 'lang', 'brands', 'brands_tags',
  'categories_tags', 'countries_tags', 'nutriments', 'serving_quantity', 'serving_size', 'quantity',
].join(',');

export interface OffHit {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  lang?: string;
  brands?: string[] | string;
  brands_tags?: string[];
  categories_tags?: string[];
  countries_tags?: string[];
  serving_quantity?: number | string;
  serving_size?: string;
  quantity?: string;
  nutriments?: Record<string, number>;
}

export interface Row {
  name: string;
  food_category: string;
  base_unit: 'g' | 'ml';
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null; sugar_g: number | null; sat_fat_g: number | null; sodium_mg: number | null;
  brand: string | null;
  barcode: string | null;
  region: string | null; // where it's from/sold: 'india' | 'global' | a country name (overridden by the country pull)
  servings: { label: string; grams: number; is_default: boolean; seq: number }[];
}

export async function fetchPage(query: string, page: number, sort?: string): Promise<{ hits: OffHit[]; count: number }> {
  const sortParam = sort ? `&sort_by=${encodeURIComponent(sort)}` : '';
  const url = `${SEARCH}?q=${encodeURIComponent(query)}${sortParam}&page_size=${PAGE_SIZE}&page=${page}&fields=${encodeURIComponent(FIELDS)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { hits?: OffHit[]; count?: number };
      return { hits: d.hits ?? [], count: d.count ?? 0 };
    } catch (e) {
      if (attempt === 3) { console.warn(`  [warn] ${query} p${page}: ${String(e)} — giving up`); return { hits: [], count: 0 }; }
      await sleep(1500 * attempt);
    }
  }
  return { hits: [], count: 0 };
}

/** de-SHOUT all-caps OFF names ("HERSHEY'S" -> "Hershey's"), strip leading/trailing
 * junk (bullets, stray symbols the OFF community leaves in), collapse whitespace. */
export function cleanName(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim();
  t = t.replace(/[A-Z][A-Z'&.\-]{2,}/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
  t = t.replace(/^[^\p{L}\p{N}(]+/u, '').replace(/[^\p{L}\p{N})%.]+$/u, '').trim();
  return t;
}

/** Category heuristic: gym brands -> supplement; restaurant items lean prepared_dish;
 *  else keyword-map OFF tags + name. */
function categoryFor(hit: OffHit, kind: Kind, name: string): string {
  if (kind === 'gym') return 'supplement';
  // Drop OFF's giant umbrella tag "en:plant-based-foods-and-beverages" (on almost every
  // plant food) — its "...-and-beverages" substring was mis-flagging breads, taco shells,
  // meat-analogues etc. as beverages. Real drinks keep "en:beverages"/"en:...-beverages".
  const tags = (hit.categories_tags ?? []).filter((t) => !t.includes('foods-and-beverages'));
  const hay = (tags.join(' ') + ' ' + name).toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => hay.includes(w));
  if (kind === 'restaurant') {
    if (has('coffee', 'latte', 'frappuccino', 'cappuccino', 'tea', 'drink', 'beverage', 'shake', 'smoothie', 'juice', 'soda')) return 'beverage';
    if (has('ice-cream', 'ice cream', 'donut', 'doughnut', 'cookie', 'cake', 'muffin', 'dessert', 'sundae', 'brownie')) return 'sweet';
    return 'prepared_dish'; // burgers, pizza, wraps, fries, nuggets, meals
  }
  if (has('protein-powder', 'whey', 'gainer', 'creatine', 'supplement', 'bcaa')) return 'supplement';
  if (has('milk', 'cheese', 'yogurt', 'yoghurt', 'dahi', 'curd', 'paneer', 'butter', 'ghee', 'cream', 'dairy')) return 'dairy';
  if (has('chocolate', 'candy', 'ice-cream', 'ice cream', 'sweet', 'dessert', 'mithai', 'confection')) return 'sweet';
  if (has('biscuit', 'cookie', 'namkeen', 'chips', 'snack', 'wafer', 'crisps', 'bhujia')) return 'snack';
  if (has('juice', 'drink', 'beverage', 'soda', 'water', 'tea', 'coffee', 'lassi', 'shake')) return 'beverage';
  if (has('bread', 'cereal', 'flour', 'atta', 'oat', 'pasta', 'noodle', 'rice', 'poha', 'vermicelli', 'rusk')) return 'grain';
  if (has('oil', 'vanaspati')) return 'fat_oil';
  if (has('sauce', 'ketchup', 'pickle', 'chutney', 'masala', 'spice', 'condiment')) return 'condiment';
  return 'other';
}

// Liquids get base_unit 'ml' (nutrients are per 100 ml) so the app shows/handles them
// as volume, not weight — "milk should be ml", not grams.
const LIQUID_RE = /\b(milk|milkshake|shake|smoothie|juice|drink|beverage|soda|cola|coke|pepsi|sprite|fanta|lemonade|squash|nectar|water|beer|wine|cider|kombucha|lassi|buttermilk|chaas|latte|cappuccino|frappuccino|espresso|cold\s*brew|iced\s*tea|tonic|cordial|syrup)\b/i;
function baseUnitFor(category: string, name: string): 'g' | 'ml' {
  if (category === 'beverage') return 'ml';
  if (category === 'fat_oil' && /\boil\b/i.test(name)) return 'ml';
  if (LIQUID_RE.test(name)) return 'ml';
  return 'g';
}

/** Map an OFF hit to a catalog Row, or null if incomplete / implausible. */
export function toRow(hit: OffHit, kind: Kind): Row | null {
  const n = hit.nutriments ?? {};
  const kcal = n['energy-kcal_100g'];
  const protein = n['proteins_100g'];
  const carb = n['carbohydrates_100g'];
  const fat = n['fat_100g'];
  // complete macro panel required
  if ([kcal, protein, carb, fat].some((v) => v == null || Number.isNaN(v))) return null;
  // plausibility guards against dirty OFF rows
  if (!(kcal > 0) || kcal > 900) return null;
  for (const v of [protein, carb, fat]) if (v < 0 || v > 100) return null;
  if (protein + carb + fat > 105) return null;

  // English/India relevance: a large slice of OFF's global gym-brand entries are
  // French/German community rows (e.g. Optimum Nutrition is mostly fr). Keep only an
  // English-named product OR anything tagged for India. Prefer the explicit English
  // name when OFF has one, else the main name only if the product's language is en
  // (or it's an India product). Everything else is noise for our users -> skip.
  const isIndia = (hit.countries_tags ?? []).includes('en:india');
  const nameEn = (hit.product_name_en ?? '').trim();
  const rawName = nameEn || ((hit.lang === 'en' || isIndia) ? (hit.product_name ?? '').trim() : '');
  if (rawName.length < 2) return null;
  const brandArr = Array.isArray(hit.brands) ? hit.brands : hit.brands ? [hit.brands] : [];
  const brandRaw = brandArr[0]?.trim() || '';
  const brand = brandRaw ? cleanName(brandRaw).slice(0, 80) : null;
  // prepend brand so brand searches ("muscleblaze whey") match the name-ranked RPC
  let name = cleanName(rawName);
  if (brand && !name.toLowerCase().startsWith(brand.toLowerCase())) name = `${brand} ${name}`;
  name = name.slice(0, 120).trim();
  // junk guards: need real letters, not a bare brand, not a symbol-garbled OCR row
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  if (letters < 2) return null;
  if (brand && name.toLowerCase() === brand.toLowerCase()) return null;
  const symbols = (name.match(/[^\p{L}\p{N}\s()&%.,'/\-]/gu) ?? []).length;
  if (symbols > 2) return null;

  const category = categoryFor(hit, kind, name);
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
  // Only add the canonical 100-unit fallback if the real serving didn't already clean
  // to exactly "100 g"/"100 ml" — else emitSeed's servings upsert gets two rows with
  // the same (food_id, lower(label)) and Postgres errors "ON CONFLICT DO UPDATE command
  // cannot affect row a second time". Latent today (search-a-licious omits serving_quantity)
  // but real for any richer source (see ingest-off-supplements.ts).
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
    // FMCG pull is India-scoped -> 'india'; gym/restaurant are global. The popularity
    // and per-country pulls override row.region after toRow.
    region: kind === 'fmcg' ? 'india' : 'global',
    servings,
  };
}

async function collectBrand(tag: string, kind: Kind, seenName: Set<string>, seenCode: Set<string>, out: Row[]) {
  // FMCG is India-scoped; gym + restaurant chains are global (India coverage is thin).
  const country = kind === 'fmcg' ? ' AND countries_tags:"en:india"' : '';
  const query = `brands_tags:${tag}${country}`;
  const maxPages = kind === 'fmcg' ? FMCG_MAX_PAGES : GYM_MAX_PAGES;
  let page = 1, kept = 0, scanned = 0;
  while (page <= maxPages) {
    const { hits, count } = await fetchPage(query, page);
    if (!hits.length) break;
    for (const hit of hits) {
      scanned++;
      const code = hit.code ? String(hit.code) : '';
      if (code && seenCode.has(code)) continue;
      const row = toRow(hit, kind);
      if (!row) continue;
      const nameKey = row.name.toLowerCase();
      if (seenName.has(nameKey)) continue;
      seenName.add(nameKey);
      if (code) seenCode.add(code);
      out.push(row);
      kept++;
    }
    if (page * PAGE_SIZE >= count) break;
    page++;
    await sleep(REQ_DELAY_MS);
  }
  console.log(`  ${tag.padEnd(18)} scanned ${String(scanned).padStart(4)} -> kept ${kept}${kind === 'fmcg' ? ' (india)' : ''}`);
}

function esc(s: string) { return s.replace(/'/g, "''"); }
function num(n: number | null) { return n == null ? 'null' : String(n); }
function sqlStr(s: string | null) { return s == null ? 'null' : `'${esc(s)}'`; }

export function emitSeed(rows: Row[], filename = 'off_foods.generated.sql') {
  let sql = `-- GENERATED by scripts/diet-catalog/ingest-off.ts — do not edit by hand.
-- Open Food Facts (ODbL) branded catalog: ${rows.length} foods, source='off' (SEGREGATED).
-- Apply as SERVICE ROLE (created_by stays null = global). Segregation-safe upsert:
-- on a name conflict with a non-off row we DO NOTHING (never mutate USDA/curated data),
-- and OFF servings attach only to OFF rows. Reversible:
--   delete from public.foods where 'off' = any(sources);
-- Attribution required in-app: "Includes data from Open Food Facts, ODbL."
`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const foodValues = batch.map((r) =>
      `('${esc(r.name)}','${r.food_category}','${r.base_unit}',${r.kcal},${r.protein_g},${r.carb_g},${r.fat_g},${num(r.fiber_g)},${num(r.sugar_g)},${num(r.sat_fat_g)},${num(r.sodium_mg)},${sqlStr(r.brand)},${sqlStr(r.barcode)},'off',array['off'],${sqlStr(r.region)})`,
    ).join(',\n');
    sql += `\ninsert into public.foods
  (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, brand, barcode, source, sources, region)
values
${foodValues}
on conflict (lower(name)) where created_by is null do nothing;
`;
    // servings attach ONLY to off rows (guard preserves ODbL segregation: never add
    // an off-sourced serving to a USDA/curated row that shares a name).
    const servValues = batch.flatMap((r) =>
      r.servings.map((s) => `('${esc(r.name)}','${esc(s.label)}',${s.grams},${s.seq})`),
    ).join(',\n');
    const batchNames = batch.map((r) => `'${esc(r.name.toLowerCase())}'`).join(', ');
    const defaultPairs = batch.map((r) => {
      const def = r.servings.find((s) => s.is_default) ?? r.servings[0];
      return `('${esc(r.name)}','${esc(def.label)}')`;
    }).join(',\n');
    sql += `\ninsert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, v.label, v.grams, false, 'off', v.seq
from (values
${servValues}
) as v(food_name, label, grams, seq)
join public.foods f on lower(f.name) = lower(v.food_name) and f.created_by is null and 'off' = any(f.sources)
on conflict (food_id, lower(label)) do update set grams = excluded.grams, seq = excluded.seq;
`;
    // exactly one default serving per food (uq_food_servings_default): clear then set,
    // scoped to off rows only.
    sql += `\nupdate public.food_servings s set is_default = false
from public.foods f
where s.food_id = f.id and f.created_by is null and 'off' = any(f.sources) and s.is_default
  and lower(f.name) in (${batchNames});

update public.food_servings s set is_default = true
from (values
${defaultPairs}
) as d(food_name, label)
join public.foods f on lower(f.name) = lower(d.food_name) and f.created_by is null and 'off' = any(f.sources)
where s.food_id = f.id and lower(s.label) = lower(d.label);
`;
  }
  const destDir = path.join(REPO_ROOT, 'supabase/seed');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  fs.writeFileSync(dest, sql);
  console.log(`\n[off] -> ${path.relative(REPO_ROOT, dest)} (${(sql.length / 1e6).toFixed(2)} MB, ${Math.ceil(rows.length / CHUNK)} batches)`);
}

async function main() {
  // OFF brand tags lowercase and replace spaces AND apostrophes with '-'
  // (e.g. "McDonald's" -> "mcdonald-s", "Kwality Wall's" -> "kwality-wall-s").
  const toTag = (b: string) => b.toLowerCase().replace(/[\s']+/g, '-');
  const gym = OFF_FILTER.gymBrands.map(toTag);
  const fmcg = OFF_FILTER.fmcgBrands.map(toTag);
  const restaurant = OFF_FILTER.restaurantBrands.map(toTag);
  const rows: Row[] = [];
  const seenName = new Set<string>();
  const seenCode = new Set<string>();

  console.log(`[off] gym brands (global): ${gym.join(', ')}`);
  for (const tag of gym) await collectBrand(tag, 'gym', seenName, seenCode, rows);
  console.log(`[off] FMCG brands (india-scoped): ${fmcg.join(', ')}`);
  for (const tag of fmcg) await collectBrand(tag, 'fmcg', seenName, seenCode, rows);
  console.log(`[off] restaurant chains (global): ${restaurant.join(', ')}`);
  for (const tag of restaurant) await collectBrand(tag, 'restaurant', seenName, seenCode, rows);

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const withServing = rows.filter((r) => r.servings.some((s) => s.seq === 0)).length;
  const withExt = rows.filter((r) => r.fiber_g != null || r.sugar_g != null || r.sat_fat_g != null || r.sodium_mg != null).length;
  console.log(`\n[off] ${rows.length} unique foods (${withServing} with a real serving, ${withExt} with extended nutrients)`);
  emitSeed(rows);
  console.log('[done] OFF ingest complete.');
}

// Only crawl when run directly (`npx tsx ingest-off.ts`), not when another script
// (ingest-off-popular.ts) imports the exported helpers above.
if (process.argv[1]?.endsWith('ingest-off.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
