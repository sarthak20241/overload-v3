/**
 * The form-rule SPEC: a declarative, serialisable description of how to judge
 * one exercise. This is the whole reason the feature can cover AI-generated and
 * global catalog exercises alike.
 *
 * Rules are DATA, not code. A spec is stored as jsonb on `exercises.form_rules`
 * (curated for the global catalog, model-authored for exercises Drona invents)
 * or inherited from a movement-pattern template. The engine in ./engine.ts is a
 * generic interpreter, so adding an exercise never means shipping an app build.
 *
 * Because specs arrive from the database and from a language model, NOTHING
 * here is trusted: parseFormRuleSpec validates every field and rejects the spec
 * rather than letting a malformed rule produce confident, wrong coaching.
 */

import { KEYPOINT_NAMES, SIDE_PAIRS, type JointRef } from './keypoints';

export const FORM_SPEC_VERSION = 1 as const;

/** Every joint name a spec may reference. */
export const VALID_JOINT_REFS: readonly string[] = [
  ...KEYPOINT_NAMES,
  ...Object.keys(SIDE_PAIRS),
  'midHip',
  'midShoulder',
];

/**
 * A measurement taken from each frame.
 *
 * Angle measures are in DEGREES. Gap measures are expressed as a RATIO of the
 * user's torso length (midShoulder to midHip), which makes thresholds
 * independent of how far the user stands from the phone. A hip that drops one
 * quarter of a torso below the knee reads 0.25 whether they filled the frame or
 * not.
 */
export type MeasureSpec =
  | { kind: 'jointAngle'; id: string; at: [JointRef, JointRef, JointRef] }
  | { kind: 'segmentVertical'; id: string; from: JointRef; to: JointRef }
  | { kind: 'segmentHorizontal'; id: string; from: JointRef; to: JointRef }
  | { kind: 'verticalGap'; id: string; from: JointRef; to: JointRef }
  | { kind: 'horizontalGap'; id: string; from: JointRef; to: JointRef };

export type MeasureKind = MeasureSpec['kind'];

/**
 * How reps are counted.
 *
 * One measure drives the phase machine. `downIncreases` says whether that
 * measure grows or shrinks on the way down: a squat's knee angle SHRINKS
 * descending (false), while a bench press's elbow-to-shoulder gap grows.
 * `top`/`bottom` are the hysteresis thresholds; the wide band between them is
 * what stops a shaking rep from counting twice.
 */
export interface RepSpec {
  driver: string;
  downIncreases: boolean;
  top: number;
  bottom: number;
  /** Reps faster than this are jitter, not reps. */
  minRepMs: number;
  /** Reps slower than this are a rack-and-rest, so the phase machine resets. */
  maxRepMs: number;
}

/** Which point of the rep a cue reads. */
export type CueSample = 'bottom' | 'top' | 'min' | 'max' | 'mean' | 'range';

export type CueTest =
  | { op: '<'; a: number }
  | { op: '>'; a: number }
  | { op: 'between'; a: number; b: number }
  | { op: 'outside'; a: number; b: number };

export type CueSeverity = 'warn' | 'bad';

/**
 * One thing that can go wrong. A cue FIRES when its test passes, i.e. tests
 * describe the FAULT, not the good rep. `live` is the badge shown mid-set and
 * must stay short enough to read at arm's length; `detail` is the sentence
 * Drona is given when writing the post-set note.
 */
export interface CueSpec {
  id: string;
  measure: string;
  sample: CueSample;
  test: CueTest;
  severity: CueSeverity;
  live: string;
  detail: string;
}

/**
 * A complete rule set for one exercise.
 *
 * `view` states which camera angle the rules assume; the engine refuses to
 * score a set filmed from the wrong side rather than inventing feedback.
 */
export interface FormRuleSpec {
  version: typeof FORM_SPEC_VERSION;
  view: 'side' | 'front' | 'any';
  /** Placement instruction in Drona's voice, shown before recording. */
  setup: string;
  measures: MeasureSpec[];
  rep: RepSpec;
  cues: CueSpec[];
}

export interface SpecParseOk {
  ok: true;
  spec: FormRuleSpec;
}
export interface SpecParseErr {
  ok: false;
  errors: string[];
}
export type SpecParseResult = SpecParseOk | SpecParseErr;

const MEASURE_KINDS: readonly MeasureKind[] = [
  'jointAngle',
  'segmentVertical',
  'segmentHorizontal',
  'verticalGap',
  'horizontalGap',
];
const CUE_SAMPLES: readonly CueSample[] = ['bottom', 'top', 'min', 'max', 'mean', 'range'];
const CUE_SEVERITIES: readonly CueSeverity[] = ['warn', 'bad'];

/** Caps that keep a hostile or hallucinated spec from bloating the engine. */
const LIMITS = {
  measures: 12,
  cues: 10,
  liveChars: 28,
  detailChars: 160,
  setupChars: 200,
} as const;

/**
 * What a measure of this kind can actually report.
 *
 * Angles are interior angles, so 0..180 by construction. Gaps and segment
 * angles are divided by torso length, which keeps them small; the bound is
 * deliberately loose because the point is to catch nonsense, not to second
 * guess a plausible threshold.
 */
function measureRange(kind: MeasureKind): [number, number] {
  switch (kind) {
    case 'jointAngle':
      return [0, 180];
    case 'segmentVertical':
    case 'segmentHorizontal':
      return [-180, 180];
    default:
      return [-20, 20];
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJointRef(v: unknown): v is JointRef {
  return typeof v === 'string' && VALID_JOINT_REFS.includes(v);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isSafeId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z][a-zA-Z0-9_]{0,31}$/.test(v);
}

/**
 * Validate an untrusted value into a FormRuleSpec.
 *
 * Every failure is collected rather than thrown on the first problem, so a
 * model that authors a bad spec can be handed the full list and retry once.
 */
export function parseFormRuleSpec(input: unknown): SpecParseResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['spec must be an object'] };

  if (input.version !== FORM_SPEC_VERSION) {
    errors.push(`version must be ${FORM_SPEC_VERSION}`);
  }
  if (input.view !== 'side' && input.view !== 'front' && input.view !== 'any') {
    errors.push("view must be 'side', 'front' or 'any'");
  }
  if (typeof input.setup !== 'string' || input.setup.length === 0) {
    errors.push('setup must be a non-empty string');
  } else if (input.setup.length > LIMITS.setupChars) {
    errors.push(`setup must be <= ${LIMITS.setupChars} chars`);
  }

  // ── measures ──────────────────────────────────────────────────────────────
  const measures: MeasureSpec[] = [];
  const measureIds = new Set<string>();
  if (!Array.isArray(input.measures) || input.measures.length === 0) {
    errors.push('measures must be a non-empty array');
  } else if (input.measures.length > LIMITS.measures) {
    errors.push(`at most ${LIMITS.measures} measures`);
  } else {
    input.measures.forEach((raw, i) => {
      const where = `measures[${i}]`;
      if (!isObj(raw)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!isSafeId(raw.id)) {
        errors.push(`${where}.id must be a short lowerCamel identifier`);
        return;
      }
      if (measureIds.has(raw.id)) {
        errors.push(`${where}.id "${raw.id}" is duplicated`);
        return;
      }
      if (typeof raw.kind !== 'string' || !MEASURE_KINDS.includes(raw.kind as MeasureKind)) {
        errors.push(`${where}.kind must be one of ${MEASURE_KINDS.join(', ')}`);
        return;
      }
      const kind = raw.kind as MeasureKind;

      if (kind === 'jointAngle') {
        const at = raw.at;
        if (!Array.isArray(at) || at.length !== 3 || !at.every(isJointRef)) {
          errors.push(`${where}.at must be 3 known joint names`);
          return;
        }
        measures.push({ kind, id: raw.id, at: at as [JointRef, JointRef, JointRef] });
      } else {
        if (!isJointRef(raw.from) || !isJointRef(raw.to)) {
          errors.push(`${where}.from/.to must be known joint names`);
          return;
        }
        measures.push({ kind, id: raw.id, from: raw.from, to: raw.to } as MeasureSpec);
      }
      measureIds.add(raw.id);
    });
  }

  // ── rep ───────────────────────────────────────────────────────────────────
  let rep: RepSpec | null = null;
  if (!isObj(input.rep)) {
    errors.push('rep must be an object');
  } else {
    const r = input.rep;
    const problems: string[] = [];
    if (typeof r.driver !== 'string' || !measureIds.has(r.driver)) {
      problems.push('rep.driver must name one of the measures');
    }
    if (typeof r.downIncreases !== 'boolean') problems.push('rep.downIncreases must be a boolean');
    if (!isFiniteNum(r.top)) problems.push('rep.top must be a number');
    if (!isFiniteNum(r.bottom)) problems.push('rep.bottom must be a number');
    if (!isFiniteNum(r.minRepMs) || r.minRepMs < 100) problems.push('rep.minRepMs must be >= 100');
    if (!isFiniteNum(r.maxRepMs) || r.maxRepMs > 60000) problems.push('rep.maxRepMs must be <= 60000');
    if (
      isFiniteNum(r.top) &&
      isFiniteNum(r.bottom) &&
      typeof r.downIncreases === 'boolean'
    ) {
      // Hysteresis only works if the two thresholds are ordered the way the
      // direction claims, and separated enough to survive jitter.
      const ordered = r.downIncreases ? r.bottom > r.top : r.bottom < r.top;
      if (!ordered) {
        problems.push('rep.top/rep.bottom are ordered inconsistently with rep.downIncreases');
      }
      if (Math.abs(r.top - r.bottom) < 5) {
        problems.push('rep.top and rep.bottom must differ by at least 5');
      }
      // Thresholds outside what the driver can ever report would silently mean
      // "no rep, ever": `isUp` never becomes true, the set ends with zero reps,
      // and the depth bar sits pinned at half for the life of the exercise.
      const driver = measures.find((m) => m.id === r.driver);
      if (driver) {
        const [lo, hi] = measureRange(driver.kind);
        for (const [label, v] of [['top', r.top], ['bottom', r.bottom]] as const) {
          if (v < lo || v > hi) {
            problems.push(`rep.${label} must be within ${lo}..${hi} for a ${driver.kind} driver`);
          }
        }
      }
    }
    if (isFiniteNum(r.minRepMs) && isFiniteNum(r.maxRepMs) && r.minRepMs >= r.maxRepMs) {
      problems.push('rep.minRepMs must be < rep.maxRepMs');
    }
    if (problems.length) errors.push(...problems);
    else
      rep = {
        driver: r.driver as string,
        downIncreases: r.downIncreases as boolean,
        top: r.top as number,
        bottom: r.bottom as number,
        minRepMs: r.minRepMs as number,
        maxRepMs: r.maxRepMs as number,
      };
  }

  // ── cues ──────────────────────────────────────────────────────────────────
  const cues: CueSpec[] = [];
  const cueIds = new Set<string>();
  if (!Array.isArray(input.cues)) {
    errors.push('cues must be an array');
  } else if (input.cues.length === 0) {
    // A spec with no cues cannot find a single fault, so every set scores a
    // flawless 100 and the coach is handed that number with nothing to say
    // about it. Caching one to a row would mean an unbroken run of perfect
    // scores from rules that can detect nothing.
    errors.push('cues must not be empty');
  } else if (input.cues.length > LIMITS.cues) {
    errors.push(`at most ${LIMITS.cues} cues`);
  } else {
    input.cues.forEach((raw, i) => {
      const where = `cues[${i}]`;
      if (!isObj(raw)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!isSafeId(raw.id) || cueIds.has(raw.id as string)) {
        errors.push(`${where}.id must be a unique short identifier`);
        return;
      }
      if (typeof raw.measure !== 'string' || !measureIds.has(raw.measure)) {
        errors.push(`${where}.measure must name one of the measures`);
        return;
      }
      if (typeof raw.sample !== 'string' || !CUE_SAMPLES.includes(raw.sample as CueSample)) {
        errors.push(`${where}.sample must be one of ${CUE_SAMPLES.join(', ')}`);
        return;
      }
      if (typeof raw.severity !== 'string' || !CUE_SEVERITIES.includes(raw.severity as CueSeverity)) {
        errors.push(`${where}.severity must be 'warn' or 'bad'`);
        return;
      }
      if (typeof raw.live !== 'string' || !raw.live.length || raw.live.length > LIMITS.liveChars) {
        errors.push(`${where}.live must be 1..${LIMITS.liveChars} chars`);
        return;
      }
      if (
        typeof raw.detail !== 'string' ||
        !raw.detail.length ||
        raw.detail.length > LIMITS.detailChars
      ) {
        errors.push(`${where}.detail must be 1..${LIMITS.detailChars} chars`);
        return;
      }
      const test = parseTest(raw.test, where, errors);
      if (!test) return;
      cues.push({
        id: raw.id as string,
        measure: raw.measure,
        sample: raw.sample as CueSample,
        test,
        severity: raw.severity as CueSeverity,
        live: raw.live,
        detail: raw.detail,
      });
      cueIds.add(raw.id as string);
    });
  }

  if (errors.length || !rep) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      version: FORM_SPEC_VERSION,
      view: input.view as FormRuleSpec['view'],
      setup: input.setup as string,
      measures,
      rep,
      cues,
    },
  };
}

function parseTest(raw: unknown, where: string, errors: string[]): CueTest | null {
  if (!isObj(raw)) {
    errors.push(`${where}.test must be an object`);
    return null;
  }
  const { op, a, b } = raw;
  if (!isFiniteNum(a)) {
    errors.push(`${where}.test.a must be a number`);
    return null;
  }
  if (op === '<' || op === '>') return { op, a };
  if (op === 'between' || op === 'outside') {
    if (!isFiniteNum(b)) {
      errors.push(`${where}.test.b must be a number for '${op}'`);
      return null;
    }
    if (b <= a) {
      errors.push(`${where}.test.b must be greater than test.a`);
      return null;
    }
    return { op, a, b };
  }
  errors.push(`${where}.test.op must be '<', '>', 'between' or 'outside'`);
  return null;
}

/** Does a sampled value trip this cue? */
export function testFires(test: CueTest, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  switch (test.op) {
    case '<':
      return value < test.a;
    case '>':
      return value > test.a;
    case 'between':
      return value >= test.a && value <= test.b;
    case 'outside':
      return value < test.a || value > test.b;
  }
}
