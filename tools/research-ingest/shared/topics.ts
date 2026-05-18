/**
 * Topic-driven fetch planner.
 *
 * Phase 3 upgrade over the firehose: instead of fetching whatever Europe
 * PMC's broad query returns, we look at what users have actually been
 * asking the coach (from coach_traces) and target our fetch at:
 *
 *   user_need (40%) — clusters with the most user questions
 *   gap       (40%) — clusters where retrieval returned nothing or weak
 *   trending  (20%) — fallback broad query for "what's new in general"
 *
 * One Haiku 4.5 clustering call per run, ~$0.005. The output is a
 * TopicPlan that the orchestrator iterates: each item carries the
 * Europe PMC search phrases for that topic plus the paper budget.
 *
 * The `bucket` + `label` tags are attached to each ingested paper via
 * source_meta so the dashboard can show "imported as gap-fill for
 * deload timing" alongside the paper.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ANTHROPIC_API_KEY } from './env.js';
import { log } from './log.js';

// ── Public types ────────────────────────────────────────────────────────────
export type IngestBucket = 'user_need' | 'gap' | 'trending';

export interface TopicPlanItem {
  bucket: IngestBucket;
  /** Human-readable, e.g. "deload timing" or "training frequency for women". */
  label: string;
  /**
   * Multi-word phrases suitable for the source's title/abstract search.
   * Empty for the 'trending' item — the source uses its default disjunction.
   */
  queryTerms: string[];
  /** How many papers to pull for this topic. */
  budget: number;
  /** Audit string captured in the orchestrator log. */
  rationale: string;
}

export interface TopicPlan {
  items: TopicPlanItem[];
  totalBudget: number;
  generatedAt: string;
  /** How many recent traces fed the clustering. */
  traceSampleSize: number;
}

// ── Trace shape used by the planner ─────────────────────────────────────────
interface Trace {
  message: string;
  retrievedCount: number;     // length of retrieved_doc_ids
  retrievalOk: boolean;       // status was 'ok' or 'no_matches'
  status: string | null;      // raw retrieval_status for logging
}

// ── Anthropic helpers ───────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

const CLUSTER_TOOL = {
  name: 'submit_topic_clusters',
  description:
    'Cluster these user questions into 6–12 topical buckets. Some clusters will be ABOUT TRAINING SCIENCE (research-applicable) and some will be META-CONVERSATION (asking the coach for clarification, looking up past workouts, etc., which have no corresponding research topic). Flag every cluster accordingly.',
  input_schema: {
    type: 'object' as const,
    properties: {
      clusters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Short topic label, 2–5 words, in plain English. Examples: "deload timing", "training to failure", "rep range for hypertrophy".',
            },
            sample_question_indices: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Indices (0-based) of the questions from the input list that fall in this cluster. Include EVERY question that belongs here.',
            },
            research_applicable: {
              type: 'boolean',
              description: 'TRUE if a peer-reviewed paper could plausibly answer the questions in this cluster (e.g. "what rep range maximizes hypertrophy?"). FALSE for meta-conversation: requests to look up the user\'s own history, clarifications about the coach itself, conversational chitchat, asking the AI to generate a workout, etc. — those have no underlying research topic. Be strict: when in doubt, FALSE.',
            },
            search_phrases: {
              type: 'array',
              items: { type: 'string' },
              description: '3–5 multi-word phrases that would appear VERBATIM in the title or abstract of a sport-science paper on this topic. Pretend you\'re searching PubMed: use the exact terminology a scientist would use, NOT casual gym-speak. Examples of GOOD phrases: "deload week", "resistance training to failure", "muscle damage markers", "RPE-based load prescription". Examples of BAD phrases (too generic, match unrelated medical papers): "performance assessment", "training adaptation", "exercise prescription", "personal records". Each phrase ≥ 2 words. Leave empty if research_applicable is false.',
            },
          },
          required: ['label', 'sample_question_indices', 'research_applicable', 'search_phrases'],
        },
      },
    },
    required: ['clusters'],
  },
};

interface RawCluster {
  label: string;
  sample_question_indices: number[];
  research_applicable: boolean;
  search_phrases: string[];
}

async function clusterQuestionsViaHaiku(questions: string[]): Promise<RawCluster[]> {
  if (questions.length === 0) return [];
  const userMsg = `Here are recent user questions for the strength-coach AI. Cluster them into 6–12 topical buckets.

${questions.map((q, i) => `[${i}] ${q.replace(/\n+/g, ' ').slice(0, 240)}`).join('\n')}

Emit clusters via submit_topic_clusters. Every question must appear in exactly one cluster's sample_question_indices.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      tools: [CLUSTER_TOOL],
      tool_choice: { type: 'tool', name: 'submit_topic_clusters' },
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Haiku clustering ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const toolUse = (body.content as any[]).find((b) => b.type === 'tool_use');
  if (!toolUse?.input?.clusters) {
    throw new Error('Haiku did not emit submit_topic_clusters');
  }
  return toolUse.input.clusters as RawCluster[];
}

// ── Trace fetch ─────────────────────────────────────────────────────────────
async function fetchRecentTraces(
  client: SupabaseClient,
  limit: number,
): Promise<Trace[]> {
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('coach_traces')
    .select('last_user_message_preview, retrieved_doc_ids, retrieval_status, status')
    .gte('request_at', sinceIso)
    .eq('status', 'success')
    .not('last_user_message_preview', 'is', null)
    .order('request_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`fetchRecentTraces: ${error.message}`);
  const rows = data ?? [];
  return rows
    .map((r: any): Trace => ({
      message: String(r.last_user_message_preview ?? '').trim(),
      retrievedCount: Array.isArray(r.retrieved_doc_ids) ? r.retrieved_doc_ids.length : 0,
      retrievalOk: r.retrieval_status === 'ok' || r.retrieval_status === 'no_matches',
      status: r.retrieval_status,
    }))
    .filter((t) => t.message.length >= 10); // drop trivially short messages
}

// ── Plan construction ──────────────────────────────────────────────────────
/**
 * Compute a "gap score" for a cluster:
 *   weighted average of (1 - retrievedStrength) across the cluster's traces
 *
 * retrievedStrength:
 *   no_matches              → 0.0
 *   1-2 retrieved doc ids   → 0.4
 *   3-5                     → 0.7
 *   6+                      → 1.0
 *
 * High gap score = many user questions on this topic, retrieval was weak.
 * Top-K of these become the 'gap' bucket items.
 */
function strengthOfTrace(t: Trace): number {
  if (!t.retrievalOk) return 0;
  if (t.retrievedCount === 0) return 0;
  if (t.retrievedCount <= 2) return 0.4;
  if (t.retrievedCount <= 5) return 0.7;
  return 1.0;
}

function clusterMetrics(cluster: RawCluster, allTraces: Trace[]) {
  const traces = cluster.sample_question_indices
    .filter((i) => i >= 0 && i < allTraces.length)
    .map((i) => allTraces[i]);
  const count = traces.length;
  const avgStrength = count === 0
    ? 1.0
    : traces.reduce((acc, t) => acc + strengthOfTrace(t), 0) / count;
  const gapScore = count * (1 - avgStrength);
  return { count, avgStrength, gapScore };
}

function dedupeKeepingFirst<T extends { label: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = item.label.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function buildTopicPlan(
  client: SupabaseClient,
  opts: { totalBudget: number; traceLimit?: number },
): Promise<TopicPlan> {
  const traceLimit = opts.traceLimit ?? 100;
  const traces = await fetchRecentTraces(client, traceLimit);

  // Fallback: no traces yet (fresh deploy). Use 100% trending — the default
  // broad query — so the cron still has work to do.
  if (traces.length === 0) {
    log.info('topics', 'no recent traces — using 100% trending bucket');
    return {
      items: [{
        bucket: 'trending',
        label: 'broad query (no user traces yet)',
        queryTerms: [],
        budget: opts.totalBudget,
        rationale: 'cold-start: no coach_traces in the last 30 days',
      }],
      totalBudget: opts.totalBudget,
      generatedAt: new Date().toISOString(),
      traceSampleSize: 0,
    };
  }

  log.info('topics', `clustering ${traces.length} recent user questions`);

  let clusters: RawCluster[] = [];
  try {
    clusters = await clusterQuestionsViaHaiku(traces.map((t) => t.message));
  } catch (e) {
    log.warn('topics', `clustering failed; falling back to trending-only`, { error: String(e).slice(0, 200) });
    return {
      items: [{
        bucket: 'trending',
        label: 'broad query (clustering failed)',
        queryTerms: [],
        budget: opts.totalBudget,
        rationale: `clustering call failed: ${String(e).slice(0, 100)}`,
      }],
      totalBudget: opts.totalBudget,
      generatedAt: new Date().toISOString(),
      traceSampleSize: traces.length,
    };
  }

  // Filter then score every cluster, then split into bucket lists.
  //
  //   1. research_applicable=false → drop. Haiku flagged these as meta-
  //      conversation (clarifications, looking up history, etc.). No paper
  //      answers "what was my last bench set" — that's coach data, not
  //      research. Saves Haiku spend on bogus query results.
  //   2. <2 search_phrases → drop. Even research-applicable clusters need a
  //      minimum number of phrases to OR together in the search query.
  //   3. count===0 → drop. Haiku assigned no questions to this cluster.
  const dropped = clusters.filter((c) => c.research_applicable === false);
  if (dropped.length > 0) {
    log.info('topics', `dropped ${dropped.length} non-research clusters`, {
      labels: dropped.map((c) => c.label),
    });
  }
  const scored = clusters
    .filter((c) => c.research_applicable !== false)
    .filter((c) => c.search_phrases && c.search_phrases.length >= 2)
    .map((c) => ({ raw: c, ...clusterMetrics(c, traces) }))
    .filter((c) => c.count > 0);

  // user_need: top-by-question-count
  const userNeedRanked = [...scored]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // gap: top-by-gap-score, EXCLUDING anything already in userNeedRanked so
  // the same cluster doesn't eat both buckets. (If a topic is both frequent
  // AND has weak retrieval, user_need wins — we get the papers either way.)
  const userNeedLabels = new Set(userNeedRanked.map((c) => c.raw.label.toLowerCase().trim()));
  const gapRanked = [...scored]
    .filter((c) => !userNeedLabels.has(c.raw.label.toLowerCase().trim()))
    .sort((a, b) => b.gapScore - a.gapScore)
    .filter((c) => c.gapScore > 0)
    .slice(0, 5);

  // Budget allocation: 40/40/20.
  const userNeedBudget = Math.max(1, Math.floor(opts.totalBudget * 0.4));
  const gapBudget = Math.max(1, Math.floor(opts.totalBudget * 0.4));
  const trendingBudget = Math.max(1, opts.totalBudget - userNeedBudget - gapBudget);

  // Per-topic split: divide bucket budget across topics in that bucket.
  // If we have N topics with budget B, each gets ceil(B/N) capped so the
  // sum doesn't exceed B.
  function allocate(topics: typeof scored, totalForBucket: number): number[] {
    if (topics.length === 0) return [];
    const each = Math.max(1, Math.floor(totalForBucket / topics.length));
    const out = new Array(topics.length).fill(each);
    let remaining = totalForBucket - each * topics.length;
    let i = 0;
    while (remaining > 0) {
      out[i % topics.length] += 1;
      remaining -= 1;
      i += 1;
    }
    return out;
  }

  const userNeedBudgets = allocate(userNeedRanked, userNeedBudget);
  const gapBudgets = allocate(gapRanked, gapBudget);

  const items: TopicPlanItem[] = [];

  userNeedRanked.forEach((c, i) => {
    items.push({
      bucket: 'user_need',
      label: c.raw.label,
      queryTerms: c.raw.search_phrases,
      budget: userNeedBudgets[i] ?? 1,
      rationale: `${c.count} user questions; avg retrieval strength ${c.avgStrength.toFixed(2)}`,
    });
  });

  gapRanked.forEach((c, i) => {
    items.push({
      bucket: 'gap',
      label: c.raw.label,
      queryTerms: c.raw.search_phrases,
      budget: gapBudgets[i] ?? 1,
      rationale: `${c.count} user questions, weak retrieval (strength ${c.avgStrength.toFixed(2)})`,
    });
  });

  // If neither user_need nor gap produced anything (e.g. all clusters had 0
  // questions due to a parsing edge case), pour those budgets into trending.
  const userNeedActual = userNeedRanked.length > 0 ? userNeedBudget : 0;
  const gapActual = gapRanked.length > 0 ? gapBudget : 0;
  const trendingFinalBudget = opts.totalBudget - userNeedActual - gapActual;
  if (trendingFinalBudget > 0) {
    items.push({
      bucket: 'trending',
      label: 'broad query (latest research)',
      queryTerms: [],
      budget: trendingFinalBudget,
      rationale: '20% allocation for fresh papers regardless of topic',
    });
  }

  return {
    items: dedupeKeepingFirst(items),
    totalBudget: opts.totalBudget,
    generatedAt: new Date().toISOString(),
    traceSampleSize: traces.length,
  };
}
