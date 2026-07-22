/**
 * Throwaway experiment: forced tool_use vs plain-text JSON, same task.
 *
 * Two questions:
 *  1) DELIVERY — does tool JSON arrive in a final burst while text streams
 *     smoothly? Decides whether progressive rendering is even possible.
 *  2) THROUGHPUT — is constrained tool decoding slower per token than free
 *     text? If so, the output format itself is a latency lever.
 *
 * Reports "50% by X%": what fraction of wall clock had elapsed once half the
 * payload had arrived. 50% is smooth, 100% means it all landed at the end.
 */
import { buildSystemPrompt } from '../../supabase/functions/ai-coach/prompt';
import { buildOnboardingMessage } from './pipeline';
import { CASES } from './cases';

const KEY = process.env.ANTHROPIC_API_KEY!;
const REPS = parseInt(process.env.REPS ?? '3', 10);
const c: any = CASES.find((x: any) => x.id === 'onb-fatloss-4d-beginner');

interface M { total: number; chars: number; outTok: number; half: number; maxGap: number }

async function measure(payload: Record<string, unknown>): Promise<M | null> {
  const started = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  if (!r.ok) { console.log(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`); return null; }
  const reader = r.body!.getReader(); const dec = new TextDecoder();
  let buf = ''; let chars = 0; let outTok = 0;
  const marks: { t: number; chars: number }[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
    for (const p of parts) {
      let data = ''; for (const l of p.split('\n')) if (l.startsWith('data:')) data += l.replace(/^data:\s?/, '');
      if (!data) continue; let e: any; try { e = JSON.parse(data); } catch { continue; }
      if (e.type === 'content_block_delta') {
        const piece = e.delta?.text ?? e.delta?.partial_json;
        if (typeof piece === 'string') { chars += piece.length; marks.push({ t: Date.now() - started, chars }); }
      } else if (e.type === 'message_delta') outTok += e.usage?.output_tokens ?? 0;
    }
  }
  const total = Date.now() - started;
  if (!marks.length) return null;
  const halfMark = marks.find((m) => m.chars >= chars / 2)?.t ?? total;
  const gaps = marks.slice(1).map((m, i) => m.t - marks[i].t);
  return { total, chars, outTok, half: halfMark / total, maxGap: Math.max(...gaps) };
}

async function main() {
  const { system, tools } = buildSystemPrompt({ userContext: null, mode: 'generate_plan' });
  const msg = buildOnboardingMessage(c.intake);
  const textMsg = `${msg}\n\nEmit the plan as a raw JSON object with keys name, split_type, days_per_week, rationale, workouts[]. Each workout: name, note, exercises[] of {name, sets, reps, rest_seconds}. Output ONLY the JSON, no code fence, no commentary.`;

  const variants: [string, Record<string, unknown>][] = [
    ['tool_use (prod)', { model: 'claude-sonnet-4-6', max_tokens: 4096, system, tools, messages: [{ role: 'user', content: msg }], tool_choice: { type: 'tool', name: 'generate_plan' } }],
    ['plain text json', { model: 'claude-sonnet-4-6', max_tokens: 4096, system, messages: [{ role: 'user', content: textMsg }] }],
  ];

  for (const [label, payload] of variants) {
    const ms: M[] = [];
    for (let i = 0; i < REPS; i++) { const m = await measure(payload); if (m) ms.push(m); }
    if (!ms.length) { console.log(`${label}: all runs failed`); continue; }
    const avg = (f: (m: M) => number) => ms.reduce((a, m) => a + f(m), 0) / ms.length;
    const tps = avg((m) => m.outTok) / (avg((m) => m.total) / 1000);
    console.log(
      `${label.padEnd(16)} n=${ms.length}  total=${(avg((m) => m.total) / 1000).toFixed(1)}s  ` +
      `outTok=${Math.round(avg((m) => m.outTok))}  ${tps.toFixed(0)} tok/s  ` +
      `| 50% of payload by ${(avg((m) => m.half) * 100).toFixed(0)}% of wall clock  ` +
      `| max gap ${Math.round(avg((m) => m.maxGap))}ms`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
