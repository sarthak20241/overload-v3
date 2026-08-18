/**
 * Movement-pattern rule templates.
 *
 * This file is how form checking covers a catalog nobody hand-authored. Every
 * exercise gets tagged with a movement pattern (a squat is a squat whether it
 * is a back squat, a goblet squat or something Drona invented mid-workout), and
 * every pattern owns a default FormRuleSpec. A brand-new exercise is therefore
 * checkable the moment it exists, without shipping an app build.
 *
 * Specific exercises can still override the template with a curated spec on
 * `exercises.form_rules`; see ./resolve.ts for the full ladder.
 *
 * THRESHOLD PHILOSOPHY, worth reading before tuning any number:
 * rep thresholds are deliberately GENEROUS and cue thresholds are STRICT. A
 * partial squat should still count as a rep and then get told it was shallow.
 * If the rep threshold itself demanded depth, a shallow set would show zero
 * reps and no feedback, which reads as the feature being broken.
 */

import type { FormRuleSpec } from './spec';

/**
 * The pattern vocabulary. Stored in `exercises.movement_pattern`, so these
 * strings are a database contract: add freely, never rename.
 *
 * 'none' is explicit and load-bearing: it means "we know this exercise and we
 * know we cannot judge it from a phone camera" (machine isolation, cardio,
 * static holds). Saying so honestly beats inventing feedback.
 */
export const MOVEMENT_PATTERNS = [
  'squat',
  'hinge',
  'lunge',
  'horizontal_press',
  'vertical_press',
  'horizontal_pull',
  'vertical_pull',
  'elbow_flexion',
  'elbow_extension',
  'none',
] as const;

export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

export function isMovementPattern(v: unknown): v is MovementPattern {
  return typeof v === 'string' && (MOVEMENT_PATTERNS as readonly string[]).includes(v);
}

/**
 * Shared measure fragments. Written once so a threshold tuned for one pattern
 * is not silently different in another.
 */
const M = {
  knee: { kind: 'jointAngle', id: 'knee', at: ['hip', 'knee', 'ankle'] },
  hip: { kind: 'jointAngle', id: 'hip', at: ['shoulder', 'hip', 'knee'] },
  elbow: { kind: 'jointAngle', id: 'elbow', at: ['shoulder', 'elbow', 'wrist'] },
  shoulderFlex: { kind: 'jointAngle', id: 'shoulderFlex', at: ['hip', 'shoulder', 'elbow'] },
  /** Torso tilt away from upright. 0 = standing tall. */
  torsoLean: { kind: 'segmentVertical', id: 'torsoLean', from: 'hip', to: 'shoulder' },
  /** Forearm tilt away from vertical, for pressing wrist stacking. */
  forearmLean: { kind: 'segmentVertical', id: 'forearmLean', from: 'elbow', to: 'wrist' },
  /**
   * Hip height relative to the knee, in torso lengths. POSITIVE means the hip
   * sits LOWER than the knee, i.e. below parallel. This is the depth measure.
   */
  hipBelowKnee: { kind: 'verticalGap', id: 'hipBelowKnee', from: 'knee', to: 'hip' },
  /** How far the hands drift in front of the feet, in torso lengths. */
  handOverFoot: { kind: 'horizontalGap', id: 'handOverFoot', from: 'ankle', to: 'wrist' },
} as const satisfies Record<string, FormRuleSpec['measures'][number]>;

const SIDE_SETUP =
  'Prop the phone at hip height and step back so I can see all of you from the side.';

/**
 * The templates. Each is a complete, valid FormRuleSpec.
 *
 * Cue copy follows the house rule: coach voice, second person, no data-diff
 * phrasing, no em dashes. `live` is what flashes on screen mid-set, so it stays
 * short enough to read at arm's length.
 */
export const PATTERN_SPECS: Record<Exclude<MovementPattern, 'none'>, FormRuleSpec> = {
  squat: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.knee, M.hip, M.torsoLean, M.hipBelowKnee],
    // Knee angle closes on the way down, so downIncreases is false.
    rep: { driver: 'knee', downIncreases: false, top: 160, bottom: 120, minRepMs: 700, maxRepMs: 20000 },
    cues: [
      {
        id: 'shallow',
        measure: 'hipBelowKnee',
        sample: 'bottom',
        // Hip still a twentieth of a torso above the knee at the deepest point.
        test: { op: '<', a: -0.05 },
        severity: 'warn',
        live: 'Sit deeper',
        detail: 'You stopped above parallel. Aim to get the hip crease level with the knee.',
      },
      {
        id: 'chestDrop',
        measure: 'torsoLean',
        sample: 'max',
        test: { op: '>', a: 55 },
        severity: 'warn',
        live: 'Chest up',
        detail: 'Your chest folded forward at the bottom. Brace and keep the torso taller.',
      },
      {
        id: 'noLockout',
        measure: 'knee',
        sample: 'top',
        test: { op: '<', a: 155 },
        severity: 'warn',
        live: 'Stand tall',
        detail: 'You cut the top short. Finish each rep standing fully upright.',
      },
    ],
  },

  hinge: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.hip, M.knee, M.torsoLean, M.handOverFoot],
    rep: { driver: 'hip', downIncreases: false, top: 160, bottom: 115, minRepMs: 800, maxRepMs: 25000 },
    cues: [
      {
        id: 'barDrift',
        measure: 'handOverFoot',
        sample: 'max',
        test: { op: '>', a: 0.35 },
        severity: 'bad',
        live: 'Bar close',
        detail: 'The bar drifted away from your shins. Keep it dragging up your legs.',
      },
      {
        id: 'noLockout',
        measure: 'hip',
        sample: 'top',
        test: { op: '<', a: 160 },
        severity: 'warn',
        live: 'Finish tall',
        detail: 'You stopped short of a full lockout. Stand all the way up and squeeze the glutes.',
      },
      {
        id: 'squatting',
        measure: 'knee',
        sample: 'bottom',
        test: { op: '<', a: 100 },
        severity: 'warn',
        live: 'Push hips back',
        detail: 'That turned into a squat. Send the hips back and keep more angle in the knee.',
      },
    ],
  },

  lunge: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.knee, M.torsoLean, M.hipBelowKnee],
    rep: { driver: 'knee', downIncreases: false, top: 155, bottom: 120, minRepMs: 700, maxRepMs: 20000 },
    cues: [
      {
        id: 'shallow',
        measure: 'knee',
        sample: 'bottom',
        test: { op: '>', a: 105 },
        severity: 'warn',
        live: 'Sit deeper',
        detail: 'The front knee stayed open. Drop until that thigh is roughly parallel to the floor.',
      },
      {
        id: 'chestDrop',
        measure: 'torsoLean',
        sample: 'max',
        test: { op: '>', a: 40 },
        severity: 'warn',
        live: 'Chest up',
        detail: 'You leaned over the front leg. Keep the torso stacked over the hips.',
      },
    ],
  },

  horizontal_press: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.elbow, M.forearmLean, M.hip],
    rep: { driver: 'elbow', downIncreases: false, top: 155, bottom: 115, minRepMs: 600, maxRepMs: 20000 },
    cues: [
      {
        id: 'shortRange',
        measure: 'elbow',
        sample: 'bottom',
        test: { op: '>', a: 100 },
        severity: 'warn',
        live: 'Full range',
        detail: 'You stopped the descent early. Bring it down until the elbow closes past ninety degrees.',
      },
      {
        id: 'noLockout',
        measure: 'elbow',
        sample: 'top',
        test: { op: '<', a: 150 },
        severity: 'warn',
        live: 'Lock it out',
        detail: 'The arms did not straighten at the top. Press all the way through.',
      },
      {
        id: 'wristStack',
        measure: 'forearmLean',
        sample: 'bottom',
        test: { op: '>', a: 28 },
        severity: 'warn',
        live: 'Stack wrists',
        detail: 'Your forearm was angled at the bottom. Keep the wrist stacked over the elbow.',
      },
    ],
  },

  vertical_press: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.elbow, M.torsoLean, M.shoulderFlex],
    rep: { driver: 'elbow', downIncreases: false, top: 160, bottom: 115, minRepMs: 600, maxRepMs: 20000 },
    cues: [
      {
        id: 'noLockout',
        measure: 'elbow',
        sample: 'top',
        test: { op: '<', a: 155 },
        severity: 'warn',
        live: 'Lock it out',
        detail: 'You stopped under a full lockout. Finish with the arms straight and the head through.',
      },
      {
        id: 'leanBack',
        measure: 'torsoLean',
        sample: 'max',
        test: { op: '>', a: 22 },
        severity: 'bad',
        live: 'Ribs down',
        detail: 'You leaned back to get it up. Squeeze the glutes and keep the ribs down.',
      },
    ],
  },

  horizontal_pull: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.elbow, M.torsoLean],
    rep: { driver: 'elbow', downIncreases: false, top: 155, bottom: 110, minRepMs: 600, maxRepMs: 20000 },
    cues: [
      {
        id: 'shortRange',
        measure: 'elbow',
        sample: 'bottom',
        test: { op: '>', a: 95 },
        severity: 'warn',
        live: 'Pull further',
        detail: 'The pull stopped short. Bring the elbow past your ribs before you reset.',
      },
      {
        id: 'bodyEnglish',
        measure: 'torsoLean',
        sample: 'range',
        test: { op: '>', a: 18 },
        severity: 'warn',
        live: 'Still torso',
        detail: 'Your torso swung with each rep. Lock the hips and let the arms do the work.',
      },
    ],
  },

  vertical_pull: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.elbow, M.shoulderFlex, M.torsoLean],
    rep: { driver: 'elbow', downIncreases: false, top: 160, bottom: 100, minRepMs: 600, maxRepMs: 20000 },
    cues: [
      {
        id: 'shortRange',
        measure: 'elbow',
        sample: 'bottom',
        test: { op: '>', a: 85 },
        severity: 'warn',
        live: 'Pull higher',
        detail: 'You stopped before the top. Pull until the elbows are fully driven down.',
      },
      {
        id: 'noStretch',
        measure: 'elbow',
        sample: 'top',
        test: { op: '<', a: 150 },
        severity: 'warn',
        live: 'Full hang',
        detail: 'You cut the bottom short. Let the arms straighten between reps.',
      },
    ],
  },

  elbow_flexion: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.elbow, M.torsoLean, M.shoulderFlex],
    rep: { driver: 'elbow', downIncreases: false, top: 155, bottom: 90, minRepMs: 500, maxRepMs: 15000 },
    cues: [
      {
        id: 'bodyEnglish',
        measure: 'torsoLean',
        sample: 'range',
        test: { op: '>', a: 15 },
        severity: 'warn',
        live: 'Still torso',
        detail: 'You swung the weight up. Pin the elbows and keep the torso quiet.',
      },
      {
        id: 'shortRange',
        measure: 'elbow',
        sample: 'top',
        test: { op: '<', a: 145 },
        severity: 'warn',
        live: 'Full stretch',
        detail: 'You stopped halfway down. Let the arm straighten at the bottom of every rep.',
      },
    ],
  },

  elbow_extension: {
    version: 1,
    view: 'side',
    setup: SIDE_SETUP,
    measures: [M.elbow, M.shoulderFlex],
    rep: { driver: 'elbow', downIncreases: false, top: 155, bottom: 100, minRepMs: 500, maxRepMs: 15000 },
    cues: [
      {
        id: 'noLockout',
        measure: 'elbow',
        sample: 'top',
        test: { op: '<', a: 150 },
        severity: 'warn',
        live: 'Lock it out',
        detail: 'You stopped before the arm was straight. Finish each rep at full extension.',
      },
      {
        id: 'elbowDrift',
        measure: 'shoulderFlex',
        sample: 'range',
        test: { op: '>', a: 25 },
        severity: 'warn',
        live: 'Pin elbows',
        detail: 'Your upper arm moved through the rep. Keep the elbow fixed and hinge only at the joint.',
      },
    ],
  },
};

/** Template for a pattern, or null for 'none' and anything unrecognised. */
export function specForPattern(pattern: string | null | undefined): FormRuleSpec | null {
  // The type guard has to come before the 'none' comparison so the compiler
  // can narrow 'none' out of the key type on the next line.
  if (!pattern || !isMovementPattern(pattern) || pattern === 'none') return null;
  return PATTERN_SPECS[pattern] ?? null;
}

/**
 * Best-effort pattern guess from an exercise name.
 *
 * This is the CHEAP tier of the resolution ladder: it costs nothing and gets
 * the overwhelming majority of a barbell-and-dumbbell catalog right, so the
 * model only gets asked about genuinely novel movements. Order matters, since
 * the first match wins and some names contain two cues ("Romanian deadlift"
 * must hit hinge before the generic squat check ever sees it).
 */
const NAME_RULES: ReadonlyArray<readonly [RegExp, MovementPattern]> = [
  // Anything machine-seated and isolated that a side camera cannot judge.
  [/\b(treadmill|run|jog|cycl|bike|row erg|elliptical|stair|walk|sled|carry|plank|hold|stretch)\b/i, 'none'],
  [/\b(calf|shrug|fly|flye|lateral raise|front raise|rear delt|face pull|pullover|wrist|crunch|sit.?up|twist|raise)\b/i, 'none'],
  // Leg curl and leg extension must be caught HERE, before the generic
  // curl/extension rules below, or a hamstring machine ends up graded as a
  // biceps curl and a quad machine as a triceps pushdown.
  [/\b(leg curl|leg extension|hamstring curl|lying curl|seated curl machine)\b/i, 'none'],

  [/\b(romanian|rdl|stiff.?leg|good morning|hip thrust|hip hinge|back extension|deadlift)\b/i, 'hinge'],
  [/\b(lunge|split squat|step.?up|bulgarian)\b/i, 'lunge'],
  [/\b(squat|leg press|hack)\b/i, 'squat'],

  [/\b(pull.?up|chin.?up|lat pulldown|pulldown)\b/i, 'vertical_pull'],
  [/\b(row|seated row|t.?bar)\b/i, 'horizontal_pull'],

  [/\b(overhead press|shoulder press|military|push press|arnold)\b/i, 'vertical_press'],
  [/\b(bench|push.?up|chest press|dip)\b/i, 'horizontal_press'],

  [/\b(curl)\b/i, 'elbow_flexion'],
  [/\b(tricep|pushdown|press.?down|skull|extension|kickback)\b/i, 'elbow_extension'],
];

/**
 * Guess a movement pattern from a name. Returns null when nothing matches,
 * which is the signal to ask Drona rather than guess wrong.
 */
export function guessPattern(name: string): MovementPattern | null {
  const n = name.trim();
  if (!n) return null;
  for (const [re, pattern] of NAME_RULES) {
    if (re.test(n)) return pattern;
  }
  return null;
}
