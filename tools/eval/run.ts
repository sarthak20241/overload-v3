/**
 * AI Coach eval harness. For each prompt in prompts.json:
 *   1. Replicate the coach pipeline locally (retrieval + Anthropic + tool loop)
 *   2. Capture the response text + tool calls + citations
 *   3. Send everything to Claude Opus as judge with the rubric, get structured score
 *   4. Aggregate into a markdown report
 *
 * Bypasses the edge function deliberately — we test BEHAVIOR (responses to
 * questions), not infrastructure (auth/rate-limit/SSE). Pipeline logic is
 * duplicated here from supabase/functions/ai-coach/{index.ts,prompt.ts};
 * keep them in sync when prompts/tools change.
 *
 * Required env (auto-loaded from .env.local + your shell):
 *   EXPO_PUBLIC_SUPABASE_URL
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_JWT_SECRET    — for signing the eval user's JWT
 *                            Supabase Dashboard -> Settings -> API -> JWT Secret
 *   ANTHROPIC_API_KEY      — for the coach model + the judge
 *   VOYAGE_API_KEY         — for query embeddings during retrieval
 *
 * Run with:
 *   npx tsx tools/eval/run.ts
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const COACH_MODEL = 'claude-sonnet-4-20250514';
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-opus-4-1-20250805';
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
async function embedQuery(text: string): Promise<number[] | null> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VOYAGE_API_KEY}` },
    body: JSON.stringify({ input: [text.slice(0, 4000)], model: 'voyage-3', input_type: 'query' }),
  });
  if (!res.ok) {
    console.error(`Voyage failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return data.data?.[0]?.embedding ?? null;
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

// ── System prompt — DUPLICATED from supabase/functions/ai-coach/prompt.ts ────
// Keep this in sync when the production prompt evolves. Eval scores are only
// meaningful if this matches the deployed prompt.
const ROLE = `You are the AI Coach inside OVERLOAD, a strength and hypertrophy training app. You speak with the directness of an experienced strength coach who happens to read the literature. You help with: programming, exercise selection, recovery, deload decisions, plateau diagnosis, and nutrition fundamentals. You do not provide medical advice.`;

const CORE_PRINCIPLES = `<core_principles>
Hypertrophy
- Effective rep range: ~5–30 reps near failure (RIR 0–3). Sweet spot 6–15 compound / 10–20 isolation.
- Volume: per-muscle weekly hard-set targets (RIR ≤ 3): MV ~10, MEV ~12, MAV ~14–20, MRV ~22–26 trained. Beginners often grow on 4–10.
- Frequency: 2×/muscle/week default. 3–4× fine if recovery permits and volume is matched.
- Proximity to failure: 0–3 RIR. True failure on every set is unnecessary.
- Progression: double progression — add reps until top of range, then add weight.

Strength
- Heavier intensities (≥ 80% 1RM, 1–6 reps) drive maximal strength. Auto-regulate via RPE/RIR. Periodize linear or DUP.

Fat loss
- Preserve lean mass during deficit: keep intensity, reduce volume 10–20%. Protein 1.6–2.4 g/kg. Deficit 10–25% maintenance.

Conditioning
- Polarized: ~80% Zone 2 / ~20% high-intensity. VO2max intervals 3–8min 1–2×/week. Separate lower-body lift and run by 6+ hours.

Recovery / deload
- Deload triggers: e1RM regressing 2+ weeks, sleep <6h, joint pain, mid-session degradation. Deload = ~50% volume, same intensity.
- Sleep is the highest-leverage recovery variable.
- Rest: 2–3 min compound hypertrophy, 3–5 min strength, 60–90s isolation.

Exercise selection
- Compounds (squat, bench, deadlift, OHP, row, pull-up) form the strength backbone. For hypertrophy, prioritize best stimulus-to-fatigue ratio per muscle.
- Substitute on equipment, mobility, or pain — not on novelty.
</core_principles>`;

const DATA_SCHEMA = `<data_schema>
Read-only access to the user's training data via tools. Schema for the SQL escape valve:

- workouts(id, user_id, routine_id, name, started_at, finished_at, duration_seconds, total_volume_kg)
- workout_sets(id, workout_id, exercise_id, weight_kg, reps, completed, "order")
- exercises(id, name, muscle_group, category)
- routines(id, user_id, name, description, color, created_at)
- routine_exercises(routine_id, exercise_id, sets, reps_min, reps_max, rest_seconds, "order")
- user_profiles(clerk_user_id, name, gender, height_cm, weight_kg, goal, experience_level, training_age_months, date_of_birth, weekly_target_sessions, level, xp, streak)
- user_lift_stats(user_id, exercise_id, exercise_name, muscle_group, estimated_1rm, top_set_weight, top_set_reps, last_set_weight, last_set_reps, last_performed_at, sessions_last_28d)
- user_volume_stats(user_id, muscle_group, week_start, total_volume_kg, set_count)

All rows are filtered to the calling user by RLS.
</data_schema>`;

const ANSWER_POLICY = `<answer_policy>
Data access — tier preference:
1. user_context first.
2. Typed tool for specific rows (coach_get_exercise_history, coach_get_recent_workouts, coach_get_workout_detail, coach_get_muscle_volume_series).
3. coach_query_sql only when no typed tool fits.

Research grounding:
- If <retrieved_research> is present and topical, ground claims in those entries and cite each by its [N] number inline. Example: "4 sessions/week is sufficient [2]."
- If <retrieved_research> is absent or off-topic, fall back to core_principles and say so plainly. Don't invent citations.
- Place [N] markers right after the claim they support: "...within 1–3 reps of failure [3]."

Style:
- Markdown. Bold numbers. Bullet lists.
- Cite the user's actual data (PR, volume trend, experience). Don't fabricate.
- Distinguish evidence-based from common-practice.
- Respect user autonomy. NEVER call user choices 'excessive', 'counterproductive', 'wrong', or 'bad'. When the user proposes something outside common ranges, present the evidence + tradeoff in 2-3 sentences then let them decide. Avoid prescriptive openers like 'You shouldn't' or 'X is too much'. Lead with what the research shows, not with judgment.
- No medical advice.
- Keep prose tight.
</answer_policy>`;

const COACH_TOOLS = [
  { name: 'coach_get_exercise_history', description: 'Get the most recent completed sets for a specific exercise.', input_schema: { type: 'object', properties: { exercise_name: { type: 'string', description: 'Exact name e.g. "Bench Press".' }, limit: { type: 'integer', description: 'Default 10, max 50.' } }, required: ['exercise_name'] } },
  { name: 'coach_get_recent_workouts', description: 'List recent finished workouts (headers only).', input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'Default 10, max 50.' }, days_back: { type: 'integer', description: 'Default 90.' } } } },
  { name: 'coach_get_workout_detail', description: 'Get the full set list for one specific workout, by UUID.', input_schema: { type: 'object', properties: { workout_id: { type: 'string', description: 'UUID of the workout.' } }, required: ['workout_id'] } },
  { name: 'coach_get_muscle_volume_series', description: 'Weekly volume for a muscle group across recent weeks.', input_schema: { type: 'object', properties: { muscle: { type: 'string', description: 'e.g. "Chest", "Back".' }, weeks: { type: 'integer', description: 'Default 8.' } }, required: ['muscle'] } },
  { name: 'coach_query_sql', description: 'Read-only SQL escape valve. Use only when no typed tool fits.', input_schema: { type: 'object', properties: { sql: { type: 'string', description: 'SELECT or WITH only. No semicolons, no comments.' } }, required: ['sql'] } },
];

interface ResearchEntry {
  id: string; title: string; authors: string[]; year?: number; url?: string;
  practical_takeaway: string; trust_score?: number;
}

function buildSystemBlocks(userContext: unknown, retrievedResearch: ResearchEntry[]) {
  const userContextBlock = userContext
    ? `<user_context>\n${JSON.stringify(userContext, null, 2)}\n</user_context>`
    : `<user_context>No personalized data available.</user_context>`;
  const blocks: any[] = [
    { type: 'text', text: `<role>${ROLE}</role>\n\n${CORE_PRINCIPLES}\n\n${DATA_SCHEMA}\n\n${ANSWER_POLICY}` },
    { type: 'text', text: userContextBlock },
  ];
  if (retrievedResearch.length > 0) {
    const research = retrievedResearch.map((r, i) => {
      const cite = `[${i + 1}] ${r.title}${r.year ? ` (${r.year})` : ''} — ${r.authors.join(', ')}`;
      return `${cite}\n  ${r.practical_takeaway}${r.url ? `\n  ${r.url}` : ''}`;
    }).join('\n\n');
    blocks.push({ type: 'text', text: `<retrieved_research>\n${research}\n</retrieved_research>` });
  }
  return blocks;
}

// ── Tool execution ──────────────────────────────────────────────────────────
async function executeTool(client: SupabaseClient, name: string, input: Record<string, unknown>): Promise<unknown> {
  const map: Record<string, { fn: string; args: (i: any) => Record<string, unknown> }> = {
    coach_get_exercise_history: { fn: 'coach_get_exercise_history', args: (i) => ({ p_exercise_name: String(i.exercise_name ?? ''), p_limit: Number(i.limit ?? 10) }) },
    coach_get_recent_workouts: { fn: 'coach_get_recent_workouts', args: (i) => ({ p_limit: Number(i.limit ?? 10), p_days_back: Number(i.days_back ?? 90) }) },
    coach_get_workout_detail: { fn: 'coach_get_workout_detail', args: (i) => ({ p_workout_id: String(i.workout_id ?? '') }) },
    coach_get_muscle_volume_series: { fn: 'coach_get_muscle_volume_series', args: (i) => ({ p_muscle: String(i.muscle ?? ''), p_weeks: Number(i.weeks ?? 8) }) },
    coach_query_sql: { fn: 'coach_query_sql', args: (i) => ({ p_sql: String(i.sql ?? '') }) },
  };
  const t = map[name];
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
  retrieved: ResearchEntry[];
  citations: { n: number; id: string; title: string; year?: number }[];
}

async function runCoach(prompt: { conversation: { role: string; content: string }[] }, client: SupabaseClient): Promise<CoachRun> {
  // 1. user_context
  let userContext: unknown = null;
  try {
    const { data } = await client.rpc('get_user_coach_context');
    userContext = data ?? null;
  } catch {}

  // 2. retrieve research
  const lastUser = [...prompt.conversation].reverse().find((m) => m.role === 'user');
  let retrieved: ResearchEntry[] = [];
  if (lastUser?.content) {
    const emb = await embedQuery(lastUser.content);
    if (emb) {
      const { data, error } = await client.rpc('coach_search_research', {
        p_query_embedding: JSON.stringify(emb),
        p_top_k: RETRIEVAL_TOP_K,
        p_floor: RETRIEVAL_FLOOR,
      });
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

  // 3. tool-use loop
  const system = buildSystemBlocks(userContext, retrieved);
  const conversation: any[] = prompt.conversation.map((m) => ({ role: m.role, content: m.content }));
  let finalText = '';
  const toolCalls: string[] = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const data = await callAnthropic({
      model: COACH_MODEL,
      max_tokens: 1024,
      system, tools: COACH_TOOLS,
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

  return { finalText: finalText.trim(), toolCalls, retrieved, citations };
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
${run.retrieved.length === 0 ? '(none — retrieval was off-topic or empty)' : run.retrieved.map((r, i) => `[${i + 1}] ${r.title}${r.year ? ` (${r.year})` : ''}`).join('\n')}

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
function writeReport(results: { id: string; category: string; run: CoachRun; judgement: Judgement }[], outDir: string) {
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

  let md = `# AI Coach Eval Report\n\nGenerated: ${new Date().toISOString()}\nPrompts: ${results.length}\nJudge: \`${JUDGE_MODEL}\` · Coach: \`${COACH_MODEL}\`\n\n`;
  md += `## Summary\n\n**Overall average score: ${overallAvg.toFixed(3)} / 1.000**\n\n`;
  md += `| Category | Avg | n |\n|---|---|---|\n`;
  for (const [cat, { sum, count }] of byCategory) md += `| ${cat} | ${(sum / count).toFixed(3)} | ${count} |\n`;
  md += `\n---\n\n## Per-prompt detail\n\n`;
  for (const r of results) {
    md += `### ${r.id} (${r.category}) — **${r.judgement.overall_score.toFixed(3)}**\n\n`;
    md += `**Tools:** ${r.run.toolCalls.length === 0 ? '_(none)_' : r.run.toolCalls.join(', ')}  \n`;
    md += `**Citations:** ${r.run.citations.length === 0 ? '_(none)_' : r.run.citations.map((c) => `[${c.n}] ${c.title}`).join('; ')}  \n\n`;
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

  const client = makeEvalClient(userId);
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
        run: { finalText: '<eval error>', toolCalls: [], retrieved: [], citations: [] },
        judgement: { criteria: [], overall_score: 0, notes: `eval error: ${String(e).slice(0, 200)}` },
      });
    }
  }

  writeReport(results, join(HERE, 'reports'));
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
