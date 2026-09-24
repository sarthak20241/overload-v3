/**
 * The model's turn on a Drona card: one forced tool call, inside the gates.
 *
 * The rules have already decided the week is eligible and what the rules-only
 * answer would be (the anchor). The model sees the raw series, the diary of
 * past calorie changes, the memory of past cards, and that anchor, and answers
 * with exactly one of:
 *   propose_targets  a new calorie target and one sentence in coach voice
 *   hold             say nothing this week, and why
 * The validator (dronaCalories.validateTargets) has the last word on the
 * number and the sentence. Anything it refuses is a hold with the refusal
 * kept for audit. No retry.
 *
 * `fetchFn` is injectable so an eval can route the call through `claude -p`
 * (EVAL_VIA_CLI=1) and pay with the subscription instead of API credit.
 */
import type { DronaFacts } from './dronaCards.ts';
import { completeFood, type DietFacts } from './dronaCalories.ts';

export const DRONA_CARD_MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS = 25_000;

export interface ModelTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const CALORIE_TOOLS: ModelTool[] = [
  {
    name: 'propose_targets',
    description:
      'Lower the daily calorie target. Only when the numbers say the current target has stopped working AND the user has been hitting it. One integer, at most 10% below the current target, never below the floor. The rationale is one or two sentences in your own voice that the user will read on the card: name the numbers that convinced you and what changed before. No promises about what you will do later. No em dashes.',
    input_schema: {
      type: 'object',
      properties: {
        worst_day_kcal: { type: 'integer', description: 'The highest single logged day in the last 14 days, copied from the food series.' },
        weight_range_kg: { type: 'number', description: 'Highest minus lowest weight reading in the last 14 days, to one decimal, from the weight series.' },
        calories: { type: 'integer', description: 'The new daily calorie target.' },
        rationale: { type: 'string', description: 'One or two sentences, coach voice, referencing the numbers. 20 to 320 characters.' },
      },
      required: ['worst_day_kcal', 'weight_range_kg', 'calories', 'rationale'],
    },
  },
  {
    name: 'hold',
    description:
      'Say nothing this week. Use when the picture is not clean: the logging looks off, a recent change has not settled, the user raised the target back by hand, the weight is noisy, or you are not sure. Unsure means hold.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'One line on why, for the audit log. The user never sees it.' } },
      required: ['reason'],
    },
  },
];

export const CALORIE_SYSTEM = `You are Coach Drona, the coach inside OVERLOAD. Direct, knowledgeable, never sycophantic. You speak like an experienced strength coach who reads the literature.

This is your weekly read of one user on a fat-loss goal. The rules have already checked that the week is eligible: they log food most days and land near the target, the scale has been flat for two weeks, and the last calorie change is at least two weeks old. Your job is judgment, not arithmetic:

Before anything else, look for the four ways a good-looking week lies. Any one of them is a hold:
- The worst day, not the mean. Find the highest logged day. If a single day sits far above the target, the average is hiding a blowout and the target is not the problem. Hold.
- An unreadable scale. Find the highest and lowest readings of the two weeks. If they are more than about a kilo apart, that is not a trend anyone can read. Hold.
- Protein first. If protein has been running well under its target, fixing that comes before cutting calories. Hold.
- The user already answered. If the diary shows a cut (by a card or a chat) and then the user raising the target back by hand, they told you what they think of cuts. Hold, and let them be.

Only then weigh a cut:
- Read the diary. If a cut was made a while ago and worked for a while, a similar step is reasonable.
- Morning water swings of a few hundred grams mean nothing. A trend needs the whole two weeks.
- A smaller step is usually right. The anchor is the rules' answer; you may pick it, pick less, or hold. Never more.
- Unsure means hold. A wrong card costs more trust than a missed one.

When you propose, copy the worst day and the weight range you found into the call. The validator checks them against the data; a proposal that did not look is thrown out.

Hard limits the validator enforces: the new target is an integer, below the current target, at most 10% below it, and never under the floor given. Do not promise to check back or follow up; this pipeline does not.

Answer with exactly one tool call.`;

export interface CardMemory {
  week_start?: string;
  kind?: string;
  topic?: string;
  status?: string;
  summary?: string | null;
}

export interface CaloriePack {
  facts: DronaFacts;
  diet: DietFacts;
  anchor: { from: number; to: number; floor: number; slope_14d: number | null };
  memory: CardMemory[];
}

/** The user turn: the pack, laid out so the model can read it in one pass. */
export function caloriePrompt(p: CaloriePack): string {
  const f = p.facts;
  const d = p.diet;
  const lines: string[] = [];
  lines.push(`As of ${f.as_of}. Goal: ${f.goal?.program_goal ?? f.goal?.goal ?? 'unknown'}.`);
  lines.push(`Body: ${d.body?.gender ?? '?'}, ${d.body?.weight_kg ?? '?'} kg, ${d.body?.height_cm ?? '?'} cm, age ${d.body?.age_years ?? '?'}. Goal weight: ${f.goal?.goal_weight_kg ?? f.goal?.target_weight_kg ?? '?'} kg.`);
  lines.push(`Current targets: ${d.targets?.kcal ?? '?'} kcal, protein ${d.targets?.protein_g ?? '?'} g, carbs ${d.targets?.carb_g ?? '?'} g, fat ${d.targets?.fat_g ?? '?'} g.`);
  lines.push(`Floor (never go under): ${p.anchor.floor} kcal. Rules' anchor: ${p.anchor.to} kcal (10% or 150 off, whichever is less).`);
  lines.push('');
  lines.push(`Food, the 28 days before today, newest first. Today is not over, so it is left out (${f.nutrition?.days_logged_14d ?? 0} of the 14 days before today logged, ${f.nutrition?.on_target_days_14d ?? 0} of them within 10% of target):`);
  for (const r of completeFood(d, f.as_of ?? d.as_of ?? '', 28)) lines.push(`  ${r.day}  ${r.kcal} kcal  ${r.protein_g ?? '?'} g protein`);
  lines.push('');
  lines.push(`Weight, last 28 days, newest first (14-day trend ${p.anchor.slope_14d ?? '?'} kg/week):`);
  for (const r of (d.weight ?? []).slice(0, 28)) lines.push(`  ${r.day}  ${r.kg} kg`);
  lines.push('');
  const changes = d.target_changes ?? [];
  lines.push(changes.length === 0
    ? 'Calorie target changes on record: none.'
    : `Calorie target changes on record, newest first (last one ${d.days_since_target_change ?? '?'} days ago):`);
  for (const c of changes) lines.push(`  ${c.at.slice(0, 10)}  ${c.from ?? '?'} -> ${c.to ?? '?'}  by ${c.source}`);
  lines.push('');
  const mem = p.memory ?? [];
  lines.push(mem.length === 0 ? 'Past cards: none.' : 'Past cards, newest first:');
  for (const m of mem) lines.push(`  ${m.week_start}  ${m.kind}/${m.topic}  ${m.status}${m.summary ? `  "${m.summary}"` : ''}`);
  lines.push('');
  lines.push(`Training: ${f.training?.sessions_14d ?? '?'} sessions in 14 days against ${f.training?.planned_14d ?? '?'} planned.`);
  return lines.join('\n');
}

export interface ModelAnswer {
  tool: 'propose_targets' | 'hold' | 'none';
  input: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number };
  latency_ms: number;
  error?: string;
}

/** One call, one tool. A transport or shape failure is `none`, which the caller treats as a hold. */
export async function askCaloriesModel(
  pack: CaloriePack,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  model: string = DRONA_CARD_MODEL,
): Promise<ModelAnswer> {
  const started = Date.now();
  const empty = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: CALORIE_SYSTEM,
        tools: CALORIE_TOOLS,
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: caloriePrompt(pack) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { tool: 'none', input: {}, usage: empty, latency_ms: Date.now() - started, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const data = await res.json();
    const u = data?.usage ?? {};
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    };
    const block = (data?.content ?? []).find((b: { type?: string }) => b?.type === 'tool_use');
    if (!block || (block.name !== 'propose_targets' && block.name !== 'hold')) {
      return { tool: 'none', input: {}, usage, latency_ms: Date.now() - started, error: 'no tool call' };
    }
    return { tool: block.name, input: block.input ?? {}, usage, latency_ms: Date.now() - started };
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    return { tool: 'none', input: {}, usage: empty, latency_ms: Date.now() - started, error: aborted ? 'timeout' : String(e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
