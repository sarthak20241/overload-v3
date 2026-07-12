/**
 * UK CoFID ingest -> the SERVER catalog seed. Source: McCance & Widdowson's
 * "Composition of Foods Integrated Dataset" 2021 (Public Health England / gov.uk).
 * Licence: Open Government Licence v3.0, Crown copyright — reuse allowed WITH
 * attribution (shipped in-app, see profile.tsx). English-named authoritative EU/UK
 * generic composition (~2.9k foods), per 100 g.
 *
 * Reads the .xlsx (data/eu/cofid2021.xlsx) via SheetJS, joining three sheets by
 * Food Code: 1.3 Proximates (macros), 1.4 Inorganics (sodium + minerals), 1.5
 * Vitamins. Values: "Tr" (trace)->0, "N"/blank (not measured)->null.
 *
 * Run:    npx tsx scripts/diet-catalog/ingest-cofid.ts
 * Output: supabase/seed/cofid_foods.generated.sql
 * Apply:  bash scripts/load-usda-seed.sh supabase/seed/cofid_foods.generated.sql
 * Reversible: delete from public.foods where 'cofid' = any(sources);
 */

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(__dirname, 'data', 'eu', 'cofid2021.xlsx');
const CHUNK = 400;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** CoFID cell -> number | null. "Tr" = trace (0); "N"/blank = not measured (null). */
function val(cell: unknown): number | null {
  if (cell == null) return null;
  const s = String(cell).trim();
  if (s === '' || /^n$/i.test(s) || s === 'N/A') return null;
  if (/^tr/i.test(s)) return 0;
  const m = s.replace(/[^0-9.\-]/g, '');
  if (m === '' || m === '-') return null;
  const n = Number(m);
  return Number.isNaN(n) ? null : n;
}

const LIQUID_RE = /\b(milk|juice|drink|beverage|water|squash|cordial|smoothie|lassi|shake|coffee|tea|beer|wine|cider|lemonade|cola|soda|nectar|liqueur|spirit)\b/i;
function baseUnitFor(name: string): 'g' | 'ml' {
  return LIQUID_RE.test(name) ? 'ml' : 'g';
}

function categoryFor(name: string): string {
  const s = name.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => s.includes(w));
  if (has('milk', 'cheese', 'yogurt', 'yoghurt', 'cream', 'butter', 'dairy')) return 'dairy';
  if (has('chocolate', 'sweets', 'confection', 'ice cream', 'cake', 'biscuit', 'dessert', 'sugar', 'honey', 'jam')) return 'sweet';
  if (has('crisps', 'snack', 'crackers')) return 'snack';
  if (has('juice', 'drink', 'squash', 'cola', 'lemonade', 'coffee', 'tea', 'water', 'beer', 'wine', 'cider')) return 'beverage';
  if (has('bread', 'rice', 'pasta', 'cereal', 'oat', 'flour', 'noodle', 'crackers')) return 'grain';
  if (has('oil', 'lard', 'ghee', 'margarine', 'suet')) return 'fat_oil';
  if (has('chicken', 'beef', 'pork', 'lamb', 'fish', 'egg', 'bacon', 'sausage', 'turkey', 'ham', 'prawn', 'salmon', 'tuna', 'meat')) return 'protein';
  if (has('beans', 'lentil', 'chickpea', 'dahl', 'dhal', 'peas', 'tofu')) return 'legume';
  if (has('nuts', 'almond', 'peanut', 'cashew', 'seeds', 'walnut')) return 'nuts_seeds';
  if (has('apple', 'banana', 'orange', 'berry', 'fruit', 'mango', 'grape', 'melon')) return 'fruit';
  if (has('vegetable', 'potato', 'carrot', 'onion', 'tomato', 'spinach', 'cabbage', 'broccoli', 'salad', 'pepper')) return 'vegetable';
  if (has('sauce', 'pickle', 'chutney', 'ketchup', 'dressing', 'gravy', 'spice', 'stock')) return 'condiment';
  return 'other';
}

interface Row {
  name: string; food_category: string; base_unit: 'g' | 'ml';
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null; sugar_g: number | null; sat_fat_g: number | null; sodium_mg: number | null;
  micros: Record<string, number> | null;
}

/** rows -> map keyed by Food Code (col 0), values = the raw cell array. */
function sheetByCode(wb: XLSX.WorkBook, sheet: string): Map<string, unknown[]> {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: false });
  const map = new Map<string, unknown[]>();
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i];
    const code = r && r[0] != null ? String(r[0]).trim() : '';
    if (code) map.set(code, r);
  }
  return map;
}

function build(): Row[] {
  const wb = XLSX.readFile(SRC);
  const prox = sheetByCode(wb, '1.3 Proximates');
  const inorg = sheetByCode(wb, '1.4 Inorganics');
  const vit = sheetByCode(wb, '1.5 Vitamins');

  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const [code, p] of prox) {
    const name = p[1] != null ? String(p[1]).trim() : '';
    if (name.length < 2) continue;
    const kcal = val(p[12]);
    if (kcal == null || !(kcal > 0)) continue; // need energy
    const nameKey = name.toLowerCase();
    if (seen.has(nameKey)) continue;
    seen.add(nameKey);

    const io = inorg.get(code) ?? [];
    const vi = vit.get(code) ?? [];
    // micros jsonb (keys mirror ingest-usda MICRO_MAP)
    const micros: Record<string, number> = {};
    const put = (k: string, v: number | null, d = 2) => { if (v != null && v > 0) micros[k] = Math.round(v * 10 ** d) / 10 ** d; };
    put('potassium_mg', val(io[8]), 1);
    put('calcium_mg', val(io[9]), 1);
    put('magnesium_mg', val(io[10]), 1);
    put('iron_mg', val(io[12]), 2);
    put('zinc_mg', val(io[14]), 2);
    put('vit_a_ug', val(vi[9]), 0);   // Retinol Equivalent
    put('vit_d_ug', val(vi[10]), 1);
    put('vit_b12_ug', val(vi[19]), 2);
    put('folate_ug', val(vi[20]), 0);
    put('vit_c_mg', val(vi[24]), 1);
    put('cholesterol_mg', val(p[47]), 0);

    const fiber = val(p[25]) ?? val(p[24]); // AOAC fibre, else NSP
    rows.push({
      name, food_category: categoryFor(name), base_unit: baseUnitFor(name),
      kcal: Math.round(kcal),
      protein_g: round1(val(p[9]) ?? 0), carb_g: round1(val(p[11]) ?? 0), fat_g: round1(val(p[10]) ?? 0),
      fiber_g: fiber != null ? round1(fiber) : null,
      sugar_g: val(p[16]) != null ? round1(val(p[16])!) : null,
      sat_fat_g: val(p[27]) != null ? round1(val(p[27])!) : null,
      sodium_mg: val(io[7]) != null ? Math.round(val(io[7])!) : null,
      micros: Object.keys(micros).length ? micros : null,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function esc(s: string) { return s.replace(/'/g, "''"); }
const num = (n: number | null) => (n == null ? 'null' : String(n));

function emit(rows: Row[]) {
  const microsSql = (m: Record<string, number> | null) => (m ? `'${esc(JSON.stringify(m))}'::jsonb` : 'null');
  let sql = `-- GENERATED by scripts/diet-catalog/ingest-cofid.ts — do not edit by hand.
-- UK CoFID (McCance & Widdowson 2021): ${rows.length} foods, source='cofid'.
-- Open Government Licence v3.0, Crown copyright. Apply as SERVICE ROLE. DO NOTHING on
-- name conflict (segregation-safe). Reversible: delete from public.foods where 'cofid'=any(sources);
`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const foodValues = batch.map((r) =>
      `('${esc(r.name)}','${r.food_category}','${r.base_unit}',${r.kcal},${r.protein_g},${r.carb_g},${r.fat_g},${num(r.fiber_g)},${num(r.sugar_g)},${num(r.sat_fat_g)},${num(r.sodium_mg)},${microsSql(r.micros)},'cofid',array['cofid'],'uk')`,
    ).join(',\n');
    sql += `\ninsert into public.foods
  (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, micros, source, sources, region)
values
${foodValues}
on conflict (lower(name)) where created_by is null do nothing;
`;
    // canonical serving per base_unit; attach only to cofid rows.
    const servValues = batch.map((r) => `('${esc(r.name)}','100 ${r.base_unit}')`).join(',\n');
    sql += `\ninsert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, v.label, 100, true, 'cofid', 0
from (values
${servValues}
) as v(food_name, label)
join public.foods f on lower(f.name) = lower(v.food_name) and f.created_by is null and 'cofid' = any(f.sources)
on conflict (food_id, lower(label)) do nothing;
`;
  }
  const dest = path.join(REPO_ROOT, 'supabase/seed/cofid_foods.generated.sql');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, sql);
  console.log(`[cofid] -> ${path.relative(REPO_ROOT, dest)} (${(sql.length / 1e6).toFixed(2)} MB, ${Math.ceil(rows.length / CHUNK)} batches)`);
}

function main() {
  if (!fs.existsSync(SRC)) { console.error(`[cofid] missing ${SRC} — download CoFID 2021 xlsx first.`); process.exit(1); }
  const rows = build();
  const withMicros = rows.filter((r) => r.micros).length;
  const ml = rows.filter((r) => r.base_unit === 'ml').length;
  console.log(`[cofid] ${rows.length} foods (${withMicros} with micros, ${ml} liquid/ml)`);
  emit(rows);
  console.log('[done] CoFID ingest complete.');
}

main();
