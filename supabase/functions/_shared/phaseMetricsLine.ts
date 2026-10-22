/**
 * Drona's one sentence for the week on the Goal screen (coach_program_phases
 * .coach_line), written by the model from the numbers the weekly check just
 * computed. The numbers and the status words are decided in code
 * (phaseMetrics.ts); the model only puts them into one coach sentence.
 *
 * One forced tool call, no retry. A transport failure, a refusal, or a line
 * that does not read as one (cleanLine) leaves the old line in place.
 * `fetchFn` is injectable so an eval can route the call through `claude -p`.
 */
import { cleanLine, formatMetricValue, type MetricKind, type MetricRef, metricLabel, STATUS_LABEL, type MetricStatus } from './phaseMetrics.ts';
import { SONNET_MODEL, sonnetSettings } from './sonnet.ts';

export const COACH_LINE_MODEL = SONNET_MODEL;
const TIMEOUT_MS = 20_000;
const MAX_TOKENS = 400;
const MAX_LINE = 160;

export interface LineMetric {
  kind: MetricKind;
  ref?: MetricRef | null;
  is_hero: boolean;
  unit: string;
  direction: 'up' | 'down' | 'hold';
  start_value: number | null;
  target_value: number;
  current_value: number | null;
  status: MetricStatus;
}

export interface LinePack {
  program_title: string;
  phase_name: string;
  job_text: string | null;
  week_in_phase: number;
  weeks_total: number;
  metrics: LineMetric[];
}

export const COACH_LINE_TOOL = {
  name: 'phase_line',
  description: 'One sentence, at most two, for the top of the user\'s Goal screen this week: where the phase stands on its hero metric and the one supporting target that needs attention, in your own voice, 40 to 160 characters. Name a number only when it is in the facts. No greeting, no promise about next week, no em dashes.',
  input_schema: {
    type: 'object' as const,
    properties: { line: { type: 'string', description: 'The sentence the user reads. 40 to 160 characters.' } },
    required: ['line'],
  },
};

export const COACH_LINE_SYSTEM = `You are Coach Drona, the coach inside OVERLOAD. Direct, knowledgeable, never sycophantic. You write one sentence for the top of the user's Goal screen each week. The status words were decided by the app's rules from the numbers; do not argue with them, explain them in plain words. Call the phase_line tool exactly once. No em dashes.`;

/** User-chosen text (a custom metric's name, an exercise name) made safe for the prompt: one line, capped. */
const MAX_NAME = 60;
export function safeName(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** The facts for the prompt: every number the line may name. */
export function linePrompt(p: LinePack): string {
  const lines = p.metrics.map((m) => {
    const label = safeName(metricLabel(m)) + (m.is_hero ? ' (hero)' : '');
    const unit = m.unit ? ` ${safeName(m.unit).slice(0, 12)}` : '';
    const cur = m.current_value == null ? 'no reading' : `${formatMetricValue(m.kind, m.current_value, m.unit)}${unit}`;
    const start = m.start_value == null ? '' : `, started ${formatMetricValue(m.kind, m.start_value, m.unit)}`;
    return `- ${label}: now ${cur}, target ${formatMetricValue(m.kind, m.target_value, m.unit)}${unit}${start}, ${m.direction}, status ${STATUS_LABEL[m.status]}`;
  });
  return [
    `Program: ${safeName(p.program_title)}. Phase: ${safeName(p.phase_name)}, week ${p.week_in_phase} of ${p.weeks_total}.`,
    p.job_text ? `This phase's job: ${safeName(p.job_text).slice(0, 80)}.` : '',
    `This week's check:`,
    ...lines,
    `Write the line.`,
  ].filter(Boolean).join('\n');
}

export interface LineAnswer {
  line: string | null;
  error?: string;
}

/** One call. Null line on any failure, so the caller keeps the old one. */
export async function askCoachLine(
  pack: LinePack,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  model: string = COACH_LINE_MODEL,
): Promise<LineAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: COACH_LINE_SYSTEM,
        tools: [COACH_LINE_TOOL],
        ...sonnetSettings(model),
        messages: [{ role: 'user', content: linePrompt(pack) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { line: null, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    if (data?.stop_reason === 'max_tokens') return { line: null, error: 'max_tokens' };
    const block = (data?.content ?? []).find((b: { type?: string; name?: string }) => b?.type === 'tool_use' && b?.name === 'phase_line');
    if (!block) return { line: null, error: data?.stop_reason === 'refusal' ? 'refusal' : 'no tool call' };
    const line = cleanLine(block.input?.line, MAX_LINE);
    return line ? { line } : { line: null, error: 'line did not read as one' };
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    return { line: null, error: aborted ? 'timeout' : String(e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
