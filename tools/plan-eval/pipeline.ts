/**
 * Pipeline variants under test, plus the span instrumentation.
 *
 * FIDELITY RULE: the system prompt and the generate_plan tool schema are
 * IMPORTED from supabase/functions/ai-coach/prompt.ts, never copied. That
 * file is pure TypeScript with no Deno APIs precisely so a harness can do
 * this. tools/eval/run.ts copied them instead and has since drifted (it is
 * still on a 4-block system prompt; production is on 8). Do not repeat that.
 *
 * THE VARIANTS
 *   baseline — production today. One Sonnet call, tool_choice forced to
 *              generate_plan, whole plan as one JSON blob. Measured p50 29.4s.
 *   compact  — one call, but the plan comes back as compact lines instead of
 *              tool JSON. Tests the token-encoding lever alone: same content,
 *              ~22 tokens per exercise instead of ~82. No concurrency risk.
 *   fanout   — skeleton call (structure + movement assignment for every slot)
 *              then N day-fills plus the rationale, all in parallel. Tests the
 *              parallelism lever. The skeleton owns movement choice so that
 *              cross-day variant selection stays with the one call that sees
 *              the whole week.
 *
 * What is NOT covered: auth, access gate, rate limiting, SSE re-framing, the
 * client. Those are ~1s of the measured 25-48s and belong in production spans.
 */
import { createClient } from '@supabase/supabase-js';
import { buildSystemPrompt } from '../../supabase/functions/ai-coach/prompt';
import { EXERCISE_LIBRARY } from '../../lib/exercises';
import { COMPACT_FORMAT_SPEC, parseCompactPlan, type ParsedPlan } from './encoding';
import { callClaudeCli } from './cliCaller';
// The fanout variant drives the SHIPPED module, not a copy of it.
import { runGeneratePlan, type TextCaller } from '../../supabase/functions/ai-coach/generatePlan';
import type { CoachIntake, EvalCase, OnboardingIntake } from './cases';
import type { CoachGoal } from '../../lib/types';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
/** Mirrors GENERATE_PLAN_MAX_TOKENS in supabase/functions/ai-coach/index.ts. */
export const GENERATE_PLAN_MAX_TOKENS = 4096;
/** Mirrors ANTHROPIC_TIMEOUT_MS after the 2026-07-19 bump from 30s. Runs that
 *  cross the OLD 30s value are still counted, since that is what shipped
 *  before and what PR #66's non-streaming call would have hit. */
export const PROD_NONSTREAM_TIMEOUT_MS = 80_000;
export const LEGACY_NONSTREAM_TIMEOUT_MS = 30_000;

export interface StageTiming {
  label: string;
  ms: number;
  outTok: number;
  /** Wall-clock offset from the start of the whole run, for the timeline. */
  startedAt: number;
}

export interface Spans {
  ttft_ms: number;
  decode_ms: number;
  total_ms: number;
  /** Wall clock until workout[i] was fully emitted. On the baseline this is a
   *  measure of DELIVERY, not progress: forced tool_use ships its payload in
   *  one burst, so every workout lands at ~99% of wall clock. See README. */
  workout_complete_ms: number[];
  intent_text_ms: number | null;
  /** Per-call breakdown. One entry for single-call variants, N+2 for fanout. */
  stages: StageTiming[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface RunResult {
  caseId: string;
  variant: 'onboarding' | 'coach';
  pipeline: string;
  ok: boolean;
  error?: string;
  spans: Spans;
  usage: Usage;
  /** API calls made. Cost proxy: fanout trades calls for wall clock. */
  calls: number;
  output_tps: number;
  stopReason: string | null;
  intentText: string;
  plan: Record<string, unknown> | null;
}

const GOAL_LABEL: Record<CoachGoal, string> = {
  hypertrophy: 'build muscle',
  strength: 'get stronger',
  fat_loss: 'lose fat',
  endurance: 'build endurance',
  general: 'general fitness',
};

// ── Catalog ─────────────────────────────────────────────────────────────────
// EXERCISE_LIBRARY is 46 names. The real global catalog is 787 rows; measured
// as costing ~+220ms of TTFT when carried in a cached system block, and zero
// detectable total latency. Fetched lazily and memoized so a run pays once.
let catalogPromise: Promise<string[]> | null = null;
export function globalCatalog(): Promise<string[]> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key) return EXERCISE_LIBRARY.map((e) => e.name);
      const sb = createClient(url, key);
      const { data, error } = await sb.from('exercises').select('name').is('created_by', null).limit(2000);
      if (error || !data) return EXERCISE_LIBRARY.map((e) => e.name);
      return (data as { name: string }[]).map((r) => r.name);
    })();
  }
  return catalogPromise;
}

export type CatalogWidth = 'library' | 'full';

async function catalogNames(width: CatalogWidth): Promise<string[]> {
  return width === 'full' ? await globalCatalog() : EXERCISE_LIBRARY.map((e) => e.name);
}

// ── Prompt builders ─────────────────────────────────────────────────────────

/**
 * Mirrors buildOnboardingIntakeMessage in lib/onboardingDrona.ts (PR #66,
 * branch claude/onboarding-page-design-9a6550). Duplicated ONLY because that
 * branch is not merged. Once it lands, delete this and import the real one.
 */
export function buildOnboardingMessage(i: OnboardingIntake, catalog?: string[]): string {
  const names = (catalog ?? EXERCISE_LIBRARY.map((e) => e.name)).join('; ');
  const bodyFacts: string[] = [];
  if (i.gender) bodyFacts.push(`sex ${i.gender}`);
  if (i.ageYears) bodyFacts.push(`${i.ageYears} years old`);
  if (i.heightCm) bodyFacts.push(`${i.heightCm} cm`);
  if (i.weightKg) bodyFacts.push(`${i.weightKg} kg`);
  if (i.goalWeightKg && i.direction) {
    bodyFacts.push(
      `target weight ${i.goalWeightKg} kg (${i.direction === 'loss' ? 'cutting' : 'gaining'}${
        i.weeklyRateKg ? ` at ${i.weeklyRateKg} kg/week` : ''
      })`,
    );
  }
  return [
    `I just finished onboarding. Build my starter training plan from these answers.`,
    `Goal: ${GOAL_LABEL[i.goal]}. Experience: ${i.experience}. Training ${i.frequency} days a week.`,
    bodyFacts.length ? `Body: ${bodyFacts.join(', ')}.` : '',
    i.targets
      ? `My daily fuel targets are already set: ${i.targets.kcal} kcal, ${i.targets.protein}g protein, ${i.targets.carb}g carbs, ${i.targets.fat}g fat. If you mention nutrition, use exactly these numbers.`
      : '',
    `Rules:`,
    `- days_per_week is ${i.frequency}. Create the number of DISTINCT workouts that a ${i.experience} lifter should rotate through ${i.frequency} sessions a week (fewer distinct workouts than sessions is fine, they repeat). Typical: 1-3 days full body A/B, 4 days upper/lower, 5+ push/pull/legs. Deviate only if it genuinely fits better.`,
    `- Exercise names MUST be copied character-for-character from this catalog, nothing else: ${names}.`,
    `- 4-6 exercises per workout, compounds first. Sets 2-4, plain rep ranges like "6-10", rest 45-180 seconds.`,
    `- Short workout names ("Full Body A", "Push Day"). One-line note per workout with its focus.`,
    `- The rationale should read like you talking to me: why this split at ${i.frequency} days for my goal, and how to progress. 3-4 sentences, no lists.`,
    `This is a fresh account, so skip data-lookup tools and emit generate_plan directly.`,
  ].filter(Boolean).join('\n');
}

/** Mirrors buildInitialPrompt in components/ai/AICoachModal.tsx. */
export function buildCoachMessage(i: CoachIntake): string {
  return `Design a multi-day training plan for me. Goal: ${i.goal || 'general fitness'}. ${i.days}/week, ${i.sessionLength} sessions, ${i.level} level. Use my training data to choose appropriate volume, exercise selection, and progression. Give each day a short "note" with its theme and add per-exercise notes for form, intent, or RIR cues. Before calling generate_plan, write one short sentence (5-15 words) signaling your intent.`;
}

export async function messageFor(c: EvalCase, width: CatalogWidth = 'library'): Promise<string> {
  return c.variant === 'onboarding'
    ? buildOnboardingMessage(c.intake, await catalogNames(width))
    : buildCoachMessage(c.intake);
}

/**
 * Remove the "emit generate_plan directly" directive from an intake message.
 *
 * Both non-baseline variants ask for a line format instead of a tool call, so
 * leaving this in creates two contradictory instructions in one prompt. It is
 * not harmless: it produced a 3/18 skeleton failure rate where the model
 * ignored the format spec and started writing `generate_plan({"plan_name":...`
 * as literal text. Intermittent, so it reproduced 0/3 in isolation and was
 * only diagnosable once the harness captured the raw response.
 */
function stripToolDirective(msg: string): string {
  return msg
    .replace(/\n?This is a fresh account[^\n]*/g, '')
    .replace(/\n?Before calling generate_plan[^\n]*/g, '')
    .replace(/\s*Before calling generate_plan[^.]*\./g, '');
}

/** Also drop the rationale instruction: fan-out generates it in its own call. */
function stripRationaleDirective(msg: string): string {
  return msg.replace(/\n- The rationale should read like[^\n]*/g, '');
}

function userContextFor(c: EvalCase): unknown {
  return c.variant === 'coach' ? c.intake.userContext : null;
}

// ── Streaming core ──────────────────────────────────────────────────────────

/**
 * Count fully-emitted objects inside the top-level "workouts" array of a
 * partial JSON string. Brace-depth scan with string/escape awareness, so a
 * `}` inside a coaching note does not read as a closed workout.
 */
export function countCompleteWorkouts(partial: string): number {
  const key = partial.indexOf('"workouts"');
  if (key === -1) return 0;
  const open = partial.indexOf('[', key);
  if (open === -1) return 0;
  let depth = 0, inString = false, escaped = false, complete = 0;
  for (let p = open + 1; p < partial.length; p++) {
    const ch = partial[p];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) complete++; }
    else if (ch === ']' && depth === 0) break;
  }
  return complete;
}

/** Count fully-emitted DAY blocks in a partial compact-format stream. A day is
 *  "complete" once the NEXT DAY line starts, or the stream ends. */
function countCompleteCompactDays(partial: string): number {
  const dayLines = (partial.match(/^DAY\s*\|/gm) ?? []).length;
  return Math.max(0, dayLines - 1);
}

interface CallResult {
  text: string;
  toolInput: Record<string, unknown> | null;
  usage: Usage;
  ttft_ms: number;
  total_ms: number;
  stopReason: string | null;
  /** Arrival offsets (ms from THIS call's start) of each completed workout. */
  workoutAt: number[];
  intentAt: number | null;
}

async function streamCall(
  apiKey: string,
  payload: Record<string, unknown>,
  opts: { trackToolWorkouts?: boolean; trackCompactDays?: boolean } = {},
): Promise<CallResult> {
  const started = Date.now();
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let firstByteAt: number | null = null;
  let text = '', toolJson = '', stopReason: string | null = null, seen = 0, intentAt: number | null = null;
  const workoutAt: number[] = [];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = Date.now();
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) data += line.slice(6);
        else if (line.startsWith('data:')) data += line.slice(5);
      }
      if (!data || data === '[DONE]') continue;
      let evt: any;
      try { evt = JSON.parse(data); } catch { continue; }

      if (evt.type === 'message_start') {
        const u = evt.message?.usage ?? {};
        usage.input_tokens += u.input_tokens ?? 0;
        usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
        usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
      } else if (evt.type === 'content_block_delta') {
        const d = evt.delta;
        if (d?.type === 'text_delta') {
          text += d.text;
          if (opts.trackCompactDays) {
            const n = countCompleteCompactDays(text);
            while (seen < n) { workoutAt.push(Date.now() - started); seen++; }
          }
        } else if (d?.type === 'input_json_delta') {
          toolJson += d.partial_json;
          if (opts.trackToolWorkouts) {
            const n = countCompleteWorkouts(toolJson);
            while (seen < n) { workoutAt.push(Date.now() - started); seen++; }
          }
        }
      } else if (evt.type === 'content_block_stop') {
        if (text && intentAt === null) intentAt = Date.now() - started;
      } else if (evt.type === 'message_delta') {
        stopReason = evt.delta?.stop_reason ?? stopReason;
        usage.output_tokens += evt.usage?.output_tokens ?? 0;
      } else if (evt.type === 'error') {
        throw new Error(`stream error: ${JSON.stringify(evt.error ?? {}).slice(0, 200)}`);
      }
    }
  }

  // The final DAY block closes when the stream ends, not at the next DAY line.
  if (opts.trackCompactDays) workoutAt.push(Date.now() - started);

  let toolInput: Record<string, unknown> | null = null;
  if (toolJson) { try { toolInput = JSON.parse(toolJson); } catch { toolInput = null; } }

  return {
    text, toolInput, usage, stopReason, workoutAt, intentAt,
    ttft_ms: firstByteAt === null ? 0 : firstByteAt - started,
    total_ms: Date.now() - started,
  };
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
});

const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

/** ParsedPlan -> the generate_plan JSON shape the scorer and client expect. */
function toPlanJson(p: ParsedPlan): Record<string, unknown> {
  return {
    name: p.name,
    split_type: p.split_type,
    days_per_week: p.days_per_week,
    rationale: p.rationale,
    workouts: p.workouts.map((w) => ({
      name: w.name,
      note: w.note,
      exercises: w.exercises.map((e) => ({
        name: e.name, sets: e.sets, reps: e.reps, rest_seconds: e.rest_seconds, note: e.note,
      })),
    })),
  };
}

export interface VariantOpts {
  apiKey: string;
  model?: string;
  /** Model for the parallel fills in fanout. Defaults to `model`. */
  fillModel?: string;
  catalog?: CatalogWidth;
  /** Transport. 'api' hits Anthropic directly (full fidelity). 'cli' shells
   *  out to `claude -p`, which works on a subscription when API credits are
   *  exhausted but loses prompt caching, max_tokens, and tool_choice — see
   *  cliCaller.ts. `baseline` requires tool_choice and cannot use 'cli'. */
  provider?: Provider;
}

export type Provider = 'api' | 'cli';

function failed(c: EvalCase, pipeline: string, error: string, partial?: Partial<RunResult>): RunResult {
  return {
    caseId: c.id, variant: c.variant, pipeline, ok: false, error,
    spans: { ttft_ms: 0, decode_ms: 0, total_ms: 0, workout_complete_ms: [], intent_text_ms: null, stages: [] },
    usage: emptyUsage(), calls: 0, output_tps: 0, stopReason: null, intentText: '', plan: null,
    ...partial,
  };
}

// ── Variant: baseline ───────────────────────────────────────────────────────

export async function runBaseline(c: EvalCase, o: VariantOpts): Promise<RunResult> {
  const model = o.model ?? DEFAULT_MODEL;
  const { system, tools } = buildSystemPrompt({ userContext: userContextFor(c), mode: 'generate_plan' });
  const started = Date.now();
  let r: CallResult;
  try {
    r = await streamCall(o.apiKey, {
      model, max_tokens: GENERATE_PLAN_MAX_TOKENS, system, tools,
      messages: [{ role: 'user', content: await messageFor(c, o.catalog ?? 'library') }],
      tool_choice: { type: 'tool', name: 'generate_plan' },
    }, { trackToolWorkouts: true });
  } catch (e) {
    return failed(c, 'baseline', String(e).slice(0, 200));
  }
  const total = Date.now() - started;
  return {
    caseId: c.id, variant: c.variant, pipeline: 'baseline',
    ok: r.toolInput !== null,
    error: r.toolInput === null ? `unparseable tool input (stop_reason=${r.stopReason})` : undefined,
    spans: {
      ttft_ms: r.ttft_ms, decode_ms: total - r.ttft_ms, total_ms: total,
      workout_complete_ms: r.workoutAt, intent_text_ms: r.intentAt,
      stages: [{ label: 'generate', ms: r.total_ms, outTok: r.usage.output_tokens, startedAt: 0 }],
    },
    usage: r.usage, calls: 1,
    output_tps: total > r.ttft_ms ? (r.usage.output_tokens / (total - r.ttft_ms)) * 1000 : 0,
    stopReason: r.stopReason, intentText: r.text.trim(), plan: r.toolInput,
  };
}

// ── Variant: compact ────────────────────────────────────────────────────────

export async function runCompact(c: EvalCase, o: VariantOpts): Promise<RunResult> {
  const model = o.model ?? DEFAULT_MODEL;
  // mode 'chat' so no generate tool is attached: the plan comes back as text.
  const { system } = buildSystemPrompt({ userContext: userContextFor(c), mode: 'chat' });
  const base = await messageFor(c, o.catalog ?? 'library');
  const msg = `${stripToolDirective(base)}\n\n${COMPACT_FORMAT_SPEC}`;

  const started = Date.now();
  let r: CallResult;
  try {
    if (o.provider === 'cli') {
      // No streaming through the CLI, so per-day arrival times are lost here.
      const cli = await callClaudeCli({ system, messages: [{ role: 'user', content: msg }], model });
      r = {
        text: cli.text, toolInput: null, usage: cli.usage, stopReason: null,
        workoutAt: [], intentAt: null,
        ttft_ms: Math.max(0, cli.total_ms - cli.api_ms), total_ms: cli.total_ms,
      };
    } else {
      r = await streamCall(o.apiKey, {
        model, max_tokens: GENERATE_PLAN_MAX_TOKENS, system,
        messages: [{ role: 'user', content: msg }],
      }, { trackCompactDays: true });
    }
  } catch (e) {
    return failed(c, 'compact', String(e).slice(0, 200));
  }
  const total = Date.now() - started;
  const parsed = parseCompactPlan(r.text);
  return {
    caseId: c.id, variant: c.variant, pipeline: 'compact',
    ok: parsed !== null,
    error: parsed === null ? `compact parse failed (stop_reason=${r.stopReason})` : undefined,
    spans: {
      ttft_ms: r.ttft_ms, decode_ms: total - r.ttft_ms, total_ms: total,
      workout_complete_ms: r.workoutAt, intent_text_ms: r.intentAt,
      stages: [{ label: 'generate', ms: r.total_ms, outTok: r.usage.output_tokens, startedAt: 0 }],
    },
    usage: r.usage, calls: 1,
    output_tps: total > r.ttft_ms ? (r.usage.output_tokens / (total - r.ttft_ms)) * 1000 : 0,
    stopReason: r.stopReason, intentText: '', plan: parsed ? toPlanJson(parsed) : null,
  };
}

// ── Variant: fanout ─────────────────────────────────────────────────────────

/**
 * Fan-out, driven through the REAL production module.
 *
 * This deliberately imports supabase/functions/ai-coach/generatePlan.ts rather
 * than reimplementing the pipeline, for the same reason parseMeal.ts was
 * extracted: an eval that tests a copy eventually tests something the product
 * does not do. tools/eval/run.ts copied the coach prompt and is now several
 * revisions behind production. The only thing the harness supplies here is
 * I/O — the HTTP call and the timing — which is exactly what GeneratePlanDeps
 * exists to inject.
 */
export async function runFanout(c: EvalCase, o: VariantOpts): Promise<RunResult> {
  const model = o.model ?? DEFAULT_MODEL;
  const catalog = await catalogNames(o.catalog ?? 'full');
  const { system } = buildSystemPrompt({ userContext: userContextFor(c), mode: 'chat' });

  const runStarted = Date.now();
  let firstTtft = 0;
  const dayReadyAt: number[] = [];

  // The production module takes a plain text caller; we supply the transport.
  // Streaming (api) gives real TTFT; the CLI reports duration_api_ms instead,
  // which excludes its ~650ms of process startup.
  const call: TextCaller = o.provider === 'cli'
    ? async ({ system: sys, messages, model: m, label }) => {
        const r = await callClaudeCli({ system: sys, messages, model: m ?? model });
        if (label === 'skeleton') firstTtft = Math.max(0, r.total_ms - r.api_ms);
        return { text: r.text, usage: r.usage };
      }
    : async ({ system: sys, messages, maxTokens, model: m, label }) => {
        const r = await streamCall(o.apiKey, {
          model: m ?? model,
          max_tokens: maxTokens,
          system: sys,
          messages,
        });
        if (label === 'skeleton') firstTtft = r.ttft_ms;
        return {
          text: r.text,
          usage: {
            input_tokens: r.usage.input_tokens,
            output_tokens: r.usage.output_tokens,
            cache_read_input_tokens: r.usage.cache_read_input_tokens,
            cache_creation_input_tokens: r.usage.cache_creation_input_tokens,
          },
        };
      };

  const result = await runGeneratePlan(await messageFor(c, 'library'), {
    call,
    catalog,
    system: system as unknown[],
    model,
    fillModel: o.fillModel,
    onDay: () => { dayReadyAt.push(Date.now() - runStarted); },
  });

  const total = Date.now() - runStarted;
  const stages: StageTiming[] = result.stages.map((s) => ({
    label: s.label, ms: s.ms, outTok: s.output_tokens, startedAt: s.startedAt,
  }));

  return {
    caseId: c.id, variant: c.variant, pipeline: 'fanout',
    ok: result.plan !== null,
    error: result.error,
    spans: {
      ttft_ms: firstTtft,
      decode_ms: Math.max(0, total - firstTtft),
      total_ms: total,
      workout_complete_ms: dayReadyAt.sort((a, b) => a - b),
      intent_text_ms: null,
      stages,
    },
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
    },
    calls: result.calls,
    output_tps: total > 0 ? (result.usage.output_tokens / total) * 1000 : 0,
    stopReason: null,
    intentText: '',
    plan: result.plan as unknown as Record<string, unknown> | null,
  };
}

export type PipelineName = 'baseline' | 'compact' | 'fanout';

export const VARIANTS: Record<PipelineName, (c: EvalCase, o: VariantOpts) => Promise<RunResult>> = {
  baseline: runBaseline,
  compact: runCompact,
  fanout: runFanout,
};
