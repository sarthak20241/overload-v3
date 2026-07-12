/**
 * diet-catalog build orchestrator.
 *
 *   compute Indian dishes  ─┐
 *   ingest USDA (CC0)      ─┼─► merge + dedupe (by lower(name)) ─► emit:
 *   ingest OFF (ODbL, off) ─┘        lib/foods.generated.ts (per-100 + servings)
 *                                    supabase/seed/foods_seed.generated.sql
 *
 * Run:  npx tsx scripts/diet-catalog/build.ts
 *
 * Model (migration 0065): nutrients are PER 100 base-units (g/ml); portions are a
 * `servings` list (label -> grams). USDA gives per-100 nutrients + household
 * portions (food_portion.csv); we also pull fiber/sugar/sat-fat/sodium. OFF ingest
 * is still stubbed. See README.md for the license guardrails.
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
export type BaseUnit = 'g' | 'ml';
export type FoodSource = 'usda' | 'off' | 'curated' | 'user';
export interface Macros { kcal: number; protein_g: number; carb_g: number; fat_g: number }

export interface Serving {
  label: string;
  grams: number;
  is_default: boolean;
  source: FoodSource;
  seq: number;
}

export interface FoodRow {
  name: string;
  food_category: FoodCategory;
  base_unit: BaseUnit;
  // nutrients per 100 base-units
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sat_fat_g: number;
  sodium_mg: number;
  servings: Serving[];
  brand?: string;
  barcode?: string;
  source: FoodSource;
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(__dirname, 'data');
const round1 = (n: number) => Math.round(n * 10) / 10;
const fmtAmount = (n: number) => (Number.isInteger(n) ? String(n) : String(round1(n)));

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

/** Always-present canonical "100 g"/"100 ml" serving. */
function canonicalServing(base: BaseUnit, seq: number, source: FoodSource): Serving {
  return { label: `100 ${base}`, grams: 100, is_default: false, source, seq };
}

// ── 1. Computed Indian dishes (per-100 from the ingredient breakdown) ─────────
function buildDishes(): FoodRow[] {
  return DISHES.map((d) => {
    const total = computeDish(d); // whole-dish macros
    const grams = d.ingredients.reduce((s, c) => s + c.grams, 0);
    const per100 = (v: number) => (grams > 0 ? (v / grams) * 100 : 0);
    return {
      name: d.name,
      food_category: d.food_category,
      base_unit: 'g',
      kcal: Math.round(per100(total.kcal)),
      protein_g: round1(per100(total.protein_g)),
      carb_g: round1(per100(total.carb_g)),
      fat_g: round1(per100(total.fat_g)),
      fiber_g: round1(per100(total.fiber_g)), sugar_g: 0, sat_fat_g: 0, sodium_mg: 0,
      servings: [
        { label: d.serving ?? '1 serving', grams: Math.round(grams), is_default: true, source: 'curated', seq: 0 },
        canonicalServing('g', 1, 'curated'),
      ],
      source: 'curated',
    };
  });
}

// ── 2. USDA ingest (CC0): per-100 nutrients + household portions ──────────────
// nutrient ids: 1008 kcal, 1003 protein, 1005 carb, 1004 fat, 1079 fiber,
// 2000 sugars, 1258 saturated fat, 1093 sodium (mg).
const USDA_NUTRIENT: Record<string, keyof FoodRow> = {
  '1008': 'kcal', '1003': 'protein_g', '1005': 'carb_g', '1004': 'fat_g',
  '1079': 'fiber_g', '2000': 'sugar_g', '1258': 'sat_fat_g', '1093': 'sodium_mg',
};

function buildUsda(): FoodRow[] {
  const dir = path.join(DATA_DIR, 'usda');
  const foodCsv = findFirst(dir, 'food.csv');
  const nutrientCsv = findFirst(dir, 'food_nutrient.csv');
  if (!foodCsv || !nutrientCsv) {
    console.warn('[usda] data/usda CSVs not found — skipping (download SR Legacy, see README).');
    return [];
  }
  const portionCsv = findFirst(dir, 'food_portion.csv');

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
  const missed: string[] = [];
  for (const pick of USDA_ALLOWLIST) {
    const m = pick.match.toLowerCase();
    let best: { id: string; desc: string } | null = null;
    for (const fd of foods) {
      if (fd.desc.toLowerCase().includes(m) && (!best || fd.desc.length < best.desc.length)) best = fd;
    }
    if (best) chosen.set(best.id, pick);
    else missed.push(pick.name);
  }

  // 3. food_nutrient.csv -> per-100 nutrients for the chosen fdc_ids
  const nut = new Map<string, Partial<Record<keyof FoodRow, number>>>();
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
    const cur = nut.get(fdc) ?? {};
    cur[field] = Number(r[nAmt]);
    nut.set(fdc, cur);
  }

  // 4. food_portion.csv -> household servings (label from amount + modifier)
  const portions = new Map<string, Serving[]>();
  if (portionCsv) {
    const pLines = fs.readFileSync(portionCsv, 'utf8').split('\n');
    const pHead = parseCsvLine(pLines[0]);
    const pFdc = pHead.indexOf('fdc_id');
    const pSeq = pHead.indexOf('seq_num');
    const pAmt = pHead.indexOf('amount');
    const pDesc = pHead.indexOf('portion_description');
    const pMod = pHead.indexOf('modifier');
    const pGram = pHead.indexOf('gram_weight');
    for (let i = 1; i < pLines.length; i++) {
      if (!pLines[i]) continue;
      const r = parseCsvLine(pLines[i]);
      const fdc = r[pFdc];
      if (!chosen.has(fdc)) continue;
      const grams = Number(r[pGram]);
      const amount = Number(r[pAmt]);
      const unit = (r[pMod] || r[pDesc] || '').trim();
      if (!(grams > 0) || !unit) continue;
      const label = `${fmtAmount(amount || 1)} ${unit}`.trim();
      const list = portions.get(fdc) ?? [];
      if (!list.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
        list.push({ label, grams, is_default: false, source: 'usda', seq: Number(r[pSeq]) || list.length });
      }
      portions.set(fdc, list);
    }
  }

  // 5. emit (skip foods with no energy value)
  const rows: FoodRow[] = [];
  for (const [fdc, pick] of chosen) {
    const m = nut.get(fdc);
    if (!m || m.kcal == null) continue;
    const base: BaseUnit = pick.base_unit ?? 'g';
    const servs = (portions.get(fdc) ?? []).slice().sort((a, b) => a.seq - b.seq);
    servs.push(canonicalServing(base, 999, 'usda'));
    // default = first real portion, else the canonical 100
    if (servs.length) servs[0].is_default = true;
    rows.push({
      name: pick.name,
      food_category: pick.food_category,
      base_unit: base,
      kcal: Math.round(m.kcal),
      protein_g: round1(m.protein_g ?? 0),
      carb_g: round1(m.carb_g ?? 0),
      fat_g: round1(m.fat_g ?? 0),
      fiber_g: round1(m.fiber_g ?? 0),
      sugar_g: round1(m.sugar_g ?? 0),
      sat_fat_g: round1(m.sat_fat_g ?? 0),
      sodium_mg: Math.round(m.sodium_mg ?? 0),
      servings: servs,
      source: 'usda',
    });
  }
  if (missed.length) console.warn(`[usda] no description match for: ${missed.join(', ')}`);
  console.log(`[usda] ${rows.length} foods (${portions.size} with household portions)`);
  return rows;
}

// ── 3. Open Food Facts ingest (ODbL) — SEGREGATED, source:'off' ──────────────
function buildOff(): FoodRow[] {
  const dir = path.join(DATA_DIR, 'off');
  if (!fs.existsSync(dir)) {
    console.warn('[off] data/off not found — skipping (download the India subset).');
    return [];
  }
  // TODO: stream the OFF dump; keep India + gym brands with complete _100g nutriments.
  // Emit per-100 nutrients + ONE serving from serving_quantity (grams, guard >0 <2000).
  // NEVER merge OFF values into a non-off row. See allowlist.ts OFF_FILTER + README (ODbL).
  console.warn('[off] parser TODO — see allowlist.ts OFF_FILTER and README.');
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
  const toDef = (r: FoodRow) => ({
    name: r.name,
    food_category: r.food_category,
    base_unit: r.base_unit,
    kcal: r.kcal, protein_g: r.protein_g, carb_g: r.carb_g, fat_g: r.fat_g,
    fiber_g: r.fiber_g, sugar_g: r.sugar_g, sat_fat_g: r.sat_fat_g, sodium_mg: r.sodium_mg,
    servings: r.servings.map((s) => ({ label: s.label, grams: s.grams, is_default: s.is_default, source: s.source })),
    source: r.source,
  });
  const body = rows.map((r) => `  ${JSON.stringify(toDef(r))},`).join('\n');
  const out = `// GENERATED by scripts/diet-catalog/build.ts — do not edit by hand.
// Per-100 nutrients + named servings (migration 0065). License: see README.md.
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
  const sqlStr = (s?: string) => (s ? `'${esc(s)}'` : 'null');
  const blocks = rows.map((r) => {
    const servingValues = r.servings
      .map((s) => `('${esc(s.label)}',${s.grams},${s.is_default},'${s.source}',${s.seq})`)
      .join(', ');
    // do update (not do nothing) so the CTE still returns the id for an
    // already-seeded food (otherwise the food_servings insert below is skipped on
    // every rerun) AND so regenerated data converges: core macros + descriptors
    // are overwritten (always present in the seed), while the nullable extended
    // nutrients use coalesce(existing, excluded) — fill a missing value without
    // clobbering enrichment a later source (e.g. ingest-usda) already applied.
    // Assumes a food's default serving label is stable across regenerations; a
    // same-label upsert can't trip uq_food_servings_default.
    return `with f as (
  insert into public.foods
    (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, brand, barcode, source)
  values ('${esc(r.name)}','${r.food_category}','${r.base_unit}',${r.kcal},${r.protein_g},${r.carb_g},${r.fat_g},${r.fiber_g},${r.sugar_g},${r.sat_fat_g},${r.sodium_mg},${sqlStr(r.brand)},${sqlStr(r.barcode)},'${r.source}')
  on conflict (lower(name)) where created_by is null do update set
    food_category = excluded.food_category,
    base_unit     = excluded.base_unit,
    kcal          = excluded.kcal,
    protein_g     = excluded.protein_g,
    carb_g        = excluded.carb_g,
    fat_g         = excluded.fat_g,
    fiber_g       = coalesce(public.foods.fiber_g,   excluded.fiber_g),
    sugar_g       = coalesce(public.foods.sugar_g,   excluded.sugar_g),
    sat_fat_g     = coalesce(public.foods.sat_fat_g, excluded.sat_fat_g),
    sodium_mg     = coalesce(public.foods.sodium_mg, excluded.sodium_mg),
    brand         = excluded.brand,
    barcode       = excluded.barcode,
    source        = excluded.source
  returning id
)
insert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, v.label, v.grams, v.is_default, v.source, v.seq
from f cross join (values ${servingValues}) as v(label, grams, is_default, source, seq)
on conflict (food_id, lower(label)) do update set
  grams = excluded.grams, is_default = excluded.is_default, source = excluded.source, seq = excluded.seq;`;
  }).join('\n\n');
  const out = `-- GENERATED by scripts/diet-catalog/build.ts — do not edit by hand.
-- Apply as SERVICE ROLE so created_by stays null (global rows). Idempotent via the
-- uq_foods_name_global index. Sourcing/license: scripts/diet-catalog/README.md.
${blocks}
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
