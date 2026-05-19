/**
 * Contradiction detection (Phase 3).
 *
 * Runs at ingest, between Voyage embedding and insertPending. For each new
 * paper:
 *   1. pgvector cosine-search research_kb for top-K semantically similar
 *      entries via the find_similar_kb RPC
 *   2. For each match above a "same topic area" floor, ask Haiku to
 *      judge whether the two findings actually contradict, agree, describe
 *      different conditions, or are unrelated
 *   3. Keep only 'contradict' and 'different_conditions' verdicts as flags
 *      ('agree' and 'unrelated' are noise — agreement means the new paper
 *      reinforces existing kb, no surprise; unrelated means topic-area
 *      similarity was a false-positive)
 *
 * Output goes into research_kb_pending.contradiction_flags (jsonb). The
 * dashboard surfaces these to the human reviewer before they hit Approve.
 *
 * Cost: 0 extra Voyage calls (reuses the HyDE embedding we already have).
 * 0–3 extra Haiku calls per paper (typically 0–1 — most ingests are on
 * new topics with no semantic neighbors above the floor).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ANTHROPIC_API_KEY } from './env.js';
import { log } from './log.js';
import type { Paper, Distillation } from './types.js';

// ── Public types ────────────────────────────────────────────────────────────
export type ContradictionVerdict =
  | 'contradict'
  | 'agree'
  | 'different_conditions'
  | 'unrelated';

export interface ContradictionFlag {
  kb_id: string;
  kb_title: string;
  kb_finding: string;
  kb_study_design: string;
  kb_trust_score: number;
  similarity: number;
  verdict: ContradictionVerdict;
  confidence: number;
  rationale: string;
}

// ── Tuning ──────────────────────────────────────────────────────────────────
// Above this similarity, the two papers are likely in the same topic area
// and worth Haiku-comparing. Below, they're different topics — comparing
// would be noise + wasted tokens.
const TOPIC_AREA_FLOOR = 0.60;
// How many top neighbors to check. More = better coverage but more Haiku
// calls. 3 is enough — if there are >3 neighbors above the floor, the
// topic is well-covered already and we'd be comparing against similar
// findings repeatedly.
const TOP_K_NEIGHBORS = 3;

// ── Anthropic helper ────────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

const VERDICT_TOOL = {
  name: 'submit_contradiction_verdict',
  description:
    'Compare these two key findings from exercise-science papers and decide their relationship.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdict: {
        type: 'string',
        enum: ['contradict', 'agree', 'different_conditions', 'unrelated'],
        description:
          "'contradict' = the findings disagree on the same question. " +
          "'agree' = the findings reinforce each other on the same question. " +
          "'different_conditions' = both findings can be true; they describe different populations / protocols / conditions (e.g. trained vs untrained, high-vs-low volume). " +
          "'unrelated' = the papers happen to share keywords but actually address different questions.",
      },
      confidence: {
        type: 'number',
        description: '0.0–1.0. How confident are you in this verdict? Use < 0.6 when the abstracts give you weak signal.',
      },
      rationale: {
        type: 'string',
        description: '1–2 sentence plain-English explanation. Cite the specific claim each paper makes.',
      },
    },
    required: ['verdict', 'confidence', 'rationale'],
  },
};

const SYSTEM_PROMPT = `You are evaluating whether two strength-and-conditioning research findings contradict each other. You are NOT being asked which one is right — only what the relationship is. Be specific in your rationale: cite the exact claim each paper makes.

Key distinction:
  - "contradict" requires that both papers address the SAME question and reach OPPOSING conclusions. E.g. one says "training to failure beats stopping short for hypertrophy", the other says "RIR 2 matches RIR 0 for hypertrophy" — contradict.
  - "different_conditions" applies when both could be simultaneously true. E.g. one finds 2x/week and 3x/week equivalent in TRAINED lifters, another finds frequency matters more in UNTRAINED — different conditions.
  - "agree" requires findings that reinforce each other on the same question.
  - "unrelated" when the topical similarity was misleading and the papers answer different questions.

Be honest about confidence. If you can't tell from the distilled findings, say confidence < 0.6.`;

async function judgePair(
  newPaper: Paper,
  newDist: Distillation,
  kbFinding: string,
  kbTitle: string,
): Promise<{ verdict: ContradictionVerdict; confidence: number; rationale: string }> {
  const userMessage = `New paper:
  Title: ${newPaper.title}
  Key finding: ${newDist.key_finding}
  Practical takeaway: ${newDist.practical_takeaway}
  Study design: ${newDist.study_design}

Existing kb entry:
  Title: ${kbTitle}
  Key finding: ${kbFinding}

Decide via submit_contradiction_verdict whether these contradict, agree, describe different conditions, or are unrelated.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_contradiction_verdict' },
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const toolUse = (body.content as any[]).find((b) => b.type === 'tool_use');
  if (!toolUse?.input) {
    throw new Error('Haiku did not emit submit_contradiction_verdict');
  }
  const input = toolUse.input as {
    verdict: ContradictionVerdict;
    confidence: number;
    rationale: string;
  };
  return {
    verdict: input.verdict,
    confidence: Number(input.confidence ?? 0),
    rationale: String(input.rationale ?? ''),
  };
}

// ── Public entry point ──────────────────────────────────────────────────────
/**
 * Find contradictions between a new paper and existing research_kb entries.
 * Returns an empty array when:
 *   - No neighbors clear the topic-area floor (paper is on a new topic)
 *   - All neighbors are judged 'agree' or 'unrelated' (no conflict to flag)
 *   - find_similar_kb RPC fails (logged; non-fatal — we'd rather ingest
 *     without contradiction flags than block on a single transient error)
 *
 * `embedding` is the HyDE passage embedding we already computed for the
 * plagiarism guard. Reused here to avoid another Voyage call.
 */
export async function findConflicts(
  client: SupabaseClient,
  paper: Paper,
  dist: Distillation,
  embedding: number[],
): Promise<ContradictionFlag[]> {
  let neighbors: Array<{
    id: string; title: string; key_finding: string; practical_takeaway: string;
    study_design: string; confidence: string; trust_score: number; similarity: number;
  }> = [];
  try {
    const { data, error } = await client.rpc('find_similar_kb', {
      p_query_embedding: JSON.stringify(embedding),
      p_top_k: TOP_K_NEIGHBORS,
      p_floor: TOPIC_AREA_FLOOR,
    });
    if (error) {
      log.warn('contradictions', `find_similar_kb failed: ${error.message}`, { url: paper.url });
      return [];
    }
    neighbors = (data ?? []).map((r: any) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      key_finding: String(r.key_finding ?? ''),
      practical_takeaway: String(r.practical_takeaway ?? ''),
      study_design: String(r.study_design ?? ''),
      confidence: String(r.confidence ?? ''),
      trust_score: Number(r.trust_score ?? 0),
      similarity: Number(r.similarity ?? 0),
    }));
  } catch (e) {
    log.warn('contradictions', `find_similar_kb threw`, { error: String(e).slice(0, 200) });
    return [];
  }

  if (neighbors.length === 0) {
    return []; // new topic, nothing to compare against
  }

  log.info('contradictions', `${neighbors.length} neighbors above floor; judging via Haiku`, {
    url: paper.url,
    top_similarity: neighbors[0].similarity.toFixed(3),
  });

  const flags: ContradictionFlag[] = [];
  for (const n of neighbors) {
    let verdict: { verdict: ContradictionVerdict; confidence: number; rationale: string };
    try {
      verdict = await judgePair(paper, dist, n.key_finding, n.title);
    } catch (e) {
      log.warn('contradictions', `Haiku verdict failed; skipping this pair`, {
        kb_id: n.id,
        error: String(e).slice(0, 200),
      });
      continue;
    }
    // Keep only flags that matter to the human reviewer:
    //  - 'contradict' is the headline case
    //  - 'different_conditions' is worth surfacing because the reviewer might
    //     want to add scope qualifiers to the kb entry
    // 'agree' and 'unrelated' are noise.
    if (verdict.verdict === 'agree' || verdict.verdict === 'unrelated') continue;
    flags.push({
      kb_id: n.id,
      kb_title: n.title,
      kb_finding: n.key_finding,
      kb_study_design: n.study_design,
      kb_trust_score: n.trust_score,
      similarity: n.similarity,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
    });
  }

  if (flags.length > 0) {
    log.info('contradictions', `${flags.length} flag(s) generated`, {
      url: paper.url,
      verdicts: flags.map((f) => f.verdict),
    });
  }
  return flags;
}
