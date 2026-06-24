/**
 * diet-catalog build orchestrator.
 *
 *   compute Indian dishes  ─┐
 *   ingest USDA (CC0)      ─┼─► merge + dedupe (by lower(name)) ─► emit:
 *   ingest OFF (ODbL, off) ─┘        lib/foods.generated.ts
 *                                    supabase/seed/foods_seed.generated.sql
 *
 * Run:  npx tsx scripts/diet-catalog/build.ts
 *
 * Today it runs the compute-dishes slice with no downloads. USDA/OFF ingest are
 * stubbed with the parse structure; wire them once data/ inputs are in place.
 * See README.md for the inputs + the (load-bearing) license guardrails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DISHES, computeDish } from './indian-dishes';
import { USDA_ALLOWLIST, OFF_FILTER, type UsdaPick } from './allowlist';

// ── Shared types (mirror lib/foods.ts — kept local so the build is decoupled) ─
export type FoodCategory =
  | 'protein' | 'legume' | 'dairy' | 'grain' | 'vegetable' | 'fruit' | 'fat_oil'
  | 'nuts_seeds' | 'prepared_dish' | 'snack' | 'beverage' | 'sweet' | 'supplement'
  | 'condiment' | 'other';
export type ServingUnit =
  | 'g' | 'ml' | 'piece' | 'slice' | 'bowl' | 'cup' | 'glass' | 'tbsp' | 'tsp' | 'scoop';
export type FoodSource = 'usda' | 'off' | 'curated' | 'user';
export interface Macros { kcal: number; protein_g: number; carb_g: number; fat_g: number }

export interface FoodRow {
  name: string;
  food_category: FoodCategory;
  serving_unit: ServingUnit;
  serving_size: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  brand?: string;
  barcode?: string;
  source: FoodSource;
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(__dirname, 'data');
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Quote-aware CSV line parser (USDA fields are all double-quoted; "" escapes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Find a file by name anywhere under `dir` (the USDA zip nests one level). */
function findFirst(dir: string, filename: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFirst(full, filename);
      if (hit) return hit;
    } else if (entry.name === filename) return full;
  }
  return null;
}

// ── 1. Computed Indian dishes (runnable now, no download) ────────────────────
function buildDishes(): FoodRow[] {
  return DISHES.map((d) => {
    const m = computeDish(d);
    return {
      name: d.name,
      food_category: d.food_category,
      serving_unit: d.serving_unit,
      serving_size: d.serving_size,
      kcal: Math.round(m.kcal),
      protein_g: round1(m.protein_g),
      carb_g: round1(m.carb_g),
      fat_g: round1(m.fat_g),
      source: 'curated',
    };
  });
}

// ── 2. USDA ingest (CC0) — bundle freely ─────────────────────────────────────
// food.csv (fdc_id -> description) + food_nutrient.csv (fdc_id, nutrient_id,
// amount per 100 g). Nutrient ids: 1008 kcal, 1003 protein, 1005 carb, 1004 fat.
const USDA_NUTRIENT: Record<string, keyof Macros> = {
  '1008': 'kcal', '1003': 'protein_g', '1005': 'carb_g', '1004': 'fat_g',
};

function buildUsda(): FoodRow[] {
  const dir = path.join(DATA_DIR, 'usda');
  const foodCsv = findFirst(dir, 'food.csv');
  const nutrientCsv = findFirst(dir, 'food_nutrient.csv');
  if (!foodCsv || !nutrientCsv) {
    console.warn('[usda] data/usda CSVs not found — skipping (download SR Legacy, see README).');
    return [];
  }

  // 1. food.csv -> [{ id, desc }]
  const foodLines = fs.readFileSync(foodCsv, 'utf8').split('\n');
  const fHead = parseCsvLine(foodLines[0]);
  const iId = fHead.indexOf('fdc_id');
  const iDesc = fHead.indexOf('description');
  const foods: { id: string; desc: string }[] = [];
  for (let i = 1; i < foodLines.length; i++) {
    if (!foodLines[i]) continue;
    const f = parseCsvLine(foodLines[i]);
    if (f.length <= iDesc) continue;
    foods.push({ id: f[iId], desc: f[iDesc] });
  }

  // 2. one fdc_id per allowlist pick (shortest matching description wins)
  const chosen = new Map<string, UsdaPick>();
  const chosenDesc = new Map<string, string>();
  const missed: string[] = [];
  for (const pick of USDA_ALLOWLIST) {
    const m = pick.match.toLowerCase();
    let best: { id: string; desc: string } | null = null;
    for (const fd of foods) {
      if (fd.desc.toLowerCase().includes(m) && (!best || fd.desc.length < best.desc.length)) best = fd;
    }
    if (best) { chosen.set(best.id, pick); chosenDesc.set(best.id, best.desc); }
    else missed.push(pick.name);
  }

  // 3. food_nutrient.csv -> macros for the chosen fdc_ids
  const macros = new Map<string, Partial<Macros>>();
  const nLines = fs.readFileSync(nutrientCsv, 'utf8').split('\n');
  const nHead = parseCsvLine(nLines[0]);
  const nFdc = nHead.indexOf('fdc_id');
  const nNut = nHead.indexOf('nutrient_id');
  const nAmt = nHead.indexOf('amount');
  for (let i = 1; i < nLines.length; i++) {
    if (!nLines[i]) continue;
    const r = parseCsvLine(nLines[i]);
    const fdc = r[nFdc];
    if (!chosen.has(fdc)) continue;
    const field = USDA_NUTRIENT[r[nNut]];
    if (!field) continue;
    const cur = macros.get(fdc) ?? {};
    cur[field] = Number(r[nAmt]);
    macros.set(fdc, cur);
  }

  // 4. emit (skip foods with no energy value)
  const rows: FoodRow[] = [];
  for (const [fdc, pick] of chosen) {
    const m = macros.get(fdc);
    if (!m || m.kcal == null) continue;
    rows.push({
      name: pick.name,
      food_category: pick.food_category,
      serving_unit: pick.serving_unit,
      serving_size: pick.serving_size,
      kcal: Math.round(m.kcal),
      protein_g: round1(m.protein_g ?? 0),
      carb_g: round1(m.carb_g ?? 0),
      fat_g: round1(m.fat_g ?? 0),
      source: 'usda',
    });
    if (process.env.VERBOSE) console.log(`  [usda] ${pick.name} <- "${chosenDesc.get(fdc)}"`);
  }
  if (missed.length) console.warn(`[usda] no description match for: ${missed.join(', ')}`);
  console.log(`[usda] ${rows.length} foods from ${USDA_ALLOWLIST.length} picks`);
  return rows;
}

// ── 3. Open Food Facts ingest (ODbL) — SEGREGATED, source:'off' ──────────────
function buildOff(): FoodRow[] {
  const dir = path.join(DATA_DIR, 'off');
  if (!fs.existsSync(dir)) {
    console.warn('[off] data/off not found — skipping (download the India subset).');
    return [];
  }
  // TODO: stream the OFF JSONL/Parquet dump. Keep a product iff:
  //   - countries_tags ∩ OFF_FILTER.countries, OR brand ∈ gymBrands/fmcgBrands, AND
  //   - all OFF_FILTER.requireNutriments present.
  // Map energy-kcal_100g/proteins_100g/... to a FoodRow{ serving_size:100, source:'off',
  // brand, barcode: product.code }. NEVER merge OFF values into a non-off row.
  console.warn('[off] parser TODO — see allowlist.ts OFF_FILTER and README (ODbL rules).');
  void OFF_FILTER;
  return [];
}

// ── 4. Merge + dedupe (by lower(name); priority curated > usda > off) ─────────
function mergeRows(...groups: FoodRow[][]): FoodRow[] {
  const priority: Record<FoodSource, number> = { curated: 3, usda: 2, off: 1, user: 0 };
  const byName = new Map<string, FoodRow>();
  for (const row of groups.flat()) {
    const key = row.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing || priority[row.source] > priority[existing.source]) byName.set(key, row);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── 5. Emit ──────────────────────────────────────────────────────────────────
function emitFoodLibraryTs(rows: FoodRow[]) {
  const body = rows
    .map((r) => `  ${JSON.stringify(r)},`)
    .join('\n');
  const out = `// GENERATED by scripts/diet-catalog/build.ts — do not edit by hand.
// Sourcing + license: see scripts/diet-catalog/README.md.
import type { FoodDef } from './foods';

export const FOOD_LIBRARY_GENERATED: FoodDef[] = [
${body}
];
`;
  const dest = path.join(REPO_ROOT, 'lib/foods.generated.ts');
  fs.writeFileSync(dest, out);
  console.log(`[emit] ${rows.length} foods -> ${path.relative(REPO_ROOT, dest)}`);
}

function emitSeedSql(rows: FoodRow[]) {
  const esc = (s: string) => s.replace(/'/g, "''");
  const values = rows
    .map((r) => {
      const brand = r.brand ? `'${esc(r.brand)}'` : 'null';
      const barcode = r.barcode ? `'${esc(r.barcode)}'` : 'null';
      return `  ('${esc(r.name)}','${r.food_category}','${r.serving_unit}',${r.serving_size},${r.kcal},${r.protein_g},${r.carb_g},${r.fat_g},${brand},${barcode},'${r.source}')`;
    })
    .join(',\n');
  const out = `-- GENERATED by scripts/diet-catalog/build.ts — do not edit by hand.
-- Apply as SERVICE ROLE so created_by stays null (global rows). Idempotent via
-- the uq_foods_name_global index. Sourcing/license: scripts/diet-catalog/README.md.
insert into public.foods
  (name, food_category, serving_unit, serving_size, kcal, protein_g, carb_g, fat_g, brand, barcode, source)
values
${values}
on conflict do nothing;
`;
  const destDir = path.join(REPO_ROOT, 'supabase/seed');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'foods_seed.generated.sql');
  fs.writeFileSync(dest, out);
  console.log(`[emit] ${rows.length} foods -> ${path.relative(REPO_ROOT, dest)}`);
}

function main() {
  const rows = mergeRows(buildDishes(), buildUsda(), buildOff());
  emitFoodLibraryTs(rows);
  emitSeedSql(rows);
  console.log('[done] diet-catalog build complete.');
}

main();
