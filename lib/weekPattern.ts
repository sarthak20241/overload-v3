/**
 * What a week inside a program phase actually looks like, day by day.
 *
 * A phase used to say only "Push/Pull/Legs, 5 days a week". That leaves the
 * reader to guess WHICH day is which, and a 5-day PPL has no obvious answer.
 * This module turns the block descriptor into an explicit Day 1..Day 7 line.
 *
 * Days are numbered, never named. "Day 1" travels with the user; "Monday"
 * only works for people who start their week on a Monday and never miss one.
 *
 * Pure on purpose: no imports, so `deno test` can reach it without React
 * Native or Supabase. Both authors of a program use it, the coach (whose
 * emitted pattern is validated here) and the deterministic starter builder.
 */

/** Exactly 7 labels, Day 1 first. A rest day is the literal string "Rest". */
export type WeekPattern = string[];

export const REST = 'Rest';

/** Longest label we let through; keeps the strip on one line on a phone. */
const MAX_LABEL = 18;

/** A day off, however the model spelled it. */
export function isRestLabel(label: string): boolean {
  const t = label.trim().toLowerCase();
  return t === 'rest' || t === 'off' || t === 'rest day' || t === '-' || t === '';
}

/** Label cycles we know how to lay out, longest key first so "push/pull/legs"
 *  is matched before a bare "pull". */
const SPLIT_CYCLES: Array<[RegExp, string[]]> = [
  [/push.*pull.*leg|\bppl\b/i, ['Push', 'Pull', 'Legs']],
  [/upper.*lower|\bul\b/i, ['Upper', 'Lower']],
  [/full.?body/i, ['Full Body']],
  [/bro.?split|body.?part/i, ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms']],
  [/arnold/i, ['Chest + Back', 'Shoulders + Arms', 'Legs']],
  [/push.*pull/i, ['Push', 'Pull']],
];

/** The cycle of workout names for a split, falling back on the day count. */
export function splitCycle(splitType: string | null | undefined, daysPerWeek: number): string[] {
  const s = (splitType ?? '').trim();
  if (s) {
    for (const [re, cycle] of SPLIT_CYCLES) if (re.test(s)) return cycle;
  }
  // No recognisable split name: pick the one that fits the week honestly.
  if (daysPerWeek >= 5) return ['Push', 'Pull', 'Legs'];
  if (daysPerWeek === 4) return ['Upper', 'Lower'];
  return ['Full Body'];
}

/**
 * Which of the 7 days are training days, spread as evenly as the count allows.
 * Rest days are placed at even intervals and the week is then rotated so Day 1
 * is always a training day (a plan that opens on a rest day reads as a mistake).
 */
function trainingDays(daysPerWeek: number): boolean[] {
  const d = Math.min(7, Math.max(1, Math.round(daysPerWeek)));
  const week = new Array(7).fill(true);
  const rests = 7 - d;
  for (let k = 0; k < rests; k += 1) {
    week[Math.round(((k + 1) * 7) / rests) - 1] = false;
  }
  // Rotate left until the week opens on a training day.
  for (let guard = 0; guard < 7 && !week[0]; guard += 1) week.push(week.shift()!);
  return week;
}

/** The deterministic Day 1..Day 7 line for a block descriptor. */
export function buildWeekPattern(
  splitType: string | null | undefined,
  daysPerWeek: number,
): WeekPattern {
  const cycle = splitCycle(splitType, daysPerWeek);
  let next = 0;
  return trainingDays(daysPerWeek).map((train) => {
    if (!train) return REST;
    const label = cycle[next % cycle.length];
    next += 1;
    return label;
  });
}

/**
 * Accept a coach-emitted pattern only when it is actually usable: 7 entries,
 * short labels, and a training-day count that matches the days_per_week the
 * same phase promises. A pattern that contradicts the header is worse than no
 * pattern, so a mismatch falls back to the deterministic line.
 */
export function normalizeWeekPattern(
  v: unknown,
  daysPerWeek: number,
): WeekPattern | undefined {
  if (!Array.isArray(v) || v.length !== 7) return undefined;
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') return undefined;
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
    out.push(isRestLabel(t) ? REST : t);
  }
  const training = out.filter((l) => l !== REST).length;
  if (training !== Math.round(daysPerWeek)) return undefined;
  return out;
}

/**
 * A label narrow enough for one of seven columns on a phone. Seven cells share
 * the card width, so anything past about nine characters is cut by the layout
 * anyway; cutting it here at a word boundary keeps it readable.
 */
export function shortDayLabel(label: string): string {
  const t = label.trim();
  if (t.length <= 9) return t;
  const first = t.split(/[\s/+&]+/)[0];
  return (first.length <= 9 ? first : first.slice(0, 8)).trim();
}

/** The pattern to show for a block: the coach's if it holds up, else ours. */
export function weekPatternFor(block: {
  split_type?: string | null;
  days_per_week?: number | null;
  week_pattern?: unknown;
} | null | undefined): WeekPattern | undefined {
  if (!block) return undefined;
  const days = block.days_per_week;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 1 || days > 7) return undefined;
  return normalizeWeekPattern(block.week_pattern, days) ?? buildWeekPattern(block.split_type, days);
}

/**
 * One line of text for a week, for prompts: "Day 1 Push, Day 2 Rest, ...".
 * The refine recap uses it so the coach sees each phase's current schedule and
 * can keep it; without it every refine had to invent a new week, because the
 * tool schema requires one.
 */
export function weekPatternText(pattern: WeekPattern): string {
  return pattern.map((label, i) => `Day ${i + 1} ${label}`).join(', ');
}
