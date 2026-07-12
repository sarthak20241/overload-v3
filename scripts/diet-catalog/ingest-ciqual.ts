/**
 * ANSES-CIQUAL 2020 ingest -> the SERVER catalog seed. French national food
 * composition table (ANSES). Licence: Etalab Open Licence 2.0 — reuse allowed WITH
 * attribution (shipped in-app). ~3.2k foods, per 100 g. Names are FRENCH (that is
 * how CIQUAL ships); tagged region='france' so suggestions can bias by cuisine.
 *
 * Single sheet 'compo'; French decimals use a comma ("45,4"); "traces" -> 0,
 * "-"/blank -> null. Column indices verified against the 2020 XLS header.
 *
 * Run:    npx tsx scripts/diet-catalog/ingest-ciqual.ts
 * Output: supabase/seed/ciqual_foods.generated.sql
 * Apply:  bash scripts/load-usda-seed.sh supabase/seed/ciqual_foods.generated.sql
 * Reversible: delete from public.foods where 'ciqual' = any(sources);
 */

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(__dirname, 'data', 'eu', 'ciqual2020.xls');
const REGION = 'france';
const CHUNK = 400;
const round1 = (n: number) => Math.round(n * 10) / 10;

// column index -> meaning (0-based; verified against the CIQUAL 2020 'compo' header)
const C = {
  group: 3, name: 7, kcal: 10, protein: 14, carb: 16, fat: 17, sugar: 18, fiber: 26,
  sat_fat: 31, cholesterol: 48, sodium: 60, calcium: 50, iron: 53, magnesium: 55,
  potassium: 58, zinc: 61, vit_a: 62 /* rétinol */, vit_d: 64, vit_c: 68, folate: 74, vit_b12: 75,
};

/** CIQUAL cell -> number | null. French comma decimals; "traces" = trace (0). */
function val(cell: unknown): number | null {
  if (cell == null) return null;
  let s = String(cell).trim().toLowerCase();
  if (s === '' || s === '-') return null;
  if (s.startsWith('traces')) return 0;
  s = s.replace(',', '.').replace(/[^0-9.\-]/g, ''); // drop '<', nbsp, units
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function categoryFor(group: string, name: string): string {
  const s = (group + ' ' + name).toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => s.includes(w));
  if (has('lait', 'laitier', 'fromage', 'yaourt', 'crème', 'beurre')) return 'dairy';
  if (has('viande', 'volaille', 'poisson', 'œuf', 'oeuf', 'charcuterie', 'poulet', 'porc', 'boeuf', 'bœuf', 'jambon')) return 'protein';
  if (has('légumineuse', 'lentille', 'haricot', 'pois chiche', 'tofu')) return 'legume';
  if (has('céréal', 'pain', 'riz', 'pâtes', 'farine', 'biscotte')) return 'grain';
  if (has('légume')) return 'vegetable';
  if (has('fruit')) return 'fruit';
  if (has('matière grasse', 'huile', 'margarine')) return 'fat_oil';
  if (has('sucré', 'chocolat', 'confiserie', 'biscuit', 'gâteau', 'glace', 'sorbet', 'sucre', 'confiture', 'miel')) return 'sweet';
  if (has('boisson', 'jus', 'soda', 'eau', 'café', 'thé', 'bière', 'vin')) return 'beverage';
  if (has('oléagineux', 'noix', 'amande', 'graine')) return 'nuts_seeds';
  if (has('condiment', 'sauce', 'épice', 'aide culinaire')) return 'condiment';
  if (has('plat', 'entrée', 'sandwich', 'pizza', 'quiche', 'soupe')) return 'prepared_dish';
  if (has('snack', 'apéritif', 'chips')) return 'snack';
  return 'other';
}

const LIQUID_RE = /\b(lait|jus|boisson|eau|soda|cola|bière|biere|vin|cidre|sirop|nectar|café|cafe|thé|the|smoothie|limonade|milk-shake)\b/i;
function baseUnitFor(name: string): 'g' | 'ml' { return LIQUID_RE.test(name) ? 'ml' : 'g'; }

interface Row {
  name: string; food_category: string; base_unit: 'g' | 'ml';
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null; sugar_g: number | null; sat_fat_g: number | null; sodium_mg: number | null;
  micros: Record<string, number> | null;
}

function build(): Row[] {
  const wb = XLSX.readFile(SRC);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['compo'], { header: 1, raw: false });
  const out: Row[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const name = r[C.name] != null ? String(r[C.name]).trim() : '';
    if (name.length < 2) continue;
    const kcal = val(r[C.kcal]);
    if (kcal == null || !(kcal > 0)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const micros: Record<string, number> = {};
    const put = (k: string, v: number | null, d = 2) => { if (v != null && v > 0) micros[k] = Math.round(v * 10 ** d) / 10 ** d; };
    put('calcium_mg', val(r[C.calcium]), 1);
    put('iron_mg', val(r[C.iron]), 2);
    put('magnesium_mg', val(r[C.magnesium]), 1);
    put('potassium_mg', val(r[C.potassium]), 1);
    put('zinc_mg', val(r[C.zinc]), 2);
    put('vit_a_ug', val(r[C.vit_a]), 0);
    put('vit_d_ug', val(r[C.vit_d]), 1);
    put('vit_c_mg', val(r[C.vit_c]), 1);
    put('folate_ug', val(r[C.folate]), 0);
    put('vit_b12_ug', val(r[C.vit_b12]), 2);
    put('cholesterol_mg', val(r[C.cholesterol]), 0);

    out.push({
      name, food_category: categoryFor(String(r[C.group] ?? ''), name), base_unit: baseUnitFor(name),
      kcal: Math.round(kcal),
      protein_g: round1(val(r[C.protein]) ?? 0), carb_g: round1(val(r[C.carb]) ?? 0), fat_g: round1(val(r[C.fat]) ?? 0),
      fiber_g: val(r[C.fiber]) != null ? round1(val(r[C.fiber])!) : null,
      sugar_g: val(r[C.sugar]) != null ? round1(val(r[C.sugar])!) : null,
      sat_fat_g: val(r[C.sat_fat]) != null ? round1(val(r[C.sat_fat])!) : null,
      sodium_mg: val(r[C.sodium]) != null ? Math.round(val(r[C.sodium])!) : null,
      micros: Object.keys(micros).length ? micros : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function esc(s: string) { return s.replace(/'/g, "''"); }
const num = (n: number | null) => (n == null ? 'null' : String(n));

function emit(rows: Row[]) {
  const microsSql = (m: Record<string, number> | null) => (m ? `'${esc(JSON.stringify(m))}'::jsonb` : 'null');
  let sql = `-- GENERATED by scripts/diet-catalog/ingest-ciqual.ts — do not edit by hand.
-- ANSES-CIQUAL 2020 (France): ${rows.length} foods, source='ciqual', region='${REGION}'.
-- Etalab Open Licence 2.0. Apply as SERVICE ROLE. DO NOTHING on name conflict.
-- Reversible: delete from public.foods where 'ciqual' = any(sources);
`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const foodValues = batch.map((r) =>
      `('${esc(r.name)}','${r.food_category}','${r.base_unit}',${r.kcal},${r.protein_g},${r.carb_g},${r.fat_g},${num(r.fiber_g)},${num(r.sugar_g)},${num(r.sat_fat_g)},${num(r.sodium_mg)},${microsSql(r.micros)},'ciqual',array['ciqual'],'${REGION}')`,
    ).join(',\n');
    sql += `\ninsert into public.foods
  (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, micros, source, sources, region)
values
${foodValues}
on conflict (lower(name)) where created_by is null do nothing;
`;
    const servValues = batch.map((r) => `('${esc(r.name)}','100 ${r.base_unit}')`).join(',\n');
    sql += `\ninsert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, v.label, 100, true, 'ciqual', 0
from (values
${servValues}
) as v(food_name, label)
join public.foods f on lower(f.name) = lower(v.food_name) and f.created_by is null and 'ciqual' = any(f.sources)
on conflict (food_id, lower(label)) do nothing;
`;
  }
  const dest = path.join(REPO_ROOT, 'supabase/seed/ciqual_foods.generated.sql');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, sql);
  console.log(`[ciqual] -> ${path.relative(REPO_ROOT, dest)} (${(sql.length / 1e6).toFixed(2)} MB, ${Math.ceil(rows.length / CHUNK)} batches)`);
}

function main() {
  if (!fs.existsSync(SRC)) { console.error(`[ciqual] missing ${SRC} — download CIQUAL 2020 xls first.`); process.exit(1); }
  const rows = build();
  const withMicros = rows.filter((r) => r.micros).length;
  const ml = rows.filter((r) => r.base_unit === 'ml').length;
  console.log(`[ciqual] ${rows.length} foods (${withMicros} with micros, ${ml} liquid/ml)`);
  emit(rows);
  console.log('[done] CIQUAL ingest complete.');
}

main();
