/**
 * Full USDA SR Legacy ingest (CC0) -> the SERVER catalog seed.
 *
 * Unlike build.ts (which emits the SMALL bundled offline library), this ingests
 * the whole filtered SR Legacy generic catalog (~6.8k foods) into a seed SQL for
 * Supabase `foods` + `food_servings`. It writes ENRICHING UPSERTS: insert new
 * foods, and on a name conflict fill missing extended/micro fields, merge servings,
 * and append the source (see migration 0052). This same upsert shape is what every
 * later dataset (OFF, IFCT, INDB) reuses to enrich what USDA laid down.
 *
 * Run:   npx tsx scripts/diet-catalog/ingest-usda.ts
 * Output: supabase/seed/usda_foods.generated.sql  (apply via Supabase SQL editor /
 *         MCP; reversible with `delete from foods where 'usda' = any(sources)`).
 *
 * Fields kept: macros (1008/1003/1005/1004) + extended fiber/sugar/sat-fat/sodium
 * (1079/2000/1258/1093) as columns; ~11 micros into micros jsonb. Servings from
 * food_portion.csv (label = amount+modifier, grams = gram_weight) + canonical 100 g.
 * Names = USDA description as-is (verbose but accurate; the curated FOOD_LIBRARY in
 * lib/foods.ts carries clean names for the common offline subset).
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(__dirname, 'data', 'usda');
const REPO_ROOT = path.resolve(__dirname, '../..');
const CHUNK = 400; // foods per SQL batch (one upsert + one servings insert)
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtAmount = (n: number) => (Number.isInteger(n) ? String(n) : String(round1(n)));

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

function findFirst(dir: string, filename: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFirst(full, filename); if (hit) return hit; }
    else if (e.name === filename) return full;
  }
  return null;
}

// USDA food_category_id -> our FoodCategory (drop ids not listed = junk for us:
// 3 Baby, 21 Fast Food, 24 American Indian, 25 Restaurant, 26 Branded, 27 QC).
const CATEGORY_MAP: Record<string, string> = {
  '1': 'dairy', '2': 'condiment', '4': 'fat_oil', '5': 'protein', '6': 'prepared_dish',
  '7': 'protein', '8': 'grain', '9': 'fruit', '10': 'protein', '11': 'vegetable',
  '12': 'nuts_seeds', '13': 'protein', '14': 'beverage', '15': 'protein', '16': 'legume',
  '17': 'protein', '18': 'grain', '19': 'sweet', '20': 'grain', '22': 'prepared_dish',
  '23': 'snack',
};

// nutrient_id -> column field
const MACRO_MAP: Record<string, string> = {
  '1008': 'kcal', '1003': 'protein_g', '1005': 'carb_g', '1004': 'fat_g',
  '1079': 'fiber_g', '2000': 'sugar_g', '1258': 'sat_fat_g', '1093': 'sodium_mg',
};
// nutrient_id -> micros jsonb key (unit-suffixed)
const MICRO_MAP: Record<string, string> = {
  '1087': 'calcium_mg', '1089': 'iron_mg', '1090': 'magnesium_mg', '1092': 'potassium_mg',
  '1095': 'zinc_mg', '1162': 'vit_c_mg', '1106': 'vit_a_ug', '1114': 'vit_d_ug',
  '1178': 'vit_b12_ug', '1177': 'folate_ug', '1253': 'cholesterol_mg',
};

interface Row {
  name: string;
  food_category: string;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null; sugar_g: number | null; sat_fat_g: number | null; sodium_mg: number | null;
  micros: Record<string, number> | null;
  servings: { label: string; grams: number; is_default: boolean; seq: number }[];
}

function main() {
  const foodCsv = findFirst(DATA_DIR, 'food.csv');
  const nutrientCsv = findFirst(DATA_DIR, 'food_nutrient.csv');
  const portionCsv = findFirst(DATA_DIR, 'food_portion.csv');
  if (!foodCsv || !nutrientCsv) {
    console.error('[usda] CSVs not found under data/usda — download SR Legacy first (see README).');
    process.exit(1);
  }

  // 1. food.csv -> kept fdc_ids with mapped category + description
  const kept = new Map<string, { desc: string; cat: string }>();
  const foodLines = fs.readFileSync(foodCsv, 'utf8').split('\n');
  const fH = parseCsvLine(foodLines[0]);
  const iId = fH.indexOf('fdc_id'), iDesc = fH.indexOf('description'), iCat = fH.indexOf('food_category_id');
  for (let i = 1; i < foodLines.length; i++) {
    if (!foodLines[i]) continue;
    const r = parseCsvLine(foodLines[i]);
    const cat = CATEGORY_MAP[r[iCat]];
    if (!cat) continue; // dropped category
    kept.set(r[iId], { desc: r[iDesc], cat });
  }

  // 2. food_nutrient.csv -> macros + micros for kept fdc_ids
  const macros = new Map<string, Record<string, number>>();
  const micros = new Map<string, Record<string, number>>();
  const nLines = fs.readFileSync(nutrientCsv, 'utf8').split('\n');
  const nH = parseCsvLine(nLines[0]);
  const nFdc = nH.indexOf('fdc_id'), nNut = nH.indexOf('nutrient_id'), nAmt = nH.indexOf('amount');
  for (let i = 1; i < nLines.length; i++) {
    if (!nLines[i]) continue;
    const r = parseCsvLine(nLines[i]);
    const fdc = r[nFdc];
    if (!kept.has(fdc)) continue;
    const id = r[nNut];
    const macroField = MACRO_MAP[id];
    const microKey = MICRO_MAP[id];
    if (macroField) { const m = macros.get(fdc) ?? {}; m[macroField] = Number(r[nAmt]); macros.set(fdc, m); }
    else if (microKey) { const m = micros.get(fdc) ?? {}; m[microKey] = Number(r[nAmt]); micros.set(fdc, m); }
  }

  // 3. food_portion.csv -> servings for kept fdc_ids
  const portions = new Map<string, Row['servings']>();
  if (portionCsv) {
    const pLines = fs.readFileSync(portionCsv, 'utf8').split('\n');
    const pH = parseCsvLine(pLines[0]);
    const pFdc = pH.indexOf('fdc_id'), pSeq = pH.indexOf('seq_num'), pAmt = pH.indexOf('amount');
    const pDesc = pH.indexOf('portion_description'), pMod = pH.indexOf('modifier'), pGram = pH.indexOf('gram_weight');
    for (let i = 1; i < pLines.length; i++) {
      if (!pLines[i]) continue;
      const r = parseCsvLine(pLines[i]);
      const fdc = r[pFdc];
      if (!kept.has(fdc)) continue;
      const grams = round2(Number(r[pGram]));
      const unit = (r[pMod] || r[pDesc] || '').trim();
      if (!(grams > 0) || !unit) continue;
      const label = `${fmtAmount(Number(r[pAmt]) || 1)} ${unit}`.trim();
      const list = portions.get(fdc) ?? [];
      if (!list.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
        list.push({ label, grams, is_default: false, seq: Number(r[pSeq]) || list.length });
      }
      portions.set(fdc, list);
    }
  }

  // 4. assemble rows (skip foods missing energy)
  const rows: Row[] = [];
  for (const [fdc, { desc, cat }] of kept) {
    const m = macros.get(fdc);
    if (!m || m.kcal == null) continue;
    const servs = (portions.get(fdc) ?? []).slice().sort((a, b) => a.seq - b.seq);
    servs.push({ label: '100 g', grams: 100, is_default: false, seq: 999 });
    servs[0].is_default = true; // first real portion, else the 100 g canonical
    const mic = micros.get(fdc);
    rows.push({
      name: desc, food_category: cat,
      kcal: Math.round(m.kcal), protein_g: round1(m.protein_g ?? 0), carb_g: round1(m.carb_g ?? 0), fat_g: round1(m.fat_g ?? 0),
      fiber_g: m.fiber_g != null ? round1(m.fiber_g) : null,
      sugar_g: m.sugar_g != null ? round1(m.sugar_g) : null,
      sat_fat_g: m.sat_fat_g != null ? round1(m.sat_fat_g) : null,
      sodium_mg: m.sodium_mg != null ? Math.round(m.sodium_mg) : null,
      micros: mic && Object.keys(mic).length ? mic : null,
      servings: servs,
    });
  }

  // 5. emit chunked enriching-upsert SQL
  const esc = (s: string) => s.replace(/'/g, "''");
  const num = (n: number | null) => (n == null ? 'null' : String(n));
  const microsSql = (m: Record<string, number> | null) => (m ? `'${esc(JSON.stringify(m))}'::jsonb` : 'null');

  let sql = `-- GENERATED by scripts/diet-catalog/ingest-usda.ts — do not edit by hand.
-- Full USDA SR Legacy (CC0) server catalog: ${rows.length} foods.
-- Apply as SERVICE ROLE (so created_by stays null = global). Enriching upsert:
-- on a name conflict, fills missing extended/micro fields, merges servings, appends
-- the source. Reversible: delete from public.foods where 'usda' = any(sources).
`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const foodValues = batch.map((r) =>
      `('${esc(r.name)}','${r.food_category}','g',${r.kcal},${r.protein_g},${r.carb_g},${r.fat_g},${num(r.fiber_g)},${num(r.sugar_g)},${num(r.sat_fat_g)},${num(r.sodium_mg)},${microsSql(r.micros)},'usda',array['usda'])`,
    ).join(',\n');
    sql += `\ninsert into public.foods
  (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, micros, source, sources)
values
${foodValues}
on conflict (lower(name)) where created_by is null do update set
  fiber_g   = coalesce(public.foods.fiber_g,   excluded.fiber_g),
  sugar_g   = coalesce(public.foods.sugar_g,   excluded.sugar_g),
  sat_fat_g = coalesce(public.foods.sat_fat_g, excluded.sat_fat_g),
  sodium_mg = coalesce(public.foods.sodium_mg, excluded.sodium_mg),
  micros    = coalesce(public.foods.micros,    excluded.micros),
  sources   = (select array(select distinct e from unnest(public.foods.sources || excluded.sources) e));
`;
    const servValues = batch.flatMap((r) =>
      r.servings.map((s) => `('${esc(r.name)}','${esc(s.label)}',${s.grams},${s.is_default},${s.seq})`),
    ).join(',\n');
    sql += `\ninsert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, v.label, v.grams, v.is_default, 'usda', v.seq
from (values
${servValues}
) as v(food_name, label, grams, is_default, seq)
join public.foods f on lower(f.name) = lower(v.food_name) and f.created_by is null
on conflict (food_id, lower(label)) do nothing;
`;
  }

  const destDir = path.join(REPO_ROOT, 'supabase/seed');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'usda_foods.generated.sql');
  fs.writeFileSync(dest, sql);

  const withMicros = rows.filter((r) => r.micros).length;
  const withPortions = rows.filter((r) => r.servings.length > 1).length;
  console.log(`[usda] kept ${kept.size} foods in mapped categories`);
  console.log(`[usda] emitted ${rows.length} foods (${withMicros} with micros, ${withPortions} with household portions)`);
  console.log(`[usda] -> ${path.relative(REPO_ROOT, dest)} (${(sql.length / 1e6).toFixed(1)} MB, ${Math.ceil(rows.length / CHUNK)} batches)`);
}

main();
