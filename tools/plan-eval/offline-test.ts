/**
 * Offline tests for the deterministic half of plan generation.
 *
 * Zero network. Drives the REAL shipped module
 * (supabase/functions/ai-coach/generatePlan.ts) with a mock TextCaller, which
 * is precisely what GeneratePlanDeps exists to allow.
 *
 * This covers what the API-backed eval cannot reach cheaply: malformed model
 * output, partial and total call failure, and the assembly rules. The failure
 * path matters because a bug there is silent by construction — a plan where
 * every fill died still comes out structurally valid, just uniformly wrong.
 *
 *   npx tsx tools/plan-eval/offline-test.ts
 *
 * Exits nonzero on the first failing assertion set. No test runner needed;
 * the repo has none configured.
 */
import {
  assemblePlan, buildWorkout, parseFill, parseSkeleton, runGeneratePlan,
  stripToolDirectives, type PlanExercise, type TextCaller,
} from '../../supabase/functions/ai-coach/generatePlan';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : `\n      got: ${JSON.stringify(detail)}`}`);
}

const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);

// ── parseSkeleton ───────────────────────────────────────────────────────────

{
  const raw = `PLAN | 4-Day Upper/Lower | Upper/Lower | 4
DAY | Upper Heavy | horizontal press focus
SLOT | Bench Press
SLOT | Barbell Row
DAY | Lower Heavy | squat pattern
SLOT | Squat
SLOT | Romanian Deadlift`;
  const s = parseSkeleton(raw)!;
  check('skeleton: parses', s !== null);
  eq('skeleton: name', s.name, '4-Day Upper/Lower');
  eq('skeleton: split', s.split_type, 'Upper/Lower');
  eq('skeleton: days_per_week', s.days_per_week, 4);
  eq('skeleton: day count', s.days.length, 2);
  eq('skeleton: day1 slots', s.days[0].slots, ['Bench Press', 'Barbell Row']);
  eq('skeleton: day1 note', s.days[0].note, 'horizontal press focus');
}

{
  // Models like to wrap output in fences or lead lines with bullets.
  const s = parseSkeleton('```\nPLAN | P | Full Body | 2\n- DAY | A | full body\n  * SLOT | Squat\n```')!;
  check('skeleton: survives fences and bullets', s !== null && s.days[0]?.slots[0] === 'Squat', s);
}

check('skeleton: empty -> null', parseSkeleton('') === null);
check('skeleton: prose -> null', parseSkeleton('Here is your plan! Day 1: Bench Press...') === null);
check('skeleton: DAY with no SLOT -> null', parseSkeleton('PLAN | P | X | 3\nDAY | A | focus') === null);
{
  // SLOT before any DAY has nothing to attach to; must not crash or invent one.
  const s = parseSkeleton('SLOT | Orphan\nDAY | A | f\nSLOT | Squat');
  eq('skeleton: orphan SLOT ignored', s?.days[0].slots, ['Squat']);
}

// ── parseFill ───────────────────────────────────────────────────────────────

{
  const f = parseFill(`EX | Bench Press | 4 | 5 | 180 | top set heavy, RIR 1
EX | Barbell Row | 3 | 8-10 | 90
EX | Plank | 3 | 45s | 60 | brace hard`);
  eq('fill: count', f.length, 3);
  eq('fill: full line', f[0], { name: 'Bench Press', sets: 4, reps: '5', rest_seconds: 180, note: 'top set heavy, RIR 1' });
  eq('fill: cue omitted', f[1].note, undefined);
  eq('fill: duration reps preserved', f[2].reps, '45s');
}

{
  // Out-of-range and junk values must clamp to something usable rather than
  // propagate. A saved routine with sets=99 is worse than sets=6.
  const f = parseFill('EX | Squat | 99 | 6-8 | 9999 |\nEX | Curl | abc | | -5 |');
  eq('fill: sets clamped high', f[0].sets, 6);
  eq('fill: rest clamped high', f[0].rest_seconds, 300);
  eq('fill: junk sets -> default', f[1].sets, 3);
  eq('fill: empty reps -> default', f[1].reps, '8-12');
  eq('fill: negative rest clamped', f[1].rest_seconds, 30);
}

eq('fill: ignores non-EX lines', parseFill('Here you go:\nDAY | A | x\nEX | Squat | 3 | 5 | 120 |').length, 1);
eq('fill: nameless EX dropped', parseFill('EX |  | 3 | 5 | 120 |').length, 0);

// ── buildWorkout / assemblePlan ─────────────────────────────────────────────

const day = { name: 'Upper', note: 'push focus', slots: ['Bench Press', 'Barbell Row'] };

{
  const w = buildWorkout(day, parseFill('EX | Barbell Row | 3 | 8-10 | 90 | strict\nEX | Bench Press | 4 | 5 | 180 | heavy'));
  // Fills may come back reordered; slots are the source of truth for order.
  eq('assemble: slot order wins', w.exercises.map((e) => e.name), ['Bench Press', 'Barbell Row']);
  eq('assemble: matched by name not position', w.exercises[0].sets, 4);
}

{
  // A fill that renamed an exercise must not change the plan. The skeleton
  // chose the movement; positional fallback keeps its prescription.
  const w = buildWorkout(day, parseFill('EX | Flat Barbell Bench | 4 | 5 | 180 | heavy\nEX | Bent Over Row | 3 | 10 | 90 |'));
  eq('assemble: skeleton wins on naming', w.exercises.map((e) => e.name), ['Bench Press', 'Barbell Row']);
  eq('assemble: positional fallback keeps prescription', w.exercises[0].sets, 4);
}

{
  const w = buildWorkout(day, null);
  eq('assemble: null fill -> every slot kept', w.exercises.map((e) => e.name), ['Bench Press', 'Barbell Row']);
  eq('assemble: null fill -> safe defaults', w.exercises[0], { name: 'Bench Press', sets: 3, reps: '8-12', rest_seconds: 90, note: undefined });
}

{
  const plan = assemblePlan(
    { name: 'P', split_type: 'UL', days_per_week: 2, days: [day] },
    [parseFill('EX | Bench Press | 4 | 5 | 180 |\nEX | Barbell Row | 3 | 8 | 90 |')],
    '  why this plan  ',
  );
  eq('assemble: rationale trimmed', plan.rationale, 'why this plan');
  eq('assemble: workout count', plan.workouts.length, 1);
  eq('assemble: passes through split', plan.split_type, 'UL');
}

// ── stripToolDirectives ─────────────────────────────────────────────────────
// Not cosmetic: leaving these in while asking for a line format produced a
// ~17% skeleton failure rate where the model emitted `generate_plan({...})`
// as literal text.

{
  const msg = `Build my plan.
- Exercise names MUST be copied character-for-character from this catalog, nothing else: Squat; Bench Press.
This is a fresh account, so skip data-lookup tools and emit generate_plan directly.`;
  const out = stripToolDirectives(msg);
  check('strip: removes fresh-account directive', !out.includes('fresh account'), out);
  check('strip: removes emit-directly directive', !out.includes('emit generate_plan directly'), out);
  check('strip: repoints catalog at system block', out.includes('<exercise_catalog> in the system prompt'), out);
  check('strip: does not inline the catalog', !out.includes('Squat; Bench Press'), out);
}
{
  const coach = 'Design a plan. Before calling generate_plan, write one short sentence signaling your intent.';
  check('strip: removes coach intent directive', !stripToolDirectives(coach).includes('Before calling generate_plan'), stripToolDirectives(coach));
}

// ── runGeneratePlan failure thresholds ──────────────────────────────────────
// The bug this exists to prevent: with every fill dead, assemblePlan still
// returns a structurally valid plan where each exercise is 3x8-12 @ 90s with
// no cue and no rationale. A caller checking only for null would save that as
// a Drona-authored plan.

const SKELETON_4D = `PLAN | Test Plan | Upper/Lower | 4
DAY | Upper A | push
SLOT | Bench Press
SLOT | Barbell Row
DAY | Lower A | squat
SLOT | Squat
SLOT | Leg Curl
DAY | Upper B | pull
SLOT | Overhead Press
SLOT | Lat Pulldown
DAY | Lower B | hinge
SLOT | Deadlift
SLOT | Leg Press`;

const FILL_OK = 'EX | X | 3 | 8-10 | 90 | cue';

/** Mock caller: decides per label whether to answer or throw. */
function mockCaller(behavior: (label: string) => string | Error): TextCaller {
  return async ({ label }) => {
    const r = behavior(label);
    if (r instanceof Error) throw r;
    return { text: r, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  };
}

const deps = (behavior: (label: string) => string | Error) => ({
  call: mockCaller(behavior),
  catalog: ['Bench Press', 'Squat'],
  system: [{ type: 'text', text: 'sys' }],
});

// Wrapped in main(): the repo compiles to CJS, so no top-level await.
async function main() {
{
  const r = await runGeneratePlan('build me a plan', deps((l) =>
    l === 'skeleton' ? SKELETON_4D : l === 'rationale' ? 'Because it fits you well.' : FILL_OK));
  check('happy: plan returned', r.plan !== null);
  eq('happy: workouts', r.plan?.workouts.length, 4);
  eq('happy: calls', r.calls, 6); // skeleton + 4 fills + rationale
  eq('happy: no error', r.error, undefined);
  eq('happy: stage count', r.stages.length, 6);
}

{
  const r = await runGeneratePlan('x', deps((l) => l === 'skeleton' ? new Error('boom') : FILL_OK));
  eq('skeleton fails -> null plan', r.plan, null);
  check('skeleton fails -> reason surfaced', (r.error ?? '').includes('boom'), r.error);
}

{
  const r = await runGeneratePlan('x', deps((l) => l === 'skeleton' ? 'not a skeleton at all' : FILL_OK));
  eq('skeleton unparseable -> null plan', r.plan, null);
  check('skeleton unparseable -> includes raw head', (r.error ?? '').includes('not a skeleton'), r.error);
}

{
  // ALL fills dead. Must NOT return a defaults-only plan.
  const r = await runGeneratePlan('x', deps((l) =>
    l === 'skeleton' ? SKELETON_4D : l === 'rationale' ? 'Good reasons here.' : new Error('api 400')));
  eq('all fills dead -> null plan', r.plan, null);
  check('all fills dead -> count reported', (r.error ?? '').includes('4/4'), r.error);
  check('all fills dead -> underlying reason kept', (r.error ?? '').includes('api 400'), r.error);
}

{
  // 3 of 4 dead is past the half threshold.
  let n = 0;
  const r = await runGeneratePlan('x', deps((l) => {
    if (l === 'skeleton') return SKELETON_4D;
    if (l === 'rationale') return 'Good reasons here.';
    return ++n === 1 ? FILL_OK : new Error('api 400');
  }));
  eq('majority fills dead -> null plan', r.plan, null);
}

{
  // 1 of 4 dead is survivable: degrade that day, keep the plan, but say so.
  let n = 0;
  const r = await runGeneratePlan('x', deps((l) => {
    if (l === 'skeleton') return SKELETON_4D;
    if (l === 'rationale') return 'Good reasons here.';
    return ++n === 1 ? new Error('api 400') : FILL_OK;
  }));
  check('one fill dead -> plan still returned', r.plan !== null);
  check('one fill dead -> flagged in error', (r.error ?? '').includes('1/4'), r.error);
  eq('one fill dead -> all days present', r.plan?.workouts.length, 4);
}

{
  // No rationale means the reveal card has nothing to show. Not survivable.
  const r = await runGeneratePlan('x', deps((l) =>
    l === 'skeleton' ? SKELETON_4D : l === 'rationale' ? new Error('api 400') : FILL_OK));
  eq('rationale dead -> null plan', r.plan, null);
  check('rationale dead -> reason surfaced', (r.error ?? '').includes('rationale'), r.error);
}

{
  // Callbacks are what let the client render structure at ~5s.
  const days: number[] = [];
  let skeletonSeen = false;
  await runGeneratePlan('x', {
    ...deps((l) => l === 'skeleton' ? SKELETON_4D : l === 'rationale' ? 'Reasons.' : FILL_OK),
    onSkeleton: () => { skeletonSeen = true; },
    onDay: (i) => { days.push(i); },
  });
  check('onSkeleton fires', skeletonSeen);
  eq('onDay fires once per day', days.sort().length, 4);
}

// ── report ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(64)}`);
if (failures.length === 0) {
  console.log(`offline-test: ${passed}/${passed} assertions passed`);
  process.exit(0);
}
console.log(`offline-test: ${passed} passed, ${failures.length} FAILED\n`);
for (const f of failures) console.log(`  x ${f}`);
process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
