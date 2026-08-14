/**
 * AI Coach eval harness. For each prompt in prompts.json:
 *   1. Replicate the coach pipeline locally (retrieval + Anthropic + tool loop)
 *   2. Capture the response text + tool calls + citations
 *   3. Send everything to Claude Opus as judge with the rubric, get structured score
 *   4. Aggregate into a markdown report
 *
 * Bypasses the edge function deliberately — we test BEHAVIOR (responses to
 * questions), not infrastructure (auth/rate-limit/SSE). The system prompt and
 * tool definitions are IMPORTED from supabase/functions/ai-coach/prompt.ts —
 * the exact builder production runs — so a score here reflects the deployed
 * coach. Do not re-inline them: the previous local copy silently drifted and
 * every report written against it scored a coach that did not exist.
 * Retrieval + the tool loop are still replicated from index.ts.
 *
 * Required env (auto-loaded from .env.local + your shell):
 *   EXPO_PUBLIC_SUPABASE_URL
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_JWT_SECRET    — for signing the eval user's JWT
 *                            Supabase Dashboard -> Settings -> API -> JWT Secret
 *   ANTHROPIC_API_KEY      — for the coach model + the judge
 *   VOYAGE_API_KEY         — for query embeddings during retrieval
 *
 * Re-seed tools/eval/fixtures.sql before a baseline run. Its timestamps are
 * `now() - interval '...'`, so they freeze at seed time and the eval user drifts
 * into training_inactive, which contradicts prompts.json's _user_facts.
 *
 * Run with:
 *   npx tsx tools/eval/run.ts
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildSystemPrompt,
  COACH_TOOLS,
  type ResearchSnippet,
} from '../../supabase/functions/ai-coach/prompt.ts';

// ── Auto-load .env.local ────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = join(HERE, '..', '..', '.env.local');
if (existsSync(ENV_LOCAL)) {
  for (const raw of readFileSync(ENV_LOCAL, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

// COACH_MODEL must track the hardcoded MODEL in supabase/functions/ai-coach/index.ts.
const COACH_MODEL = 'claude-sonnet-4-6';
// claude-opus-4-1-20250805 was retired and 404'd every judge call (whole runs
// scored 0.000). Keep this on a current model.
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-opus-5';
const MAX_TOOL_ITERATIONS = 5;
const RETRIEVAL_TOP_K = 8;
const RETRIEVAL_FLOOR = 0.40;

for (const [k, v] of [
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_ANON_KEY', SUPABASE_ANON_KEY],
  ['SUPABASE_JWT_SECRET', SUPABASE_JWT_SECRET],
  ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY],
  ['VOYAGE_API_KEY', VOYAGE_API_KEY],
]) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// ── HS256 JWT signing (no dep — built-in crypto) ─────────────────────────────
function signJWT(payload: Record<string, unknown>, secret: string): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(payload);
  const data = `${header}.${body}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sig}`;
}

function makeEvalClient(userId: string): SupabaseClient {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJWT({ sub: userId, role: 'authenticated', iat: now, exp: now + 3600 }, SUPABASE_JWT_SECRET!);
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Voyage query embedding ───────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The free Voyage tier is 3 RPM. Without backoff, a full 15-prompt run 429s on
// roughly half the prompts and they silently score with retrieved_research
// empty — which reads as "the coach didn't cite anything" in the report and
// quietly corrupts the citation criteria. Retry instead of degrading.
const VOYAGE_MAX_ATTEMPTS = 5;
const VOYAGE_RETRY_MS = 25_000;
const VOYAGE_TIMEOUT_MS = 30_000;

// Every failure mode here must end in `return null`, never a throw. embedQuery
// is called from runCoach, whose caller treats an exception as a failed EVAL —
// the prompt is recorded as '<eval error>' and scores 0.000. A flaky network or
// a hung socket should cost us retrieval for that prompt, not the whole score.
async function embedQuery(text: string): Promise<number[] | null> {
  for (let attempt = 1; attempt <= VOYAGE_MAX_ATTEMPTS; attempt++) {
    const retryable = attempt < VOYAGE_MAX_ATTEMPTS;
    try {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VOYAGE_API_KEY}` },
        body: JSON.stringify({ input: [text.slice(0, 4000)], model: 'voyage-3', input_type: 'query' }),
        // Without this a stalled request hangs forever and never reaches the
        // retry loop's bound.
        signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = await res.json();
        return data.data?.[0]?.embedding ?? null;
      }
      const body = await res.text().catch(() => '');
      if (res.status === 429 && retryable) {
        process.stdout.write(`(voyage 429, retry ${attempt}/${VOYAGE_MAX_ATTEMPTS - 1} in ${VOYAGE_RETRY_MS / 1000}s) `);
        await sleep(VOYAGE_RETRY_MS);
        continue;
      }
      console.error(`Voyage failed: ${res.status} ${body.slice(0, 200)}`);
      return null;
    } catch (e) {
      // fetch rejects on network error/timeout; res.json() throws on a
      // truncated or non-JSON body. Both are worth one more try.
      if (retryable) {
        process.stdout.write(`(voyage ${String(e).slice(0, 40)}, retry ${attempt}/${VOYAGE_MAX_ATTEMPTS - 1} in ${VOYAGE_RETRY_MS / 1000}s) `);
        await sleep(VOYAGE_RETRY_MS);
        continue;
      }
      console.error(`Voyage threw: ${String(e).slice(0, 200)}`);
      return null;
    }
  }
  return null;
}

// ── Anthropic call ───────────────────────────────────────────────────────────
async function callAnthropic(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return await res.json();
}

// ── System prompt + tools come from prompt.ts (imported above) ──────────────
// Nothing is declared here on purpose. Everything below is eval-only plumbing.

// ── Tool execution ──────────────────────────────────────────────────────────
// The prompt builder decides which tools the model sees; this map decides which
// ones the harness can actually run. TOOL_EXECUTORS is checked against the
// imported COACH_TOOLS at startup so a tool added in production fails loudly
// here instead of silently returning "unknown tool" mid-eval.
const TOOL_EXECUTORS: Record<string, { fn: string; args: (i: any) => Record<string, unknown> }> = {
  coach_get_exercise_history: { fn: 'coach_get_exercise_history', args: (i) => ({ p_exercise_name: String(i.exercise_name ?? ''), p_limit: Number(i.limit ?? 10) }) },
  coach_get_recent_workouts: { fn: 'coach_get_recent_workouts', args: (i) => ({ p_limit: Number(i.limit ?? 10), p_days_back: Number(i.days_back ?? 90) }) },
  coach_get_workout_detail: { fn: 'coach_get_workout_detail', args: (i) => ({ p_workout_id: String(i.workout_id ?? '') }) },
  coach_get_muscle_volume_series: { fn: 'coach_get_muscle_volume_series', args: (i) => ({ p_muscle: String(i.muscle ?? ''), p_weeks: Number(i.weeks ?? 8) }) },
  coach_query_sql: { fn: 'coach_query_sql', args: (i) => ({ p_sql: String(i.sql ?? '') }) },
};

function assertToolCoverage() {
  const missing = COACH_TOOLS.map((t) => t.name).filter((n) => !(n in TOOL_EXECUTORS));
  if (missing.length) {
    console.error(`No executor in tools/eval/run.ts for production tool(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function executeTool(client: SupabaseClient, name: string, input: Record<string, unknown>): Promise<unknown> {
  const t = TOOL_EXECUTORS[name];
  if (!t) return { error: `unknown tool: ${name}` };
  try {
    const { data, error } = await client.rpc(t.fn, t.args(input));
    if (error) return { error: error.message };
    return data ?? null;
  } catch (e) { return { error: String(e) }; }
}

// ── Run one prompt through the coach pipeline ───────────────────────────────
interface CoachRun {
  finalText: string;
  toolCalls: string[];
  retrieved: ResearchSnippet[];
  citations: { n: number; id: string; title: string; year?: number }[];
  // False when the embedding call failed outright, so an empty `retrieved`
  // reads as "retrieval broke" rather than "nothing was topical".
  retrievalOk: boolean;
}

async function runCoach(prompt: { conversation: { role: string; content: string }[] }, client: SupabaseClient): Promise<CoachRun> {
  // 1. user_context
  let userContext: unknown = null;
  try {
    const { data } = await client.rpc('get_user_coach_context');
    userContext = data ?? null;
  } catch {}

  // 2. retrieve research
  // p_user_goal is NOT optional in practice: coach_search_research is
  // overloaded in the live DB (3-arg from 0021, 4-arg from 0026), so a 3-arg
  // call fails with PGRST203 "could not choose the best candidate function"
  // and retrieval silently returns nothing. index.ts always passes 4 args;
  // mirror it. It also drives the Phase 4 goal boost.
  const userGoal: string | null = (() => {
    if (!userContext || typeof userContext !== 'object') return null;
    const profile = (userContext as Record<string, unknown>).profile;
    if (!profile || typeof profile !== 'object') return null;
    const g = (profile as Record<string, unknown>).goal;
    return typeof g === 'string' && g.length > 0 ? g : null;
  })();

  const lastUser = [...prompt.conversation].reverse().find((m) => m.role === 'user');
  let retrieved: ResearchSnippet[] = [];
  let retrievalOk = true;
  if (lastUser?.content) {
    const emb = await embedQuery(lastUser.content);
    if (!emb) retrievalOk = false;
    if (emb) {
      const { data, error } = await client.rpc('coach_search_research', {
        p_query_embedding: JSON.stringify(emb),
        p_top_k: RETRIEVAL_TOP_K,
        p_floor: RETRIEVAL_FLOOR,
        p_user_goal: userGoal,
      });
      if (error) {
        retrievalOk = false;
        console.error(`\n  retrieval RPC error: ${error.message}`);
      }
      if (!error && Array.isArray(data)) {
        retrieved = data.map((r: any) => ({
          id: String(r.id), title: String(r.title),
          authors: Array.isArray(r.authors) ? r.authors : [],
          year: r.year ? Number(r.year) : undefined,
          url: r.url ? String(r.url) : undefined,
          practical_takeaway: String(r.practical_takeaway ?? ''),
          trust_score: r.trust_score ? Number(r.trust_score) : undefined,
        }));
      }
    }
  }

  // 3. tool-use loop — system blocks AND tools come from the production
  // builder, so cache_control, the inactivity branch, WRITING_STYLE and
  // PERSONA_EXAMPLES all match what the edge function sends.
  const { system, tools } = buildSystemPrompt({
    userContext,
    retrievedResearch: retrieved,
    mode: 'chat',
  });
  const conversation: any[] = prompt.conversation.map((m) => ({ role: m.role, content: m.content }));
  let finalText = '';
  const toolCalls: string[] = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const data = await callAnthropic({
      model: COACH_MODEL,
      max_tokens: 1024,
      system, tools,
      messages: conversation,
    });
    const blocks = data.content || [];
    finalText += blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n');

    if (data.stop_reason !== 'tool_use') break;
    const toolUses = blocks.filter((b: any) => b.type === 'tool_use');
    const results = await Promise.all(toolUses.map(async (block: any) => {
      toolCalls.push(block.name);
      const r = await executeTool(client, block.name, block.input ?? {});
      return { type: 'tool_result' as const, tool_use_id: block.id, content: JSON.stringify(r) };
    }));
    conversation.push({ role: 'assistant', content: blocks });
    conversation.push({ role: 'user', content: results });
  }

  // 4. citations
  const refs = new Set<number>();
  for (const m of finalText.matchAll(/\[(\d+)\]/g)) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= retrieved.length) refs.add(n);
  }
  const citations = Array.from(refs).sort((a, b) => a - b).map((n) => {
    const r = retrieved[n - 1];
    return { n, id: r.id, title: r.title, year: r.year };
  });

  return { finalText: finalText.trim(), toolCalls, retrieved, citations, retrievalOk };
}

// ── Judge ───────────────────────────────────────────────────────────────────
interface Judgement {
  criteria: { name: string; status: 'pass' | 'partial' | 'fail'; rationale: string }[];
  overall_score: number;
  notes?: string;
}

async function judge(promptObj: any, run: CoachRun, userFacts: Record<string, string>): Promise<Judgement> {
  const lastQ = promptObj.conversation[promptObj.conversation.length - 1].content;
  const judgePrompt = `You are evaluating an AI fitness coach's response to a user question.

QUESTION: ${lastQ}

USER FACTS (the coach has access to all of this via context/tools):
${Object.entries(userFacts).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

RETRIEVED RESEARCH (numbered as [N] for citation in the response):
${run.retrieved.length === 0
  ? (run.retrievalOk
      ? '(none — retrieval ran but nothing was topical above the score floor)'
      : '(RETRIEVAL FAILED — infrastructure error, not the coach\'s fault. Do not penalize the absence of citations.)')
  : run.retrieved.map((r, i) => `[${i + 1}] ${r.title}${r.year ? ` (${r.year})` : ''}`).join('\n')}

TOOL CALLS THE COACH MADE:
${run.toolCalls.length === 0 ? '(none)' : run.toolCalls.join(', ')}

COACH RESPONSE:
"""
${run.finalText}
"""

CITATIONS USED IN RESPONSE:
${run.citations.length === 0 ? '(none)' : run.citations.map((c) => `[${c.n}] ${c.title}`).join('\n')}

RUBRIC TO EVALUATE:
${promptObj.rubric.map((c: any) => `- ${c.name} (weight ${c.weight}): ${c.description}`).join('\n')}

Score each criterion as pass / partial / fail with a one-sentence rationale.
Compute overall_score = sum(weight × {pass:1.0, partial:0.5, fail:0.0}) / sum(weight). Round to 3 decimals.
Be strict. If a criterion says "must NOT do X" and the response does X, that's fail (not partial).`;

  const data = await callAnthropic({
    model: JUDGE_MODEL,
    max_tokens: 2048,
    tools: [{
      name: 'submit_judgement',
      description: 'Submit your evaluation.',
      input_schema: {
        type: 'object',
        properties: {
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                status: { type: 'string', enum: ['pass', 'partial', 'fail'] },
                rationale: { type: 'string' },
              },
              required: ['name', 'status', 'rationale'],
            },
          },
          overall_score: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['criteria', 'overall_score'],
      },
    }],
    tool_choice: { type: 'tool', name: 'submit_judgement' },
    messages: [{ role: 'user', content: judgePrompt }],
  });
  const block = (data.content as any[]).find((b) => b.type === 'tool_use');
  return block?.input ?? { criteria: [], overall_score: 0, notes: 'judge produced no tool_use' };
}

// ── Markdown report ─────────────────────────────────────────────────────────
// Provenance the report has to carry on its own. A reader who opens the file
// months later sees an August generation date next to judge rationales
// reasoning in mid-May relative terms ("5 days ago"), because _user_facts is
// anchored to whenever fixtures.sql was last seeded. Without this block that
// looks like a corrupt report rather than a known fixture-drift condition.
interface RunProvenance {
  evalUserId: string;
  fixturesStale: boolean;
  userFactsAnchor: string | null;
}

function writeReport(
  results: { id: string; category: string; run: CoachRun; judgement: Judgement }[],
  outDir: string,
  provenance: RunProvenance,
) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(outDir, `results-${ts}.md`);

  const byCategory = new Map<string, { sum: number; count: number }>();
  for (const r of results) {
    const cat = r.category;
    const cur = byCategory.get(cat) ?? { sum: 0, count: 0 };
    cur.sum += r.judgement.overall_score;
    cur.count += 1;
    byCategory.set(cat, cur);
  }
  const overallAvg = results.reduce((s, r) => s + r.judgement.overall_score, 0) / Math.max(results.length, 1);

  let md = `# AI Coach Eval Report\n\nGenerated: ${new Date().toISOString()}\nPrompts: ${results.length}\nJudge: \`${JUDGE_MODEL}\` · Coach: \`${COACH_MODEL}\`\nPrompt: production \`buildSystemPrompt()\` from \`supabase/functions/ai-coach/prompt.ts\` (mode: chat)\n\n`;
  md += `## Fixture provenance\n\n`;
  md += `Eval user: \`${provenance.evalUserId}\`  \n`;
  md += `\`_user_facts\` anchor date: ${provenance.userFactsAnchor ?? '_(not recorded in prompts.json)_'}  \n`;
  md += `Fixture freshness: ${provenance.fixturesStale
    ? '**STALE** — the eval user reads as `training_inactive` (no workout in 14+ days). `fixtures.sql` seeds with `now() - interval`, so its dates froze at seed time. The coach correctly reacts to a long layoff while the judge grades against `_user_facts` claiming recent sessions, so `user_data` scores are understated. Re-seed `fixtures.sql` before treating these as a gate.'
    : 'fresh — the eval user has trained recently, consistent with `_user_facts`.'}\n\n`;
  md += `## Summary\n\n**Overall average score: ${overallAvg.toFixed(3)} / 1.000**\n\n`;
  md += `| Category | Avg | n |\n|---|---|---|\n`;
  for (const [cat, { sum, count }] of byCategory) md += `| ${cat} | ${(sum / count).toFixed(3)} | ${count} |\n`;
  md += `\n---\n\n## Per-prompt detail\n\n`;
  for (const r of results) {
    md += `### ${r.id} (${r.category}) — **${r.judgement.overall_score.toFixed(3)}**\n\n`;
    md += `**Tools:** ${r.run.toolCalls.length === 0 ? '_(none)_' : r.run.toolCalls.join(', ')}  \n`;
    md += `**Citations:** ${r.run.citations.length === 0 ? '_(none)_' : r.run.citations.map((c) => `[${c.n}] ${c.title}`).join('; ')}  \n`;
    if (!r.run.retrievalOk) md += `**⚠️ Retrieval failed for this prompt** — scored without research grounding.  \n`;
    md += `\n`;
    md += `**Response:**\n> ${r.run.finalText.replace(/\n/g, '\n> ')}\n\n`;
    md += `**Rubric scores:**\n`;
    for (const c of r.judgement.criteria) md += `- ${c.status === 'pass' ? '✅' : c.status === 'partial' ? '🟡' : '❌'} **${c.name}** — ${c.rationale}\n`;
    if (r.judgement.notes) md += `\n_Judge notes: ${r.judgement.notes}_\n`;
    md += `\n---\n\n`;
  }

  writeFileSync(path, md);
  console.log(`\nReport written to ${path}`);
  console.log(`Overall: ${overallAvg.toFixed(3)} (n=${results.length})`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const promptsPath = join(HERE, 'prompts.json');
  const promptsFile = JSON.parse(readFileSync(promptsPath, 'utf8'));
  const userId: string = promptsFile._user_id || 'user_eval_alpha';
  const userFacts: Record<string, string> = promptsFile._user_facts || {};

  assertToolCoverage();

  const client = makeEvalClient(userId);

  // fixtures.sql seeds workouts as `now() - interval '5 days'`, which freezes
  // at seed time. Run it long enough ago and the eval user goes
  // training_inactive, the coach (correctly) opens with "you've been out for a
  // while", and the judge marks it a hallucination because prompts.json's
  // _user_facts still claim recent sessions. Scores tank for a reason that has
  // nothing to do with the coach. Warn loudly rather than publish a bad number.
  const staleFixtures = await (async () => {
    try {
      const { data } = await client.rpc('get_user_coach_context');
      return (data as Record<string, unknown> | null)?.training_inactive === true;
    } catch { return false; }
  })();
  if (staleFixtures) {
    console.warn(
      `WARNING: eval user "${userId}" reads as training_inactive (no workout in 14+ days).\n` +
      `         tools/eval/fixtures.sql needs re-seeding, otherwise user_data prompts are\n` +
      `         graded against _user_facts that no longer match the database.\n`,
    );
  }

  console.log(`Eval starting · ${promptsFile.prompts.length} prompts · user: ${userId}\n`);

  const results: { id: string; category: string; run: CoachRun; judgement: Judgement }[] = [];

  for (const [i, prompt] of promptsFile.prompts.entries()) {
    process.stdout.write(`[${i + 1}/${promptsFile.prompts.length}] ${prompt.id} `);
    try {
      const run = await runCoach(prompt, client);
      const judgement = await judge(prompt, run, userFacts);
      results.push({ id: prompt.id, category: prompt.category, run, judgement });
      console.log(`→ ${judgement.overall_score.toFixed(3)}`);
    } catch (e) {
      console.log(`→ ERROR: ${String(e).slice(0, 100)}`);
      results.push({
        id: prompt.id, category: prompt.category,
        run: { finalText: '<eval error>', toolCalls: [], retrieved: [], citations: [], retrievalOk: false },
        judgement: { criteria: [], overall_score: 0, notes: `eval error: ${String(e).slice(0, 200)}` },
      });
    }
  }

  writeReport(results, join(HERE, 'reports'), {
    evalUserId: userId,
    fixturesStale: staleFixtures,
    userFactsAnchor: userFacts.todays_date_for_judge_context ?? null,
  });
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
