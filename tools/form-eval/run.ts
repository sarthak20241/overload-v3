/**
 * Form engine test suite.
 *
 *   npx tsx tools/form-eval/run.ts
 *   npx tsx tools/form-eval/run.ts --verbose
 *
 * No network, no native modules, no device. Everything here is synthetic pose
 * data with a known answer, which is what lets the rep machine and the rule
 * interpreter be trusted before any camera work starts.
 */

import { FormEngine, evalMeasure } from '../../lib/form/engine';
import { decodeMoveNet } from '../../lib/form/keypoints';
import {
  MOVENET_OUTPUT_LENGTH,
  aspectOf,
  checkOutputShape,
  deriveInputSpec,
  viewOutput,
} from '../../lib/form/model';
import { angleAt, detectSide } from '../../lib/form/geometry';
import { PATTERN_SPECS, guessPattern, specForPattern } from '../../lib/form/patterns';
import { parseFormRuleSpec, type FormRuleSpec } from '../../lib/form/spec';
import { occlude, pressSequence, squatSequence, squatSkeleton } from './synth';
import { runResolveTests } from './resolve.test';

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
const failures: string[] = [];

/**
 * Runs a case. Async cases return a promise the caller awaits; sync cases stay
 * sync so the bulk of the suite reads without ceremony.
 */
function check(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  const pass = () => {
    passed++;
    if (VERBOSE) console.log(`  ok   ${name}`);
  };
  const fail = (e: unknown) => {
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(pass, fail);
    pass();
  } catch (e) {
    fail(e);
  }
}

function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

function near(actual: number, expected: number, tol: number, what: string) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${what}: expected ${expected} +/- ${tol}, got ${actual}`);
  }
}

function assert(cond: boolean, what: string) {
  if (!cond) throw new Error(what);
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ── geometry ────────────────────────────────────────────────────────────────
section('geometry');

check('angleAt is 180 for a straight limb', () => {
  near(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }), 180, 0.001, 'straight');
});

check('angleAt is 90 for a right angle', () => {
  near(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }), 90, 0.001, 'right angle');
});

check('detectSide reads the synthetic squat as a side view', () => {
  const kp = squatSkeleton({ depth: 0 });
  const side = detectSide({ t: 0, keypoints: kp });
  eq(side, 'right', 'side');
});

check('detectSide reads a wide shoulder spread as front on', () => {
  const kp = squatSkeleton({ depth: 0 });
  kp.leftShoulder = { ...kp.leftShoulder, x: 0.38 };
  kp.rightShoulder = { ...kp.rightShoulder, x: 0.62 };
  eq(detectSide({ t: 0, keypoints: kp }), 'front', 'side');
});

check('aspect correction changes the measured knee angle', () => {
  const frame = { t: 0, keypoints: squatSkeleton({ depth: 0.7 }) };
  const m = PATTERN_SPECS.squat.measures.find((x) => x.id === 'knee')!;
  const square = evalMeasure(m, frame, 'right', 1);
  const wide = evalMeasure(m, frame, 'right', 16 / 9);
  assert(
    Math.abs(square - wide) > 1,
    `expected aspect to matter, got ${square.toFixed(1)} vs ${wide.toFixed(1)}`
  );
});

// ── spec validation ─────────────────────────────────────────────────────────
section('spec validation');

check('every built-in pattern spec is valid', () => {
  for (const [pattern, spec] of Object.entries(PATTERN_SPECS)) {
    const res = parseFormRuleSpec(spec);
    if (!res.ok) throw new Error(`${pattern}: ${res.errors.join('; ')}`);
  }
});

check('rejects a cue pointing at an unknown measure', () => {
  const bad = {
    ...PATTERN_SPECS.squat,
    cues: [{ ...PATTERN_SPECS.squat.cues[0], measure: 'nope' }],
  };
  const res = parseFormRuleSpec(bad);
  assert(!res.ok, 'should have been rejected');
});

check('rejects thresholds ordered against the stated direction', () => {
  const bad = {
    ...PATTERN_SPECS.squat,
    rep: { ...PATTERN_SPECS.squat.rep, top: 120, bottom: 160 },
  };
  const res = parseFormRuleSpec(bad);
  assert(!res.ok, 'should have been rejected');
});

check('rejects an unknown joint name', () => {
  const bad = {
    ...PATTERN_SPECS.squat,
    measures: [{ kind: 'jointAngle', id: 'knee', at: ['hip', 'kneecap', 'ankle'] }],
  };
  assert(!parseFormRuleSpec(bad).ok, 'should have been rejected');
});

check('rejects a non-object', () => {
  assert(!parseFormRuleSpec(null).ok, 'null');
  assert(!parseFormRuleSpec('squat').ok, 'string');
});

// ── rep counting ────────────────────────────────────────────────────────────
section('rep counting');

const SQUAT = PATTERN_SPECS.squat;

function runSquat(frames: ReturnType<typeof squatSequence>, spec: FormRuleSpec = SQUAT) {
  const engine = new FormEngine(spec, { aspect: 1 });
  for (const f of frames) engine.push(f);
  return { engine, analysis: engine.finish() };
}

check('counts 5 clean deep squats', () => {
  const { analysis } = runSquat(squatSequence({ reps: 5, peak: 1 }));
  eq(analysis.reps.length, 5, 'reps');
});

check('counts 8 reps', () => {
  const { analysis } = runSquat(squatSequence({ reps: 8, peak: 1 }));
  eq(analysis.reps.length, 8, 'reps');
});

check('survives realistic keypoint jitter', () => {
  const { analysis } = runSquat(squatSequence({ reps: 5, peak: 1, jitter: 0.005, seed: 7 }));
  eq(analysis.reps.length, 5, 'reps');
});

check('does not count a tiny bounce as a rep', () => {
  const { analysis } = runSquat(squatSequence({ reps: 5, peak: 0.15 }));
  eq(analysis.reps.length, 0, 'reps');
});

check('counts shallow but real reps', () => {
  const { analysis } = runSquat(squatSequence({ reps: 5, peak: 0.55 }));
  eq(analysis.reps.length, 5, 'reps');
});

check('reports plausible tempo', () => {
  // 60 frames per rep at 30 fps is a 2 second rep, so roughly 1s down and 1s up.
  const { analysis } = runSquat(squatSequence({ reps: 4, peak: 1, framesPerRep: 60, fps: 30 }));
  const r = analysis.reps[1];
  near(r.tempoDownMs, 1000, 350, 'tempoDown');
  near(r.tempoUpMs, 1000, 350, 'tempoUp');
});

check('ignores frames where the tracked joints vanish', () => {
  const frames = squatSequence({ reps: 5, peak: 1 });
  // Blank the knees through what would be rep 3.
  occlude(frames, 'leftKnee', 150, 210);
  occlude(frames, 'rightKnee', 150, 210);
  const { analysis } = runSquat(frames);
  assert(
    analysis.reps.length >= 3 && analysis.reps.length <= 5,
    `expected 3..5 reps with an occlusion, got ${analysis.reps.length}`
  );
  assert(analysis.framesLowConf === 0, 'core confidence should still be fine');
});

// ── cues ────────────────────────────────────────────────────────────────────
section('cues');

check('deep squats do not trip the shallow cue', () => {
  const { analysis } = runSquat(squatSequence({ reps: 5, peak: 1 }));
  const shallow = analysis.reps.filter((r) => r.flags.includes('shallow'));
  eq(shallow.length, 0, 'shallow reps');
});

check('shallow squats trip the shallow cue on every rep', () => {
  const { analysis } = runSquat(squatSequence({ reps: 5, peak: 0.55 }));
  eq(analysis.reps.length, 5, 'reps');
  const shallow = analysis.reps.filter((r) => r.flags.includes('shallow'));
  eq(shallow.length, 5, 'shallow reps');
});

check('excess forward lean trips chestDrop', () => {
  const { analysis } = runSquat(squatSequence({ reps: 4, peak: 1, extraLean: 30 }));
  assert(analysis.reps.length > 0, 'no reps counted');
  const bad = analysis.reps.filter((r) => r.flags.includes('chestDrop'));
  assert(bad.length >= analysis.reps.length - 1, `expected chestDrop on most reps, got ${bad.length}`);
});

check('an upright deep squat trips nothing', () => {
  const { analysis } = runSquat(squatSequence({ reps: 5, peak: 1 }));
  const flagged = analysis.reps.flatMap((r) => r.flags);
  eq(flagged.length, 0, `unexpected flags: ${flagged.join(',')}`);
});

check('live state exposes reps and depth while the set runs', () => {
  const engine = new FormEngine(SQUAT, { aspect: 1 });
  const frames = squatSequence({ reps: 3, peak: 1 });
  let maxDepth = 0;
  let sawDescending = false;
  for (const f of frames) {
    const s = engine.push(f);
    maxDepth = Math.max(maxDepth, s.depth);
    if (s.phase === 'descending') sawDescending = true;
  }
  assert(sawDescending, 'never entered the descending phase');
  near(maxDepth, 1, 0.01, 'max depth');
  eq(engine.repCount, 3, 'reps');
});

check('a front-on view is refused rather than judged', () => {
  const frames = squatSequence({ reps: 5, peak: 1 });
  for (const f of frames) {
    f.keypoints.leftShoulder = { ...f.keypoints.leftShoulder, x: 0.38 };
    f.keypoints.rightShoulder = { ...f.keypoints.rightShoulder, x: 0.62 };
  }
  const { analysis } = runSquat(frames);
  assert(analysis.wrongView, 'should have flagged the wrong view');
  eq(analysis.reps.length, 0, 'reps');
});

// ── other patterns ──────────────────────────────────────────────────────────
section('press pattern');

check('counts 6 full-range presses', () => {
  const engine = new FormEngine(PATTERN_SPECS.horizontal_press, { aspect: 1 });
  for (const f of pressSequence({ reps: 6, peak: 1 })) engine.push(f);
  eq(engine.finish().reps.length, 6, 'reps');
});

check('a sagging push-up body is not silently accepted', () => {
  const engine = new FormEngine(PATTERN_SPECS.horizontal_press, { aspect: 1 });
  for (const f of pressSequence({ reps: 5, peak: 1, hipAngleDeg: 145 })) engine.push(f);
  const analysis = engine.finish();
  assert(analysis.reps.length > 0, 'no reps counted');
});

// ── pattern guessing ────────────────────────────────────────────────────────
section('pattern guessing');

const GUESSES: Array<[string, string | null]> = [
  ['Barbell Back Squat', 'squat'],
  ['Goblet Squat', 'squat'],
  ['Romanian Deadlift', 'hinge'],
  ['Conventional Deadlift', 'hinge'],
  ['Good Morning', 'hinge'],
  ['Bulgarian Split Squat', 'lunge'],
  ['Walking Lunge', 'lunge'],
  ['Barbell Bench Press', 'horizontal_press'],
  ['Push-up', 'horizontal_press'],
  ['Overhead Press', 'vertical_press'],
  ['Seated Dumbbell Shoulder Press', 'vertical_press'],
  ['Pull-up', 'vertical_pull'],
  ['Lat Pulldown', 'vertical_pull'],
  ['Barbell Row', 'horizontal_pull'],
  ['Bicep Curl', 'elbow_flexion'],
  ['Tricep Pushdown', 'elbow_extension'],
  ['Treadmill Run', 'none'],
  ['Standing Calf Raise', 'none'],
  ['Plank', 'none'],
  ['Cable Lateral Raise', 'none'],
  // Machine leg work must not be mistaken for arm work just because the names
  // contain "curl" and "extension".
  ['Leg Curl', 'none'],
  ['Lying Leg Curl', 'none'],
  ['Leg Extension', 'none'],
  // ...while the arm movements still resolve.
  ['Preacher Curl', 'elbow_flexion'],
  ['Hammer Curl', 'elbow_flexion'],
  ['Skull Crusher', 'elbow_extension'],
  // Back extension is a hinge, not an elbow movement.
  ['Back Extension', 'hinge'],
  ['Front Squat', 'squat'],
  ['Overhead Squat', 'squat'],
];

check('name guessing maps the catalog correctly', () => {
  const wrong: string[] = [];
  for (const [name, expected] of GUESSES) {
    const got = guessPattern(name);
    if (got !== expected) wrong.push(`${name}: expected ${expected}, got ${got}`);
  }
  assert(wrong.length === 0, wrong.join('; '));
});

check('RDL is a hinge, not a squat', () => {
  eq(guessPattern('Romanian Deadlift'), 'hinge', 'rdl');
  eq(guessPattern('Stiff Leg Deadlift'), 'hinge', 'sldl');
});

check('unknown names return null so we can ask the model', () => {
  eq(guessPattern('Turkish Getup'), null, 'unknown');
  eq(guessPattern('Zercher Zombie Thing'), null, 'nonsense');
  eq(guessPattern(''), null, 'empty');
});

check("specForPattern returns null for 'none' and junk", () => {
  eq(specForPattern('none'), null, 'none');
  eq(specForPattern('nonsense'), null, 'junk');
  eq(specForPattern(null), null, 'null');
  assert(specForPattern('squat') !== null, 'squat should have a spec');
});

// ── model plumbing ──────────────────────────────────────────────────────────
section('model plumbing');

check('derives 256x256 uint8 from a quantised Thunder input', () => {
  const r = deriveInputSpec({ name: 'input', dataType: 'uint8', shape: [1, 256, 256, 3] });
  assert(r.ok, 'should be ok');
  if (r.ok) {
    eq(r.spec.width, 256, 'width');
    eq(r.spec.height, 256, 'height');
    eq(r.spec.dataType, 'uint8', 'dataType');
  }
});

check('derives 192x192 float32 from a float Lightning input', () => {
  const r = deriveInputSpec({ name: 'input', dataType: 'float32', shape: [1, 192, 192, 3] });
  assert(r.ok, 'should be ok');
  if (r.ok) eq(r.spec.width, 192, 'width');
});

check('float16 input maps to a float32 resizer', () => {
  const r = deriveInputSpec({ name: 'input', dataType: 'float16', shape: [1, 256, 256, 3] });
  assert(r.ok && r.spec.dataType === 'float32', 'float16 should resize as float32');
});

check('rejects a model with the wrong input rank', () => {
  assert(!deriveInputSpec({ name: 'i', dataType: 'uint8', shape: [1, 256, 256] }).ok, 'rank 3');
  assert(!deriveInputSpec({ name: 'i', dataType: 'uint8', shape: [1, 256, 256, 4] }).ok, '4 channels');
  assert(!deriveInputSpec(undefined).ok, 'missing');
});

check('rejects an unsupported input dataType', () => {
  assert(!deriveInputSpec({ name: 'i', dataType: 'int64', shape: [1, 256, 256, 3] }).ok, 'int64');
});

check('accepts a single-person output and rejects multi-person', () => {
  assert(checkOutputShape({ name: 'o', dataType: 'float32', shape: [1, 1, 17, 3] }).ok, 'single');
  // Multi-person MoveNet emits [1, 6, 56]; grading that as one lifter would be
  // silently wrong, so it must be refused at load.
  assert(!checkOutputShape({ name: 'o', dataType: 'float32', shape: [1, 6, 56] }).ok, 'multi');
  assert(!checkOutputShape(undefined).ok, 'missing');
});

check('decodes a MoveNet buffer into keypoints, y first', () => {
  const raw = new Float32Array(MOVENET_OUTPUT_LENGTH);
  // Keypoint 0 is the nose: y = 0.25, x = 0.75, score = 0.9.
  raw[0] = 0.25;
  raw[1] = 0.75;
  raw[2] = 0.9;
  const frame = decodeMoveNet(raw, 1234);
  near(frame.keypoints.nose.y, 0.25, 1e-6, 'nose y');
  near(frame.keypoints.nose.x, 0.75, 1e-6, 'nose x');
  near(frame.keypoints.nose.score, 0.9, 1e-6, 'nose score');
  eq(frame.t, 1234, 't');
});

check('mirrors x for the front camera', () => {
  const raw = new Float32Array(MOVENET_OUTPUT_LENGTH);
  raw[1] = 0.75;
  const frame = decodeMoveNet(raw, 0, true);
  near(frame.keypoints.nose.x, 0.25, 1e-6, 'mirrored nose x');
});

check('viewOutput picks the right typed array', () => {
  assert(viewOutput(new ArrayBuffer(8), 'float32') instanceof Float32Array, 'float32');
  assert(viewOutput(new ArrayBuffer(8), 'uint8') instanceof Uint8Array, 'uint8');
  eq(viewOutput(new ArrayBuffer(8), 'int64'), null, 'unsupported');
});

check('aspectOf reports the source ratio', () => {
  near(aspectOf(1920, 1080), 16 / 9, 1e-6, 'landscape');
  eq(aspectOf(0, 1080), 1, 'unknown dimensions fall back to no correction');
});

// ── rule resolution ladder ──────────────────────────────────────────────────
// Async, so the report has to wait for it.
async function main() {
  section('rule resolution');
  await runResolveTests({ check, eq, assert });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

void main();
