/**
 * Does widening the grounding catalog cost latency?
 *
 * PR #66 grounds onboarding against EXERCISE_LIBRARY: 46 names, ~185 tokens.
 * The real global catalog is 787 rows, ~5150 tokens. Claiming "input is cheap"
 * is an assertion until measured, and there are two ways it could be wrong:
 *
 *   1) PREFILL — 5k extra input tokens might push TTFT up materially.
 *      Note the catalog rides in the USER MESSAGE (PR #66's design), and
 *      buildSystemPrompt only sets cache breakpoints on the system blocks,
 *      so those tokens are UNCACHED on every single call.
 *   2) OUTPUT — more options might make the model emit more, and output is
 *      the only thing that actually drives wall clock (16.35ms/token).
 *
 * Arm 3 tests the mitigation for (1): same 787 names, but moved into a cached
 * system block so they cost prefill once and are near free afterwards.
 *
 * Run:
 *   npx tsx tools/plan-eval/probe-catalog.ts
 *   REPS=5 CASE=onb-hypertrophy-6d-advanced npx tsx tools/plan-eval/probe-catalog.ts
 */
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from '../../supabase/functions/ai-coach/prompt';
import { EXERCISE_LIBRARY } from '../../lib/exercises';
import { buildOnboardingMessage } from './pipeline';
import { CASES } from './cases';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (existsSync(join(ROOT, '.env.local'))) {
  for (const raw of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 1) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const KEY = process.env.ANTHROPIC_API_KEY!;
const REPS = parseInt(process.env.REPS ?? '3', 10);
const CASE_ID = process.env.CASE ?? 'onb-strength-4d-intermediate';
const c: any = CASES.find((x: any) => x.id === CASE_ID);
if (!c) { console.error(`unknown case ${CASE_ID}`); process.exit(1); }

interface M { ttft: number; total: number; outTok: number; inUncached: number; cacheRead: number; cacheWrite: number }

async function measure(payload: Record<string, unknown>): Promise<M | null> {
  const started = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  if (!r.ok) { console.log(`  HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return null; }
  const reader = r.body!.getReader(); const dec = new TextDecoder();
  let buf = '', ttft = 0, outTok = 0, inUncached = 0, cacheRead = 0, cacheWrite = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    if (!ttft) ttft = Date.now() - started;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
    for (const p of parts) {
      let data = ''; for (const l of p.split('\n')) if (l.startsWith('data:')) data += l.replace(/^data:\s?/, '');
      if (!data) continue; let e: any; try { e = JSON.parse(data); } catch { continue; }
      if (e.type === 'message_start') {
        const u = e.message?.usage ?? {};
        inUncached += u.input_tokens ?? 0;
        cacheRead += u.cache_read_input_tokens ?? 0;
        cacheWrite += u.cache_creation_input_tokens ?? 0;
      } else if (e.type === 'message_delta') outTok += e.usage?.output_tokens ?? 0;
    }
  }
  return { ttft, total: Date.now() - started, outTok, inUncached, cacheRead, cacheWrite };
}

async function main() {
  const sb = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!);
  const { data, error } = await sb.from('exercises').select('name').is('created_by', null).limit(2000);
  if (error) { console.error('catalog fetch failed:', error.message); process.exit(1); }
  const full = (data as { name: string }[]).map((r) => r.name);
  const small = EXERCISE_LIBRARY.map((e) => e.name);
  console.log(`case=${CASE_ID}  reps=${REPS}  small=${small.length} names  full=${full.length} names\n`);

  const baseMsg = buildOnboardingMessage(c.intake);
  const swap = (names: string[]) =>
    baseMsg.replace(
      /- Exercise names MUST be copied character-for-character from this catalog, nothing else: [^\n]*/,
      `- Exercise names MUST be copied character-for-character from this catalog, nothing else: ${names.join('; ')}.`,
    );
  // Catalog hoisted out of the user turn into a cached system block.
  const stripped = baseMsg.replace(
    /- Exercise names MUST be copied character-for-character from this catalog, nothing else: [^\n]*/,
    `- Exercise names MUST be copied character-for-character from the <catalog> in the system prompt, nothing else.`,
  );

  const { system, tools } = buildSystemPrompt({ userContext: null, mode: 'generate_plan' });
  const systemWithCatalog = [
    ...(system as any[]),
    { type: 'text', text: `<catalog>\n${full.join('; ')}\n</catalog>`, cache_control: { type: 'ephemeral' } },
  ];

  const arms: [string, Record<string, unknown>][] = [
    [`46 in user msg`, { model: 'claude-sonnet-4-6', max_tokens: 4096, system, tools, messages: [{ role: 'user', content: swap(small) }], tool_choice: { type: 'tool', name: 'generate_plan' } }],
    [`787 in user msg`, { model: 'claude-sonnet-4-6', max_tokens: 4096, system, tools, messages: [{ role: 'user', content: swap(full) }], tool_choice: { type: 'tool', name: 'generate_plan' } }],
    [`787 cached system`, { model: 'claude-sonnet-4-6', max_tokens: 4096, system: systemWithCatalog, tools, messages: [{ role: 'user', content: stripped }], tool_choice: { type: 'tool', name: 'generate_plan' } }],
  ];

  for (const [label, payload] of arms) {
    const ms: M[] = [];
    for (let i = 0; i < REPS; i++) { const m = await measure(payload); if (m) ms.push(m); }
    if (!ms.length) { console.log(`${label}: all runs failed`); continue; }
    const avg = (f: (m: M) => number) => ms.reduce((a, m) => a + f(m), 0) / ms.length;
    // Drop run 1 from the TTFT average: it pays the cache write for this arm.
    const warm = ms.slice(1).length ? ms.slice(1) : ms;
    const warmTtft = warm.reduce((a, m) => a + m.ttft, 0) / warm.length;
    console.log(
      `${label.padEnd(19)} ttft cold=${Math.round(ms[0].ttft)}ms warm=${Math.round(warmTtft)}ms  ` +
      `total=${(avg((m) => m.total) / 1000).toFixed(1)}s  outTok=${Math.round(avg((m) => m.outTok))}  ` +
      `| in: uncached=${Math.round(avg((m) => m.inUncached))} cacheRead=${Math.round(avg((m) => m.cacheRead))} cacheWrite=${Math.round(avg((m) => m.cacheWrite))}`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
