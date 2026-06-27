// Phase E — free-exercise-db ingest DRY RUN (no writes anywhere).
//
// Fetches yuhonas/free-exercise-db, maps its taxonomy onto Overload's
// MUSCLE_GROUPS / CATEGORIES, infers a metric_type per exercise (Phase A), and
// CURATES the import:
//   - exact-name dedup vs the live global catalog (current-catalog.json)
//   - alias-merge: source variants whose reduced name collapses onto an existing
//     lift (e.g. "Barbell Bench Press - Medium Grip" -> "bench press") are folded
//     in, so we don't ship duplicate bench presses
//   - trims the mobility long tail (category=stretching, foam-roll equipment)
// Reports new / matched / merged / dropped + distributions + image totals, and
// writes the full plan for review.
//
// Run:  node tools/exercise-ingest/dry-run.mjs
// Out:  tools/exercise-ingest/dry-run-output.json
//
// Nothing here touches Supabase, Storage, or the catalog.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET_URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const IMAGE_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';

// Curation toggles (reported either way).
const DROP_STRETCHING = true;   // category === 'stretching' (mobility, not set-logged)
const DROP_FOAM_ROLL = true;    // equipment === 'foam roll'

// ── Overload's canonical vocab (mirror of lib/exercises.ts) ──────────────────
const MUSCLE_MAP = {
  chest: 'Chest',
  lats: 'Back', 'middle back': 'Back', 'lower back': 'Back', traps: 'Back',
  shoulders: 'Shoulders', neck: 'Shoulders',
  biceps: 'Biceps', forearms: 'Biceps',
  triceps: 'Triceps',
  quadriceps: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes', abductors: 'Glutes', adductors: 'Glutes',
  calves: 'Calves',
  abdominals: 'Core',
};
const EQUIP_MAP = {
  barbell: 'Barbell', 'e-z curl bar': 'Barbell',
  dumbbell: 'Dumbbell', kettlebells: 'Dumbbell',
  cable: 'Cable', bands: 'Cable',
  machine: 'Machine', 'leverage (machine)': 'Machine',
  'body only': 'Bodyweight',
};

const mapMuscle = (ex) => MUSCLE_MAP[(ex.primaryMuscles?.[0] || '').toLowerCase().trim()] || 'Other';
function mapCategory(ex) {
  const equip = (ex.equipment || '').toLowerCase().trim();
  if (!equip || equip === 'none') return 'Bodyweight'; // null/blank equipment = body-only moves
  return EQUIP_MAP[equip] || 'Other';
}

function inferMetricType(ex) {
  const cat = (ex.category || '').toLowerCase();
  const equip = (ex.equipment || '').toLowerCase().trim();
  const name = (ex.name || '').toLowerCase();
  if (/(carry|farmer|suitcase|yoke|waiter walk)/.test(name)) return 'weight_distance';
  if (cat === 'cardio') {
    return /(run|sprint|jog|treadmill|cycl|bike|row|elliptical|skierg|stair|ski)/.test(name)
      ? 'distance_duration' : 'duration';
  }
  if (cat === 'stretching' || /stretch$/.test(name)) return 'duration';
  if (/(plank|wall sit|l-sit|hollow hold|superman|iso hold|dead hang|\bhang\b|hold$|bridge$|pose$)/.test(name)) return 'duration';
  const bodyOnly = equip === 'body only' || equip === '' || equip === 'none' || equip === 'exercise ball';
  if (bodyOnly) return 'bodyweight_reps';
  return 'weight_reps';
}

// Exact dedup key.
const key = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Equipment-AWARE identity. We strip only REDUNDANT qualifiers (parentheticals,
// neutral "- medium/standard grip", alternate/alternating) and KEEP equipment +
// movement words — so "Smith Machine Bench Press", "Machine Bench Press", and
// "Dumbbell Bench Press" stay three distinct rows targeting the same muscle.
// The single concession: our legacy catalog names barbell basics WITHOUT the
// word "Barbell" (we have "Bench Press", "Deadlift", "Squat"), so a source
// "Barbell <X>" folds into our "<X>" when "<X>" already exists — and ONLY
// barbell, never machine/smith/dumbbell/cable.
function normCore(name) {
  let n = (name || '').toLowerCase();
  n = n.replace(/\([^)]*\)/g, ' ');
  n = n.replace(/[-–]\s*(medium|standard)\s*grip/g, ' ');
  n = n.replace(/\b(medium|standard)\s*grip\b/g, ' ');
  n = n.replace(/\b(alternate|alternating)\b/g, ' ');
  return n.replace(/\s+/g, ' ').trim();
}
const matchKey = (name) => key(normCore(name));
// "Barbell Bench Press - Medium Grip" -> "bench press" (only the leading Barbell).
function barbellAliasKey(name) {
  const c = normCore(name);
  return c.startsWith('barbell ') ? key(c.slice(8)) : null;
}

function tally(rows, field) {
  const out = {};
  for (const r of rows) out[r[field]] = (out[r[field]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

async function main() {
  const catalogRaw = JSON.parse(await readFile(join(HERE, 'current-catalog.json'), 'utf8'));
  const names = catalogRaw.names || [];
  const existingExact = new Set(names.map(key));
  const existingMatch = new Set(names.map(matchKey));
  // matchKey -> readable existing name, so "merged into" reads "bench press".
  const matchToName = new Map();
  for (const n of names) if (!matchToName.has(matchKey(n))) matchToName.set(matchKey(n), n);

  console.log(`Fetching ${DATASET_URL} ...`);
  const res = await fetch(DATASET_URL);
  if (!res.ok) throw new Error(`dataset fetch failed: HTTP ${res.status}`);
  const source = await res.json();
  console.log(`Source exercises: ${source.length}\n`);

  const mapped = [];
  const matchedExact = [];
  const aliasMerged = [];   // [sourceName -> reducedKey]
  const dropped = [];       // { name, reason }
  const seen = new Set();

  for (const ex of source) {
    const name = (ex.name || '').trim();
    if (!name) { dropped.push({ name: '(blank)', reason: 'no name' }); continue; }
    const k = key(name);
    const mk = matchKey(name);
    const ak = barbellAliasKey(name);

    if (existingExact.has(k) || existingMatch.has(mk)) { matchedExact.push(name); continue; }
    if (ak && existingMatch.has(ak)) { aliasMerged.push({ name, mergedInto: matchToName.get(ak) ?? ak }); continue; }
    if (seen.has(mk)) { dropped.push({ name, reason: 'dup within dataset' }); continue; }

    const cat = (ex.category || '').toLowerCase();
    const equip = (ex.equipment || '').toLowerCase().trim();
    if (DROP_STRETCHING && cat === 'stretching') { dropped.push({ name, reason: 'stretching' }); continue; }
    if (DROP_FOAM_ROLL && equip === 'foam roll') { dropped.push({ name, reason: 'foam roll' }); continue; }

    seen.add(mk);
    const images = (ex.images || []).map((p) => IMAGE_BASE + p);
    mapped.push({
      name,
      muscle_group: mapMuscle(ex),
      category: mapCategory(ex),
      metric_type: inferMetricType(ex),
      instructions: ex.instructions || [],
      image_urls: images,
      _src: { id: ex.id, primaryMuscles: ex.primaryMuscles, equipment: ex.equipment, category: ex.category, level: ex.level },
    });
  }

  const droppedByReason = tally(dropped, 'reason');
  const totalImages = mapped.reduce((n, m) => n + m.image_urls.length, 0);
  const otherCat = mapped.filter((m) => m.category === 'Other').length;

  const report = {
    generatedFrom: DATASET_URL,
    sourceCount: source.length,
    existingGlobalCatalog: existingExact.size,
    curation: { DROP_STRETCHING, DROP_FOAM_ROLL, aliasMergeEnabled: true },
    matchedExisting: matchedExact.length,
    aliasMerged: aliasMerged.length,
    droppedTotal: dropped.length,
    droppedByReason,
    newToImport: mapped.length,
    imagesToUpload: totalImages,
    newRowsInOtherCategory: otherCat,
    distribution: {
      muscle_group: tally(mapped, 'muscle_group'),
      category: tally(mapped, 'category'),
      metric_type: tally(mapped, 'metric_type'),
    },
  };

  await writeFile(join(HERE, 'dry-run-output.json'),
    JSON.stringify({ report, aliasMerged, dropped, matchedExact, mapped }, null, 2));

  const pad = (o) => Object.entries(o).map(([k2, v]) => `      ${String(k2).padEnd(20)} ${v}`).join('\n');
  console.log('================ INGEST DRY RUN (curated) ================');
  console.log(`  source dataset:          ${report.sourceCount}`);
  console.log(`  existing global rows:    ${report.existingGlobalCatalog}`);
  console.log(`  exact matches (skip):    ${report.matchedExisting}`);
  console.log(`  alias-merged (skip):     ${report.aliasMerged}  <- folded into existing lifts`);
  console.log(`  dropped:                 ${report.droppedTotal}`);
  console.log('  dropped by reason:\n' + pad(droppedByReason));
  console.log(`  >>> NEW to import:       ${report.newToImport}`);
  console.log(`  images to upload:        ${report.imagesToUpload}`);
  console.log(`  new rows in "Other" cat: ${report.newRowsInOtherCategory}`);
  console.log('\n  by muscle_group:\n' + pad(report.distribution.muscle_group));
  console.log('\n  by category:\n' + pad(report.distribution.category));
  console.log('\n  by metric_type:\n' + pad(report.distribution.metric_type));
  console.log('\n  alias-merge sample (source  ->  existing lift it folds into, first 15):');
  for (const a of aliasMerged.slice(0, 15)) console.log(`      ${a.name.padEnd(42)} ->  ${a.mergedInto}`);
  console.log('\n  full plan + every merge/drop written to tools/exercise-ingest/dry-run-output.json');
  console.log('==========================================================');
}

main().catch((e) => { console.error('DRY RUN FAILED:', e); process.exit(1); });
