/**
 * OFF barcode-keyed ENRICHMENT pass (ODbL, source stays 'off').
 *
 * ingest-off.ts loads branded rows from search-a-licious, which does NOT expose
 * serving sizes or micronutrients — so those rows ship with a canonical "100 g"
 * serving and no micros. This pass revisits each row by BARCODE against OFF's
 * per-product API (https://world.openfoodfacts.org/api/v2/product/{code}), which
 * DOES carry serving_size / serving_quantity + micros, and back-fills them.
 *
 * RATE-LIMITED + RESUMABLE. OFF's product API caps at ~100 req/min and returns 429
 * past that; we pace at BASE_DELAY_MS and, on a 429, honor Retry-After and wait out
 * the window (without consuming a retry). Every result is cached to a gitignored
 * JSON so a killed/torn-down run resumes exactly where it stopped — rerun until the
 * "to fetch" count hits 0. Definitive results (data / no-data / 404) are cached;
 * transient failures are left uncached for the next run.
 *
 * Self-healing + idempotent on the DB side: the emitted SQL only UPDATEs existing
 * OFF rows (never inserts, never touches USDA/curated rows). OFF *_100g nutriments
 * are normalized to GRAMS, so mg = *1000 and µg = *1e6 uniformly (verified live).
 *
 * Run:    npx tsx scripts/diet-catalog/enrich-off.ts   (rerun to resume)
 * Output: supabase/seed/off_enrich.generated.sql   (regenerated from cache each run)
 * Apply:  bash scripts/load-usda-seed.sh supabase/seed/off_enrich.generated.sql
 * Cache:  scripts/diet-catalog/data/off_enrich_cache.json  (gitignored; delete to refetch)
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'off_enrich_cache.json');
// Enrich barcodes from every OFF seed (brand pull + popularity pull).
const SEED_FILES = ['off_foods.generated.sql', 'off_popular.generated.sql', 'off_countries.generated.sql'].map((f) => path.join(REPO_ROOT, 'supabase/seed', f));
const PRODUCT = 'https://world.openfoodfacts.org/api/v2/product';
const UA = 'OverloadDietCatalog/1.0 (sarthakkumar131@gmail.com; https://tryoverload.app)';
const FIELDS = 'code,product_name,serving_size,serving_quantity,nutriments';
const BASE_DELAY_MS = 700;   // ~85/min, under OFF's ~100/min product-API cap
const MAX_RATE_WAITS = 6;    // give up a barcode after this many 429 windows
const FLUSH_EVERY = 15;
const CHUNK = 200;

const round = (n: number, d: number) => { const f = 10 ** d; return Math.round(n * f) / f; };
const fmtAmount = (n: number) => (Number.isInteger(n) ? String(n) : String(round(n, 1)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// OFF nutriment key -> [our micros jsonb key, factor from grams, decimals].
// 1000 -> mg, 1e6 -> µg. Keys mirror ingest-usda.ts MICRO_MAP (consistent jsonb schema).
const MICRO_MAP: Record<string, [string, number, number]> = {
  calcium: ['calcium_mg', 1000, 1],
  iron: ['iron_mg', 1000, 2],
  magnesium: ['magnesium_mg', 1000, 1],
  potassium: ['potassium_mg', 1000, 1],
  zinc: ['zinc_mg', 1000, 2],
  'vitamin-c': ['vit_c_mg', 1000, 1],
  'vitamin-a': ['vit_a_ug', 1e6, 0],
  'vitamin-d': ['vit_d_ug', 1e6, 1],
  'vitamin-b12': ['vit_b12_ug', 1e6, 2],
  'vitamin-b9': ['folate_ug', 1e6, 0],
  cholesterol: ['cholesterol_mg', 1000, 0],
};

interface Rec {
  servingLabel: string | null;
  servingGrams: number | null;
  micros: Record<string, number> | null;
  miss?: boolean;
}
type Cache = Record<string, Rec>;

function loadCache(): Cache {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Cache; } catch { return {}; }
}
function saveCache(c: Cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
}

/** Barcodes we loaded, read from the OFF seeds (fixed tail: ...,'<bc>','off',array['off'])). */
function barcodesFromSeed(): string[] {
  const set = new Set<string>();
  for (const file of SEED_FILES) {
    let sql: string;
    try { sql = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const re = /'(\d{6,14})','off',array\['off'\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) set.add(m[1]);
  }
  return [...set];
}

/** Definitive Rec (data or miss) -> cache it. null -> transient, leave for next run. */
async function fetchProduct(code: string): Promise<Rec | null> {
  const url = `${PRODUCT}/${code}?fields=${encodeURIComponent(FIELDS)}`;
  let attempt = 0;
  let rateWaits = 0;
  while (attempt < 3) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429) {
        if (++rateWaits > MAX_RATE_WAITS) { console.warn(`  [429] ${code}: window won't clear — leaving uncached`); return null; }
        const ra = Number(res.headers.get('retry-after')) || 45;
        console.warn(`  [429] rate limited — waiting ${ra}s (${rateWaits}/${MAX_RATE_WAITS})`);
        await sleep(ra * 1000);
        continue; // retry same barcode, no attempt consumed
      }
      if (res.status === 404) return { servingLabel: null, servingGrams: null, micros: null, miss: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { status?: number; product?: Record<string, unknown> };
      if (d.status === 0 || !d.product) return { servingLabel: null, servingGrams: null, micros: null, miss: true };
      const p = d.product;
      const n = (p.nutriments ?? {}) as Record<string, number>;

      const sqRaw = p.serving_quantity;
      const sq = typeof sqRaw === 'string' ? Number(sqRaw) : (sqRaw as number | undefined);
      let servingLabel: string | null = null;
      let servingGrams: number | null = null;
      if (sq != null && !Number.isNaN(sq) && sq > 0 && sq < 2000) {
        servingGrams = round(sq, 1);
        // unit from the product's own serving_size string ("250 ml" -> ml, else g) so
        // liquids read as ml, matching the food's base_unit.
        const ss = String(p.serving_size ?? '');
        const unit = /\d\s*(ml|cl|l|millilit|centilit)\b/i.test(ss) ? 'ml' : 'g';
        servingLabel = `1 serving (${fmtAmount(servingGrams)} ${unit})`;
      }

      const micros: Record<string, number> = {};
      for (const [offKey, [ourKey, factor, dec]] of Object.entries(MICRO_MAP)) {
        const v = n[`${offKey}_100g`];
        if (v == null || Number.isNaN(v) || v <= 0) continue;
        const conv = round(v * factor, dec);
        if (conv > 0) micros[ourKey] = conv;
      }

      const hasMicros = Object.keys(micros).length > 0;
      return {
        servingLabel,
        servingGrams,
        micros: hasMicros ? micros : null,
        miss: servingGrams == null && !hasMicros ? true : undefined,
      };
    } catch (e) {
      attempt++;
      if (attempt >= 3) { console.warn(`  [warn] ${code}: ${String(e)} — leaving uncached`); return null; }
      await sleep(1200 * attempt);
    }
  }
  return null;
}

function esc(s: string) { return s.replace(/'/g, "''"); }

function emit(cache: Cache, barcodes: string[]) {
  const rows = barcodes
    .filter((bc) => cache[bc] && !cache[bc].miss && (cache[bc].servingGrams != null || cache[bc].micros != null))
    .map((bc) => ({ barcode: bc, ...cache[bc] }));

  const withServing = rows.filter((r) => r.servingGrams != null);
  const withMicros = rows.filter((r) => r.micros);
  let sql = `-- GENERATED by scripts/diet-catalog/enrich-off.ts — do not edit by hand.
-- OFF barcode enrichment: real serving sizes + micros back-filled onto existing OFF
-- rows (source stays 'off'). ${withServing.length} servings, ${withMicros.length} micro sets over ${rows.length} products.
-- Apply: bash scripts/load-usda-seed.sh supabase/seed/off_enrich.generated.sql
-- Idempotent: updates only rows where 'off' = any(sources); never touches USDA/curated.
`;
  let batchNo = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const sv = batch.filter((r) => r.servingGrams != null && r.servingLabel);
    const mi = batch.filter((r) => r.micros);
    if (!sv.length && !mi.length) continue;
    batchNo++;
    sql += `\n-- BATCH ${batchNo}\n`;

    if (sv.length) {
      const svValues = sv.map((r) => `('${r.barcode}','${esc(r.servingLabel!)}',${r.servingGrams})`).join(',\n');
      const barcodeList = sv.map((r) => `'${r.barcode}'`).join(', ');
      const defaultPairs = sv.map((r) => `('${r.barcode}','${esc(r.servingLabel!)}')`).join(',\n');
      sql += `insert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, v.label, v.grams, false, 'off', 0
from (values
${svValues}
) as v(barcode, label, grams)
join public.foods f on f.barcode = v.barcode and f.created_by is null and 'off' = any(f.sources)
on conflict (food_id, lower(label)) do update set grams = excluded.grams, seq = 0;
`;
      sql += `\nupdate public.food_servings s set is_default = false
from public.foods f
where s.food_id = f.id and f.created_by is null and 'off' = any(f.sources)
  and s.is_default and f.barcode in (${barcodeList});

update public.food_servings s set is_default = true
from (values
${defaultPairs}
) as d(barcode, label)
join public.foods f on f.barcode = d.barcode and f.created_by is null and 'off' = any(f.sources)
where s.food_id = f.id and lower(s.label) = lower(d.label);
`;
    }

    if (mi.length) {
      const miValues = mi.map((r) => `('${r.barcode}','${esc(JSON.stringify(r.micros))}'::jsonb)`).join(',\n');
      sql += `\nupdate public.foods f set micros = coalesce(f.micros, '{}'::jsonb) || v.micros
from (values
${miValues}
) as v(barcode, micros)
where f.barcode = v.barcode and f.created_by is null and 'off' = any(f.sources);
`;
    }
  }
  const dest = path.join(REPO_ROOT, 'supabase/seed/off_enrich.generated.sql');
  fs.writeFileSync(dest, sql);
  console.log(`[enrich] -> ${path.relative(REPO_ROOT, dest)} (${(sql.length / 1e6).toFixed(2)} MB, ${batchNo} batches; ${withServing.length} servings, ${withMicros.length} micro sets)`);
}

async function main() {
  const barcodes = barcodesFromSeed();
  const cache = loadCache();
  const todo = barcodes.filter((bc) => !(bc in cache));
  console.log(`[enrich] ${barcodes.length} OFF barcodes — ${barcodes.length - todo.length} cached, ${todo.length} to fetch (pace ${BASE_DELAY_MS}ms)`);

  let done = 0;
  for (const bc of todo) {
    const rec = await fetchProduct(bc);
    if (rec) cache[bc] = rec; // only cache definitive results; transient stay for next run
    done++;
    if (done % FLUSH_EVERY === 0) {
      saveCache(cache);
      const got = Object.values(cache).filter((r) => !r.miss).length;
      console.log(`  ${done}/${todo.length} fetched (usable so far: ${got})`);
    }
    await sleep(BASE_DELAY_MS);
  }
  saveCache(cache);

  const cached = barcodes.filter((bc) => bc in cache).length;
  const usable = barcodes.filter((bc) => cache[bc] && !cache[bc].miss).length;
  console.log(`\n[enrich] cache: ${cached}/${barcodes.length} resolved, ${usable} with serving/micros${cached < barcodes.length ? ` — rerun to fetch the remaining ${barcodes.length - cached}` : ' — COMPLETE'}`);
  emit(cache, barcodes);
  console.log('[done] OFF enrichment build complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
