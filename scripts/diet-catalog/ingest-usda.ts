/**
 * Full USDA SR Legacy ingest (CC0) -> the SERVER catalog seed.
 *
 * Unlike build.ts (which emits the SMALL bundled offline library), this ingests
 * the whole filtered SR Legacy generic catalog (~6.8k foods) into a seed SQL for
 * Supabase `foods` + `food_servings`. It writes ENRICHING UPSERTS: insert new
 * foods, and on a name conflict fill missing extended/micro fields, merge servings,
 * and append the source (see migration 0066). This same upsert shape is what every
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

// Parameterized so one ingester serves SR Legacy + Foundation + FNDDS (all share the
// FDC food.csv/food_nutrient.csv/food_portion.csv schema):
//   USDA_DIR       subdir under data/ (default 'usda' = SR Legacy)
//   USDA_REGION    region tag (default 'usa')
//   USDA_DATA_TYPE if set, keep only rows of this data_type (e.g. 'foundation_food',
//                  'survey_fndds_food') — drops the sub-sample/acquisition noise
//   USDA_OUT       output seed filename (default 'usda_foods.generated.sql')
const DATA_DIR = path.join(__dirname, 'data', process.env.USDA_DIR || 'usda');
const REGION = process.env.USDA_REGION || 'usa';
const DATA_TYPE = process.env.USDA_DATA_TYPE || '';
const OUT = process.env.USDA_OUT || 'usda_foods.generated.sql';
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

// USDA food_category_id -> our FoodCategory. Only true junk is dropped: 3 Baby
// Foods, 26 Branded, 27 Quality Control. Fast Foods (21), Restaurant Foods (25),
// and American Indian/Alaska Native (24) are KEPT — people log fast-food and
// restaurant meals.
const CATEGORY_MAP: Record<string, string> = {
  '1': 'dairy', '2': 'condiment', '4': 'fat_oil', '5': 'protein', '6': 'prepared_dish',
  '7': 'protein', '8': 'grain', '9': 'fruit', '10': 'protein', '11': 'vegetable',
  '12': 'nuts_seeds', '13': 'protein', '14': 'beverage', '15': 'protein', '16': 'legume',
  '17': 'protein', '18': 'grain', '19': 'sweet', '20': 'grain', '21': 'prepared_dish',
  '22': 'prepared_dish', '23': 'snack', '24': 'other', '25': 'prepared_dish',
};

// FNDDS uses WWEIA category ids (a different id space), so map via the category's
// text description instead. Loaded from wweia_food_category.csv when present.
function wweiaCategory(desc: string): string {
  const s = desc.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => s.includes(w));
  if (has('milk', 'cheese', 'yogurt', 'cream', 'dairy', 'butter')) return 'dairy';
  if (has('beef', 'pork', 'chicken', 'turkey', 'fish', 'seafood', 'egg', 'meat', 'poultry', 'sausage', 'bacon', 'ham', 'lamb', 'shrimp')) return 'protein';
  if (has('bean', 'lentil', 'legume', 'pea', 'tofu', 'soy')) return 'legume';
  if (has('bread', 'rice', 'pasta', 'cereal', 'grain', 'oat', 'tortilla', 'noodle', 'cracker', 'bagel', 'pancake')) return 'grain';
  if (has('fruit', 'apple', 'banana', 'berry', 'melon', 'citrus', 'juice')) return has('juice') ? 'beverage' : 'fruit';
  if (has('vegetable', 'potato', 'tomato', 'salad', 'carrot', 'bean green')) return 'vegetable';
  if (has('candy', 'cookie', 'cake', 'pie', 'ice cream', 'dessert', 'sweet', 'sugar', 'chocolate', 'pastry', 'doughnut')) return 'sweet';
  if (has('chip', 'popcorn', 'pretzel', 'snack')) return 'snack';
  if (has('soft drink', 'soda', 'coffee', 'tea', 'water', 'beer', 'wine', 'alcohol', 'drink', 'beverage', 'smoothie')) return 'beverage';
  if (has('oil', 'fat', 'margarine', 'dressing', 'mayonnaise')) return 'fat_oil';
  if (has('nut', 'seed', 'peanut')) return 'nuts_seeds';
  if (has('sauce', 'condiment', 'gravy', 'dip', 'spread', 'syrup')) return 'condiment';
  // WWEIA is dominated by mixed/prepared dishes ("Meat mixed dishes", "Pizza"...) -> default
  return 'prepared_dish';
}

/** id -> description from wweia_food_category.csv (FNDDS only; empty otherwise). */
function loadWweia(dir: string): Map<string, string> {
  const file = findFirst(dir, 'wweia_food_category.csv');
  const map = new Map<string, string>();
  if (!file) return map;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const h = parseCsvLine(lines[0]);
  const iId = h.indexOf('wweia_food_category'), iDesc = h.indexOf('wweia_food_category_description');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = parseCsvLine(lines[i]);
    if (r[iId]) map.set(r[iId], r[iDesc] ?? '');
  }
  return map;
}

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

// Resolve nutrients by NAME from the dataset's nutrient.csv, indexed by BOTH the FDC
// `id` (SR Legacy/Foundation use these, e.g. 1008) and the legacy `nutrient_nbr`
// (FNDDS uses these, e.g. 208) so one code path handles every FDC dataset.
const MACRO_NAMES: [RegExp, string, string?][] = [
  [/^energy$/i, 'kcal', 'KCAL'], // exclude the kJ Energy row via the unit guard
  [/^energy \(atwater (general|specific) factors\)$/i, 'kcal', 'KCAL'], // Foundation foods often only carry Atwater energy
  [/^total sugars$/i, 'sugar_g'],
  [/^protein$/i, 'protein_g'],
  [/^carbohydrate, by difference$/i, 'carb_g'],
  [/^total lipid \(fat\)$/i, 'fat_g'],
  [/^fiber, total dietary$/i, 'fiber_g'],
  [/^(sugars, total.*|total sugars.*)$/i, 'sugar_g'],
  [/^fatty acids, total saturated$/i, 'sat_fat_g'],
  [/^sodium, na$/i, 'sodium_mg'],
];
const MICRO_NAMES: [RegExp, string][] = [
  [/^calcium, ca$/i, 'calcium_mg'], [/^iron, fe$/i, 'iron_mg'], [/^magnesium, mg$/i, 'magnesium_mg'],
  [/^potassium, k$/i, 'potassium_mg'], [/^zinc, zn$/i, 'zinc_mg'],
  [/^vitamin c, total ascorbic acid$/i, 'vit_c_mg'], [/^vitamin a, rae$/i, 'vit_a_ug'],
  [/^vitamin d \(d2 \+ d3\)$/i, 'vit_d_ug'], [/^vitamin b-12$/i, 'vit_b12_ug'],
  [/^folate, total$/i, 'folate_ug'], [/^cholesterol$/i, 'cholesterol_mg'],
];
function loadNutrientMaps(dir: string): { macro: Map<string, string>; micro: Map<string, string> } {
  const macro = new Map<string, string>(), micro = new Map<string, string>();
  const file = findFirst(dir, 'nutrient.csv');
  if (!file) { // fall back to hardcoded FDC ids if no nutrient.csv (older SR Legacy layout)
    for (const [k, v] of Object.entries(MACRO_MAP)) macro.set(k, v);
    for (const [k, v] of Object.entries(MICRO_MAP)) micro.set(k, v);
    return { macro, micro };
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const h = parseCsvLine(lines[0]);
  const iId = h.indexOf('id'), iName = h.indexOf('name'), iUnit = h.indexOf('unit_name'), iNbr = h.indexOf('nutrient_nbr');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = parseCsvLine(lines[i]);
    const name = r[iName] ?? '', unit = (r[iUnit] ?? '').toUpperCase();
    const keys = [r[iId], r[iNbr], r[iNbr]?.split('.')[0]].filter(Boolean) as string[];
    for (const [re, field, unitReq] of MACRO_NAMES) {
      if (re.test(name) && (!unitReq || unit === unitReq)) { for (const k of keys) if (!macro.has(k)) macro.set(k, field); }
    }
    for (const [re, field] of MICRO_NAMES) {
      if (re.test(name)) { for (const k of keys) if (!micro.has(k)) micro.set(k, field); }
    }
  }
  return { macro, micro };
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
  const wweia = loadWweia(DATA_DIR);
  const kept = new Map<string, { desc: string; cat: string }>();
  const foodLines = fs.readFileSync(foodCsv, 'utf8').split('\n');
  const fH = parseCsvLine(foodLines[0]);
  const iId = fH.indexOf('fdc_id'), iDesc = fH.indexOf('description'), iCat = fH.indexOf('food_category_id');
  const iType = fH.indexOf('data_type');
  for (let i = 1; i < foodLines.length; i++) {
    if (!foodLines[i]) continue;
    const r = parseCsvLine(foodLines[i]);
    if (DATA_TYPE && r[iType] !== DATA_TYPE) continue; // e.g. keep only foundation_food / survey_fndds_food
    // SR Legacy/Foundation category ids map directly; FNDDS WWEIA ids map via description.
    const cat = CATEGORY_MAP[r[iCat]] ?? (wweia.has(r[iCat]) ? wweiaCategory(wweia.get(r[iCat])!) : undefined);
    if (!cat) continue; // dropped category
    kept.set(r[iId], { desc: r[iDesc], cat });
  }

  // 2. food_nutrient.csv -> macros + micros for kept fdc_ids
  const { macro: macroMap, micro: microMap } = loadNutrientMaps(DATA_DIR);
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
    const macroField = macroMap.get(id);
    const microField = microMap.get(id);
    if (macroField) { const m = macros.get(fdc) ?? {}; m[macroField] = Number(r[nAmt]); macros.set(fdc, m); }
    else if (microField) { const m = micros.get(fdc) ?? {}; m[microField] = Number(r[nAmt]); micros.set(fdc, m); }
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
      const mod = (r[pMod] || '').trim();
      const desc = (r[pDesc] || '').trim();
      if (!(grams > 0)) continue;
      // FNDDS survey rows put a numeric portion CODE in `modifier` and the human
      // text (which already includes its own quantity, e.g. "1 cup") in
      // `portion_description`. SR Legacy is the reverse: text in `modifier`,
      // empty description. Preferring modifier unconditionally is what shipped
      // 21k unusable labels like "1 64556" to prod.
      let label: string;
      if (/^\d{4,6}$/.test(mod)) {
        if (!desc || /quantity not specified/i.test(desc)) continue;
        label = desc;
      } else {
        const unit = mod || desc;
        if (!unit) continue;
        label = `${fmtAmount(Number(r[pAmt]) || 1)} ${unit}`.trim();
      }
      const list = portions.get(fdc) ?? [];
      if (!list.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
        list.push({ label, grams, is_default: false, seq: Number(r[pSeq]) || list.length });
      }
      portions.set(fdc, list);
    }
  }

  // 4. assemble rows (skip foods missing energy; dedupe by name so the upsert's
  //    ON CONFLICT never hits the same key twice within one batch)
  const rows: Row[] = [];
  const seenNames = new Set<string>();
  for (const [fdc, { desc, cat }] of kept) {
    const m = macros.get(fdc);
    if (!m || m.kcal == null) continue;
    const nameKey = desc.trim().toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
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
-- USDA (CC0) server catalog: ${rows.length} foods (region='${REGION}'${DATA_TYPE ? `, data_type=${DATA_TYPE}` : ''}).
-- Apply as SERVICE ROLE (created_by stays null = global). DO NOTHING on name conflict
-- (segregation-safe: never merges into a non-usda row); usda servings attach only to
-- usda rows. Reversible: delete from public.foods where 'usda' = any(sources).
`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const foodValues = batch.map((r) =>
      `('${esc(r.name)}','${r.food_category}','g',${r.kcal},${r.protein_g},${r.carb_g},${r.fat_g},${num(r.fiber_g)},${num(r.sugar_g)},${num(r.sat_fat_g)},${num(r.sodium_mg)},${microsSql(r.micros)},'usda',array['usda'],'${REGION}')`,
    ).join(',\n');
    sql += `\ninsert into public.foods
  (name, food_category, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, micros, source, sources, region)
values
${foodValues}
on conflict (lower(name)) where created_by is null do nothing;
`;
    const servValues = batch.flatMap((r) =>
      r.servings.map((s) => `('${esc(r.name)}','${esc(s.label)}',${s.grams},${s.seq})`),
    ).join(',\n');
    const batchNames = batch.map((r) => `'${esc(r.name.toLowerCase())}'`).join(', ');
    const defaultPairs = batch.map((r) => {
      const def = r.servings.find((s) => s.is_default) ?? r.servings[0];
      return `('${esc(r.name)}','${esc(def.label)}')`;
    }).join(',\n');
    // Servings: converge grams/seq for existing labels and add new ones as
    // non-default (do update, not do nothing, so reruns actually refresh them).
    sql += `\ninsert into public.food_servings (food_id, label, grams, is_default, source, seq)
select f.id, v.label, v.grams, false, 'usda', v.seq
from (values
${servValues}
) as v(food_name, label, grams, seq)
join public.foods f on lower(f.name) = lower(v.food_name) and f.created_by is null and 'usda' = any(f.sources)
on conflict (food_id, lower(label)) do update set grams = excluded.grams, seq = excluded.seq;
`;
    // Exactly one default serving per food (uq_food_servings_default): clear then
    // set, in two statements so a changed default (100 g on a first load without
    // food_portion.csv -> a real portion on a later rerun) can't momentarily
    // leave two defaults and trip the partial unique index.
    sql += `\nupdate public.food_servings s set is_default = false
from public.foods f
where s.food_id = f.id and f.created_by is null and 'usda' = any(f.sources) and s.is_default
  and lower(f.name) in (${batchNames});

update public.food_servings s set is_default = true
from (values
${defaultPairs}
) as d(food_name, label)
join public.foods f on lower(f.name) = lower(d.food_name) and f.created_by is null and 'usda' = any(f.sources)
where s.food_id = f.id and lower(s.label) = lower(d.label);
`;
  }

  const destDir = path.join(REPO_ROOT, 'supabase/seed');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, OUT);
  fs.writeFileSync(dest, sql);

  const withMicros = rows.filter((r) => r.micros).length;
  const withPortions = rows.filter((r) => r.servings.length > 1).length;
  console.log(`[usda] kept ${kept.size} foods in mapped categories`);
  console.log(`[usda] emitted ${rows.length} foods (${withMicros} with micros, ${withPortions} with household portions)`);
  console.log(`[usda] -> ${path.relative(REPO_ROOT, dest)} (${(sql.length / 1e6).toFixed(1)} MB, ${Math.ceil(rows.length / CHUNK)} batches)`);
}

main();
