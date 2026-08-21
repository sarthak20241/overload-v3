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
import { decodeMoveNet, letterboxFor } from '../../lib/form/keypoints';
import {
  MOVENET_OUTPUT_LENGTH,
  aspectOf,
  checkOutputShape,
  deriveInputSpec,
  viewOutput,
} from '../../lib/form/model';
import { Ema, angleAt, detectSide, resolveJoint } from '../../lib/form/geometry';
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

check('rejects a spec with no cues at all', () => {
  // Such a spec can never find a fault, so every set scores a flawless 100 and
  // the model is handed that number with nothing to say about it. Cached to a
  // row it would mean perfect scores forever from rules that detect nothing.
  const bad = { ...PATTERN_SPECS.squat, cues: [] };
  assert(!parseFormRuleSpec(bad).ok, 'should have been rejected');
});

check('rejects rep thresholds the driver can never reach', () => {
  // A jointAngle is 0..180 by construction. Thresholds outside it mean isUp is
  // never true: zero reps for the life of the exercise, and a depth bar pinned
  // at half, with nothing anywhere reporting a problem.
  const bad = {
    ...PATTERN_SPECS.squat,
    rep: { ...PATTERN_SPECS.squat.rep, top: 1e9, bottom: -1e9 },
  };
  assert(!parseFormRuleSpec(bad).ok, 'out of range for a jointAngle driver');
  assert(parseFormRuleSpec(PATTERN_SPECS.squat).ok, 'the real spec still passes');
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

check('an abandoned dip does not contaminate the next rep', () => {
  // A re-grip or a false start: down partway, back up, a long pause, then the
  // real set. Without a descending -> top transition the machine stays parked
  // in `descending`, and the dip plus every second of standing still is folded
  // into the first real rep -- an eight second eccentric reported for a rep
  // that took under one, and mean-sampled cues diluted below their thresholds.
  const frames: ReturnType<typeof squatSequence> = [];
  let t = 0;
  const dt = 1000 / 30;
  const push = (d: number) => {
    frames.push({ t, keypoints: squatSkeleton({ depth: d }) });
    t += dt;
  };
  for (let i = 0; i < 15; i++) push(0);
  for (let f = 0; f < 30; f++) push((0.35 * (1 - Math.cos((f / 30) * 2 * Math.PI))) / 2);
  for (let i = 0; i < 180; i++) push(0);
  for (let r = 0; r < 3; r++) {
    for (let f = 0; f < 60; f++) push((1 - Math.cos((f / 60) * 2 * Math.PI)) / 2);
  }
  for (let i = 0; i < 15; i++) push(0);

  const { analysis } = runSquat(frames);
  eq(analysis.reps.length, 3, 'reps');
  for (const r of analysis.reps) {
    near(r.tempoDownMs, 733, 200, `rep ${r.n} tempoDown`);
    near(r.tempoUpMs, 767, 200, `rep ${r.n} tempoUp`);
  }
  // Identical reps must aggregate identically; the standing frames must not
  // have been averaged into the first one.
  const means = analysis.reps.map((r) => r.measures.torsoLean?.mean ?? NaN);
  near(means[0], means[1], 0.5, 'rep 1 vs rep 2 torsoLean mean');
});

check('a joint that stays missing stops feeding the aggregates', () => {
  // The EMA holds its last value through a NaN so a blink does not break a rep.
  // Past a few frames that value is a memory, not a measurement: without a
  // staleness cut-off an ankle lost for a whole rep is folded into min, max,
  // mean and range as though the lifter were holding perfectly still. Nothing
  // else catches it -- meanKeypointScore samples shoulders, hips, knees and
  // elbows, so a lost ankle never raises lowConfidence.
  const ema = new Ema(0.35);
  eq(Number.isNaN(ema.push(NaN)), true, 'no value yet');
  ema.push(100);
  eq(ema.stale, 0, 'fresh after a real sample');
  ema.push(NaN);
  ema.push(NaN);
  eq(ema.stale, 2, 'counts frames since the last real sample');
  near(ema.current, 100, 1e-9, 'still reports the held value');
  ema.push(100);
  eq(ema.stale, 0, 'resets when a real sample returns');
});

check('rep confidence describes the rep, not the whole session', () => {
  // Confidence drops partway through the set. A rep that happened entirely in
  // the bad stretch must not inherit the good stretch's average.
  const frames = squatSequence({ reps: 4, peak: 1, framesPerRep: 60, fps: 30 });
  frames.forEach((f, i) => {
    const score = i < frames.length / 2 ? 0.95 : 0.45;
    for (const k of Object.keys(f.keypoints) as (keyof typeof f.keypoints)[]) {
      f.keypoints[k] = { ...f.keypoints[k], score };
    }
  });
  const { analysis } = runSquat(frames);
  const first = analysis.reps[0].confidence;
  const last = analysis.reps[analysis.reps.length - 1].confidence;
  near(first, 0.95, 0.02, 'first rep ran while tracking was good');
  near(last, 0.45, 0.02, 'last rep ran while tracking was poor');
});

check('an unestablished side is not graded as a good view', () => {
  // Hips below the confidence floor on most frames: detectSide cannot commit.
  // The set must read as unclear rather than being silently graded with the
  // joint lookup flip-flopping between the near and far leg each frame.
  const frames = squatSequence({ reps: 3, peak: 1 });
  for (const f of frames) {
    f.keypoints.leftHip = { ...f.keypoints.leftHip, score: 0.05 };
    f.keypoints.rightHip = { ...f.keypoints.rightHip, score: 0.05 };
    f.keypoints.leftShoulder = { ...f.keypoints.leftShoulder, score: 0.05 };
    f.keypoints.rightShoulder = { ...f.keypoints.rightShoulder, score: 0.05 };
  }
  const { analysis } = runSquat(frames);
  eq(analysis.side, 'unknown', 'side should stay unknown');
  assert(analysis.framesLowConf > 0, 'an unknown side must count as unclear');
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
  // Catalogs name cardio in the -ing form, so the stems have to match it.
  // Without this these fall all the way through the ladder and pay the model
  // to author form rules for running.
  ['Running', 'none'],
  ['Jogging', 'none'],
  ['Cycling', 'none'],
  ['Stairmaster', 'none'],
  ['Rowing Erg', 'none'],
  // ...but stemming must not swallow the lifts that share those prefixes.
  ['Walking Lunge', 'lunge'],
  ['Seated Cable Row', 'horizontal_pull'],
  ['Pendlay Row', 'horizontal_pull'],
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

check('letterbox padding is computed from the frame, not the screen', () => {
  // A 16:9 frame contained into a square keeps its full width and is centred
  // vertically: 1080 * 256/1920 = 144 rows of 256, so 0.5625 of the square.
  const land = letterboxFor(1920, 1080);
  near(land.spanY, 0.5625, 1e-9, 'landscape spanY');
  near(land.padY, 0.21875, 1e-9, 'landscape padY');
  eq(land.spanX, 1, 'landscape spanX');
  const port = letterboxFor(1080, 1920);
  near(port.spanX, 0.5625, 1e-9, 'portrait spanX');
  near(port.padY, 0, 1e-9, 'portrait padY');
  eq(letterboxFor(512, 512).spanX, 1, 'square needs no padding');
  // A frame with no dimensions must not produce Infinity coordinates.
  eq(letterboxFor(0, 0).spanX, 1, 'degenerate falls back to none');
});

check('decoding undoes the letterbox so coordinates describe the frame', () => {
  const box = letterboxFor(1920, 1080);
  const raw = new Float32Array(MOVENET_OUTPUT_LENGTH);
  // Centre of the square is the centre of the image.
  raw[0] = 0.5;
  raw[1] = 0.5;
  // The image's top edge sits just below the top bar.
  raw[3] = box.padY;
  raw[4] = 0;
  const frame = decodeMoveNet(raw, 0, false, box);
  near(frame.keypoints.nose.y, 0.5, 1e-9, 'centre y');
  near(frame.keypoints.nose.x, 0.5, 1e-9, 'centre x');
  near(frame.keypoints.leftEye.y, 0, 1e-9, 'top edge maps to 0');
});

check('the frame aspect, not the screen aspect, decides the angles', () => {
  // A phone screen is about 0.46 wide-to-tall while the sensor is 16:9. Feeding
  // the screen's ratio bends every angle by tens of degrees, which is the
  // difference between counting a rep and telling the lifter there was none.
  const pose = { t: 0, keypoints: squatSkeleton({ depth: 0.7 }) };
  const angle = (aspect: number) => {
    const hip = resolveJoint(pose, 'hip', 'right', aspect)!;
    const knee = resolveJoint(pose, 'knee', 'right', aspect)!;
    const ankle = resolveJoint(pose, 'ankle', 'right', aspect)!;
    return angleAt(hip, knee, ankle);
  };
  const withFrame = angle(1920 / 1080);
  const withScreen = angle(1179 / 2556);
  assert(Math.abs(withFrame - withScreen) > 20, 'the two must not be interchangeable');
});

check('mirrors x for the front camera', () => {
  const raw = new Float32Array(MOVENET_OUTPUT_LENGTH);
  raw[1] = 0.75;
  const frame = decodeMoveNet(raw, 0, true);
  near(frame.keypoints.nose.x, 0.25, 1e-6, 'mirrored nose x');
});

check('viewOutput reads float output and refuses quantised output', () => {
  assert(viewOutput(new ArrayBuffer(8), 'float32') instanceof Float32Array, 'float32');
  // Quantised buffers are raw integers needing the tensor's scale and zero
  // point, which nothing applies. Read as-is, a score arrives as 0..255 and
  // every joint looks confident, so these must not be viewed at all.
  eq(viewOutput(new ArrayBuffer(8), 'uint8'), null, 'uint8');
  eq(viewOutput(new ArrayBuffer(8), 'int8'), null, 'int8');
  eq(viewOutput(new ArrayBuffer(8), 'int64'), null, 'unsupported');
});

check('a quantised output model is refused at load', () => {
  const shape = [1, 1, 17, 3];
  assert(checkOutputShape({ name: 'o', dataType: 'float32', shape }).ok, 'float32 is fine');
  assert(!checkOutputShape({ name: 'o', dataType: 'uint8', shape }).ok, 'uint8 refused');
  assert(!checkOutputShape({ name: 'o', dataType: 'int8', shape }).ok, 'int8 refused');
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
