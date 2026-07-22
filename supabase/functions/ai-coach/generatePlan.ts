/**
 * Fan-out plan generation.
 *
 * Replaces the single forced-tool call for generate_plan. Measured on
 * tools/plan-eval (18 runs per pipeline, onboarding cases, 2026-07-19):
 *
 *   baseline (1 forced tool call)   p50 29.3s   p95 39.9s   1650 out tok
 *   fanout   (skeleton + parallel)  p50 11.8s   p95 15.9s   1252 out tok
 *
 * Both passed 18/18 on the deterministic gate. Fan-out also had FEWER
 * cross-day exercise repeats than the single call (6/18 runs vs 9/18): giving
 * variant selection its own dedicated decision beats burying it 1650 tokens
 * deep in a JSON emission.
 *
 * SHAPE
 *   1. Skeleton (one call). Split, day names and themes, and the exact
 *      exercise assigned to every slot. This is the only call that sees the
 *      whole week, which is deliberate: choosing a flat press for day 1 and an
 *      incline press for day 4 is cross-day judgment. Fills never choose
 *      movements, so two days cannot collide by accident.
 *   2. Fills + rationale (N+1 calls, all in flight at once). Each fill turns
 *      one day's assigned exercises into sets/reps/rest/cue. Each receives the
 *      COMPLETE skeleton, because input is the cheap axis (~85% of input
 *      tokens are cache reads) and context is near-free insurance.
 *   3. Assembly (no model). Deterministic, and the skeleton wins on naming so
 *      a drifting fill cannot rename or drop an exercise.
 *
 * WHY LINES INSTEAD OF TOOL JSON
 * Two measured reasons. Tool JSON costs ~82 output tokens per exercise against
 * ~22 for a line, and latency is almost purely a function of output tokens
 * (latency_ms = 62 + 16.35 * output_tokens, R^2 = 0.971). And forced
 * tool_choice does not stream: 50% of its payload arrives at 98% of wall
 * clock, versus 63% for text. Lines are what make progressive rendering
 * possible at all.
 *
 * Runtime-agnostic on purpose (same pattern as parseMeal.ts): all I/O is
 * injected, so tools/plan-eval can drive this exact code from Node.
 */

export interface PlanExercise {
  name: string;
  sets: number;
  reps: string;
  rest_seconds: number;
  note?: string;
}

export interface PlanWorkout {
  name: string;
  note?: string;
  exercises: PlanExercise[];
}

/** The generate_plan tool-input shape the client already renders. Unchanged. */
export interface GeneratedPlan {
  name: string;
  split_type?: string;
  days_per_week?: number;
  rationale: string;
  workouts: PlanWorkout[];
}

export interface PlanSkeleton {
  name: string;
  split_type?: string;
  days_per_week?: number;
  days: { name: string; note?: string; slots: string[] }[];
}

/** One text-completion call. Injected so the eval can drive the real code. */
export type TextCaller = (args: {
  system: unknown;
  messages: { role: string; content: unknown }[];
  maxTokens: number;
  model?: string;
  label: string;
}) => Promise<{ text: string; usage: PlanUsage }>;

export interface PlanUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface PlanStage {
  label: string;
  ms: number;
  output_tokens: number;
  startedAt: number;
}

export interface GeneratePlanDeps {
  call: TextCaller;
  /** Global exercise catalog names. Grounds the skeleton's slot assignment. */
  catalog: string[];
  /** Cached system blocks from buildSystemPrompt. */
  system: unknown[];
  /** Fires when the skeleton lands, so the client can render structure early. */
  onSkeleton?: (s: PlanSkeleton) => void;
  /** Fires as each day's prescriptions land. */
  onDay?: (index: number, workout: PlanWorkout) => void;
  model?: string;
  fillModel?: string;
  now?: () => number;
}

export interface GeneratePlanResult {
  plan: GeneratedPlan | null;
  error?: string;
  usage: PlanUsage;
  calls: number;
  stages: PlanStage[];
}

// ── Format specs ────────────────────────────────────────────────────────────
// Kept next to their parsers so the two can never drift.

export const SKELETON_FORMAT_SPEC = `Emit ONLY this exact line format. No JSON, no markdown, no code fences, no commentary.

PLAN | <plan name> | <split type> | <days per week>
DAY | <workout name> | <one-line focus for this session>
SLOT | <exact exercise name from the catalog>
SLOT | <exact exercise name from the catalog>
DAY | <next workout name> | <focus>
SLOT | ...

Rules:
- One SLOT line per exercise, in the order they should be performed, compounds first.
- SLOT carries ONLY the exercise name. No sets, no reps, no rest, no cue.
- Every SLOT name must be copied character-for-character from the catalog.
- Never use the | character inside a field value.`;

export const FILL_FORMAT_SPEC = `Emit ONLY EX lines, one per exercise, in the order given. No JSON, no markdown, no commentary, no DAY line.

EX | <exercise name exactly as given> | <sets> | <reps> | <rest seconds> | <short coaching cue>

Rules:
- One EX line per assigned exercise, same order, same names. Do not add, drop, rename, or reorder exercises.
- <sets> is a plain integer 1-6. <rest seconds> is a plain integer 30-300.
- <reps> is a plain range like 6-10, or a single number like 5. For a timed
  exercise (planks, carries, holds) write seconds as a number followed by s,
  e.g. 45s.
- <coaching cue> is a short phrase on intent or execution. Omit the trailing
  " | <cue>" entirely if the exercise needs no cue.
- Never use the | character inside a field value.`;

// ── Parsers ─────────────────────────────────────────────────────────────────
// Liberal by design: a dropped exercise is far worse than a slightly-off cue,
// so every field has a fallback and unparseable lines are skipped.

const cell = (s: string | undefined) => (s ?? "").trim();

function toInt(s: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = parseInt(cell(s), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function parseSkeleton(raw: string): PlanSkeleton | null {
  const days: PlanSkeleton["days"] = [];
  let name = "";
  let split_type: string | undefined;
  let days_per_week: number | undefined;

  for (const line of raw.split("\n")) {
    const parts = line.trim().replace(/^[`*\-\s]+/, "").split("|");
    const tag = cell(parts[0]).toUpperCase();
    if (tag === "PLAN") {
      name = cell(parts[1]) || name;
      split_type = cell(parts[2]) || undefined;
      const d = parseInt(cell(parts[3]), 10);
      if (Number.isFinite(d)) days_per_week = d;
    } else if (tag === "DAY") {
      days.push({ name: cell(parts[1]) || `Day ${days.length + 1}`, note: cell(parts[2]) || undefined, slots: [] });
    } else if (tag === "SLOT") {
      if (days.length === 0) continue;
      const n = cell(parts[1]);
      if (n) days[days.length - 1].slots.push(n);
    }
  }

  if (days.length === 0 || days.every((d) => d.slots.length === 0)) return null;
  return { name: name || "Training Plan", split_type, days_per_week, days };
}

export function parseFill(raw: string): PlanExercise[] {
  const out: PlanExercise[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.trim().replace(/^[`*\-\s]+/, "").split("|");
    if (cell(parts[0]).toUpperCase() !== "EX") continue;
    const name = cell(parts[1]);
    if (!name) continue;
    out.push({
      name,
      sets: toInt(parts[2], 3, 1, 6),
      reps: cell(parts[3]) || "8-12",
      rest_seconds: toInt(parts[4], 90, 30, 300),
      note: cell(parts[5]) || undefined,
    });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Stitch skeleton + fills + rationale. The skeleton is the source of truth for
 * structure and naming: a fill that renamed or dropped an exercise is
 * corrected back here rather than silently changing the plan.
 */
export function assemblePlan(
  skeleton: PlanSkeleton,
  fills: (PlanExercise[] | null)[],
  rationale: string,
): GeneratedPlan {
  return {
    name: skeleton.name,
    split_type: skeleton.split_type,
    days_per_week: skeleton.days_per_week,
    rationale: rationale.trim(),
    workouts: skeleton.days.map((day, i) => buildWorkout(day, fills[i])),
  };
}

export function buildWorkout(
  day: PlanSkeleton["days"][number],
  filled: PlanExercise[] | null,
): PlanWorkout {
  const list = filled ?? [];
  const byName = new Map(list.map((e) => [norm(e.name), e]));
  return {
    name: day.name,
    note: day.note,
    exercises: day.slots.map((slot, j) => {
      // Positional fallback covers a fill that kept order but drifted on name.
      const hit = byName.get(norm(slot)) ?? list[j];
      return {
        name: slot,
        sets: hit?.sets ?? 3,
        reps: hit?.reps ?? "8-12",
        rest_seconds: hit?.rest_seconds ?? 90,
        note: hit?.note,
      };
    }),
  };
}

// ── Prompt assembly ─────────────────────────────────────────────────────────

/**
 * Strip directives that contradict the line format.
 *
 * Not cosmetic. Leaving "emit generate_plan directly" in the intake produced a
 * 3/18 skeleton failure rate where the model ignored the format spec and wrote
 * `generate_plan({"plan_name":...` as literal text. Intermittent enough that
 * it reproduced 0/3 in isolation.
 */
export function stripToolDirectives(msg: string): string {
  return msg
    .replace(/\n?This is a fresh account[^\n]*/g, "")
    .replace(/\n?Before calling generate_plan[^\n]*/g, "")
    .replace(/\s*Before calling generate_plan[^.]*\./g, "")
    .replace(
      /- Exercise names MUST be copied character-for-character from this catalog, nothing else: [^\n]*/,
      "- Exercise names MUST be copied character-for-character from the <exercise_catalog> in the system prompt.",
    );
}

const stripRationaleDirective = (msg: string) =>
  msg.replace(/\n- The rationale should read like[^\n]*/g, "");

const VARIANT_RULE =
  `Design the STRUCTURE only. Assign the specific exercise for every slot yourself: across days that train the same muscle, deliberately pick complementary variants (for example a flat press on one day and an incline press on another, a squat pattern on one day and a hinge pattern on another). Do not repeat the same exercise on two different days unless the program genuinely calls for it.`;

function skeletonText(s: PlanSkeleton): string {
  return s.days
    .map((d, i) => `D${i + 1} ${d.name}${d.note ? ` :: ${d.note}` : ""}\n${d.slots.map((x) => `  - ${x}`).join("\n")}`)
    .join("\n");
}

// ── Orchestration ───────────────────────────────────────────────────────────

export async function runGeneratePlan(
  userMessage: string,
  deps: GeneratePlanDeps,
): Promise<GeneratePlanResult> {
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const stages: PlanStage[] = [];
  const usage: PlanUsage = {
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  };
  let calls = 0;

  const add = (u: PlanUsage) => {
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.cache_read_input_tokens += u.cache_read_input_tokens;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens;
  };

  // Catalog rides in a CACHED system block, not the user turn. Measured: cuts
  // uncached input from ~7175 to ~758 tokens and the TTFT cost of carrying the
  // full 787-name catalog from ~740ms to ~220ms. The block is shared by every
  // parallel fill, so each one gets it as a cache read.
  const system = [
    ...deps.system,
    {
      type: "text",
      text: `<exercise_catalog>\n${deps.catalog.join("; ")}\n</exercise_catalog>`,
      cache_control: { type: "ephemeral" },
    },
  ];

  const intake = stripToolDirectives(userMessage);

  // ── Stage 1: skeleton ─────────────────────────────────────────────────────
  const skelStart = now();
  let skelText: string;
  try {
    const r = await deps.call({
      system,
      messages: [{ role: "user", content: `${stripRationaleDirective(intake)}\n\n${VARIANT_RULE}\n\n${SKELETON_FORMAT_SPEC}` }],
      maxTokens: 1500,
      model: deps.model,
      label: "skeleton",
    });
    skelText = r.text;
    add(r.usage);
    calls++;
    stages.push({ label: "skeleton", ms: now() - skelStart, output_tokens: r.usage.output_tokens, startedAt: skelStart - t0 });
  } catch (e) {
    return { plan: null, error: `skeleton call failed: ${String(e).slice(0, 200)}`, usage, calls, stages };
  }

  const skeleton = parseSkeleton(skelText);
  if (!skeleton) {
    const head = skelText.replace(/\s+/g, " ").trim().slice(0, 200) || "<empty>";
    return { plan: null, error: `skeleton parse failed: "${head}"`, usage, calls, stages };
  }
  deps.onSkeleton?.(skeleton);

  // ── Stage 2: fills + rationale, all in flight at once ─────────────────────
  const skelSummary = skeletonText(skeleton);

  const fillJobs = skeleton.days.map((day, i) => async () => {
    const started = now();
    const r = await deps.call({
      system: deps.system, // fills do not need the catalog: names are assigned
      messages: [{
        role: "user",
        content: [
          `Here is the full plan structure that has already been decided:`,
          ``,
          skelSummary,
          ``,
          `Write the prescription for D${i + 1} (${day.name}) ONLY. The exercises and their order are fixed; your job is sets, reps, rest, and a coaching cue for each. Take the other days into account so weekly volume and fatigue make sense.`,
          ``,
          `Exercises for D${i + 1}, in order:`,
          ...day.slots.map((s) => `- ${s}`),
          ``,
          FILL_FORMAT_SPEC,
        ].join("\n"),
      }],
      maxTokens: 900,
      model: deps.fillModel ?? deps.model,
      label: `fill:d${i + 1}`,
    });
    // Measure THIS call's own duration, here, before the other parallel jobs
    // settle. Computing `now() - started` in the post-allSettled loop instead
    // would read the same clock for every stage and report the whole parallel
    // phase as each stage's duration — which is exactly the bug this replaces.
    return { kind: "fill" as const, index: i, text: r.text, usage: r.usage, started, ms: now() - started };
  });

  const rationaleJob = async () => {
    const started = now();
    const r = await deps.call({
      system: deps.system,
      messages: [{
        role: "user",
        content: [
          `Here is the training plan you just designed for this lifter:`,
          ``,
          skelSummary,
          ``,
          intake,
          ``,
          `Write ONLY the rationale: 3-4 sentences, plain prose in one paragraph, no lists, no headings, no preamble. Why this split at this frequency for their goal, and how to progress it.`,
        ].join("\n"),
      }],
      maxTokens: 500,
      model: deps.model,
      label: "rationale",
    });
    return { kind: "rationale" as const, index: -1, text: r.text, usage: r.usage, started, ms: now() - started };
  };

  const settled = await Promise.allSettled([...fillJobs.map((f) => f()), rationaleJob()]);

  const fills: (PlanExercise[] | null)[] = skeleton.days.map(() => null);
  let rationale = "";
  // Promise.allSettled swallows rejection reasons. Keeping them is not
  // optional: an eval run where the API returned 400 for every fill reported
  // only "7/7 day-fills failed", which read like a prompt bug and cost real
  // time to rule out.
  const failureReasons: string[] = [];

  for (const s of settled) {
    if (s.status !== "fulfilled") {
      failureReasons.push(String(s.reason).slice(0, 160));
      continue;
    }
    const { kind, index, text, usage: u, started, ms } = s.value;
    add(u);
    calls++;
    stages.push({
      // `ms` was measured inside the job the instant its own call returned;
      // `startedAt` is its offset from run start. Together they place each
      // parallel call on a real timeline, so a straggling fill is visible.
      label: kind === "fill" ? `fill:d${index + 1}` : "rationale",
      ms, output_tokens: u.output_tokens, startedAt: started - t0,
    });
    if (kind === "fill") {
      fills[index] = parseFill(text);
      deps.onDay?.(index, buildWorkout(skeleton.days[index], fills[index]));
    } else {
      rationale = text.trim();
    }
  }

  const totalDays = skeleton.days.length;
  const deadFills = fills.filter((f) => f === null || f.length === 0).length;
  const reasonSuffix = failureReasons.length ? ` (${failureReasons[0]})` : "";

  // Partial failure is survivable: one day falls back to sane defaults rather
  // than losing the plan. WIDESPREAD failure is not, and must not be dressed
  // up as success. With every fill dead, assemblePlan still returns a
  // structurally valid plan in which every exercise is 3 x 8-12 @ 90s with no
  // cue and no rationale. That would sail past a caller checking only for
  // null, and onboarding would save it as if Drona had written it. Fail loudly
  // instead so the caller can fall back to the deterministic starter plan.
  const tooManyDead = deadFills > Math.floor(totalDays / 2);
  if (tooManyDead) {
    return {
      plan: null,
      error: `${deadFills}/${totalDays} day-fills failed${reasonSuffix}`,
      usage, calls, stages,
    };
  }
  if (!rationale) {
    return {
      plan: null,
      error: `rationale call failed${reasonSuffix}`,
      usage, calls, stages,
    };
  }

  return {
    plan: assemblePlan(skeleton, fills, rationale),
    error: deadFills > 0 ? `${deadFills}/${totalDays} day-fills failed, defaults applied${reasonSuffix}` : undefined,
    usage, calls, stages,
  };
}
