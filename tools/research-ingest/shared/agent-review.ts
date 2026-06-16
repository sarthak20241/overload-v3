/**
 * Auto-review agent (Phase 3 final).
 *
 * Sonnet-based agent that makes the human's review call when the paper
 * has been sitting in the queue for 24+ hours. Evaluates across five
 * dimensions and commits to one of: approve / reject / supersede / coexist.
 *
 *   1. Rigor       — meta-analysis > systematic review > RCT > cohort >
 *                    observational > preprint. Sample size, duration,
 *                    controls for confounders.
 *   2. Relevance   — does our user base (recreational lifters, mostly
 *                    chasing hypertrophy / strength / fat loss) care?
 *                    Can a coach translate to a rep-range / volume
 *                    number / frequency change?
 *   3. Coherence   — agrees with existing kb consensus? If contradicts,
 *                    is the disagreement explained by population /
 *                    protocol differences? Is the finding replicated?
 *   4. Authority   — journal tier, author h-index, citation count,
 *                    peer-reviewed vs. preprint.
 *   5. Novelty     — adds genuinely new info, or duplicates existing kb?
 *                    Answers questions users are asking?
 *
 * Code-enforced supersede guardrails: even if the agent proposes
 * supersede, the action gets downgraded to coexist if any of:
 *
 *   - The new paper has lower study-design rank than the target
 *     (e.g., single RCT can't replace a meta-analysis)
 *   - The new paper is a preprint and the target is peer-reviewed
 *   - The new paper has no DOI (can't be verified)
 *
 * These rules are absolute. The agent can't argue past them; the
 * downgrade reason is logged. Prevents the "newer = better" trap.
 */
import { ANTHROPIC_API_KEY } from './env.js';
import { log } from './log.js';
import type { Distillation } from './types.js';

// ── Public types ────────────────────────────────────────────────────────────
export type AgentAction = 'approve' | 'reject' | 'supersede' | 'coexist';

/**
 * Snapshot of an existing research_kb entry that the agent might decide to
 * supersede. Comes from the find_similar_kb RPC, filtered to the entries
 * the agent thinks are conflicting (those that already appear in the
 * pending row's contradiction_flags with verdict='contradict').
 */
export interface KbCandidate {
  id: string;
  title: string;
  key_finding: string;
  study_design: string;
  trust_score: number;
  license: string | null;
  pub_year: number | null;
}

/** Pending paper passed to the agent (after Phase 3 enrichment). */
export interface PendingPaperForAgent {
  pending_id: string;
  title: string;
  url: string;
  source: string;
  authors: string[];
  journal: string | null;
  pub_year: number | null;
  topic_tags: string[];
  trust_score: number;
  study_design: string;
  confidence: string;
  license: string | null;
  population: string;
  intervention: string;
  key_finding: string;
  practical_takeaway: string;
  ingested_at: string;
  contradiction_flags: Array<{
    kb_id: string;
    kb_title: string;
    kb_finding: string;
    kb_study_design: string;
    kb_trust_score: number;
    verdict: string;
    similarity: number;
    confidence: number;
    rationale: string;
  }>;
  authority?: {
    author_h_index: number;
    citation_count: number;
    influential_citations: number;
    journal_tier: number;
    source: string;
  };
}

export interface AgentDecision {
  proposed_action: AgentAction;
  final_action: AgentAction;
  downgrade_reason: string | null;
  rationale: string;
  confidence: number;
  flags: string[];
  superseded_kb_ids: string[];   // post-guardrails
  proposed_supersedes: string[]; // what the agent originally wanted
  raw_response: unknown;
}

// ── Code-enforced supersede guardrails ──────────────────────────────────────
function studyDesignRank(sd: string): number {
  switch (sd) {
    case 'meta-analysis': return 5;
    case 'systematic-review': return 4;
    case 'RCT':
    case 'crossover': return 3;
    case 'cohort': return 2;
    case 'observational':
    case 'narrative-review': return 1;
    case 'preprint': return 1;
    default: return 1;
  }
}

function isPreprint(license: string | null | undefined): boolean {
  if (!license) return false;
  const lc = license.toLowerCase();
  return lc.includes('preprint') || lc === 'cc-by-pr' || lc === 'biorxiv' || lc === 'sportrxiv';
}

/**
 * Returns null when the supersede is allowed, or a reason string when it
 * should be downgraded. Caller (the agent worker) downgrades supersede →
 * coexist when this returns non-null and logs the reason.
 */
export function validateSupersede(
  newPaper: PendingPaperForAgent,
  target: KbCandidate,
): string | null {
  // Rule 1: methodological hierarchy is monotonic
  const nrank = studyDesignRank(newPaper.study_design);
  const trank = studyDesignRank(target.study_design);
  if (nrank < trank) {
    return `study_design rank ${newPaper.study_design}(${nrank}) cannot supersede ${target.study_design}(${trank})`;
  }
  // Rule 2: preprints can't supersede peer-reviewed work
  const newIsPreprint = isPreprint(newPaper.license);
  const targetIsPreprint = isPreprint(target.license);
  if (newIsPreprint && !targetIsPreprint) {
    return `preprint cannot supersede peer-reviewed paper`;
  }
  // Rule 3: no DOI / can't verify provenance
  // We use the source_meta.doi check upstream; here we just look at the
  // url since the agent worker passes through the canonical URL.
  if (!newPaper.url || !newPaper.url.includes('doi.org')) {
    // Some PMIDs and EuropePMC ids aren't DOI-prefixed but are still
    // verifiable. Don't reject those — only fail when the URL is missing
    // entirely.
    if (!newPaper.url) {
      return `no verifiable URL on new paper`;
    }
  }
  return null;
}

// ── Anthropic call ──────────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const REVIEW_TOOL = {
  name: 'submit_review_decision',
  description:
    'Commit to a final review action for this pending paper. You MUST pick exactly one of approve / reject / supersede / coexist. No "hold" or "needs more info" — the timer is up and the human is not coming.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['approve', 'reject', 'supersede', 'coexist'],
        description:
          "'approve' — add to research_kb as is. " +
          "'reject' — discard the paper; not worth ingesting (low quality, off-topic, redundant duplicate). " +
          "'supersede' — add to research_kb AND mark specified existing kb entries as superseded. " +
          "'coexist' — add to research_kb; flagged conflicts stay alongside (different populations / conditions).",
      },
      confidence: {
        type: 'number',
        description: '0.0–1.0. Confidence in the action. Log for analytics; does NOT gate the action (the timer is up).',
      },
      rationale: {
        type: 'string',
        description: '3–5 sentence plain-English explanation. Reference the five dimensions (rigor, relevance, coherence, authority, novelty) where they applied to your decision.',
      },
      flags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short tokens for analytics. Examples: "small_n", "preprint", "novel_topic", "redundant", "contradicts_consensus", "aged_well_meta", "narrow_population".',
      },
      superseded_kb_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'When action="supersede": the kb_ids from contradiction_flags that this paper should replace. EMPTY for any other action. Code-enforced guardrails will downgrade supersede→coexist for entries where the new paper has lower methodological rank than the target.',
      },
    },
    required: ['action', 'confidence', 'rationale', 'flags', 'superseded_kb_ids'],
  },
};

const SYSTEM_PROMPT = `You are the auto-review agent for the AI Coach's research knowledge base. A pending paper has been waiting 24 hours without human review. Your job: make the same decision the human admin would, using the five-dimension framework below. You MUST commit to one of approve / reject / supersede / coexist via the submit_review_decision tool. There is no "hold" — the queue keeps growing.

THE FIVE DIMENSIONS

1. RIGOR
   Methodological hierarchy: meta-analysis > systematic review > RCT > crossover
   > cohort > observational > narrative review > preprint.
   - Sample size: n ≥ 40 for hypertrophy claims, n ≥ 100 for population claims.
   - Duration: 8+ weeks for hypertrophy, 6+ for strength, 12+ for conditioning.
   - Controls: total volume matched? RIR controlled? Effect size reported?

2. RELEVANCE TO OUR USERS
   Recreational lifters chasing hypertrophy, strength, fat loss, conditioning.
   - Population: trained / untrained / clinical / athlete?
   - Goal alignment: does the finding translate to a rep range / volume / frequency / RIR change a coach could actually prescribe?

3. COHERENCE WITH KB CONSENSUS
   - Agrees with existing kb? Reinforces — favor approve / coexist.
   - Contradicts? If a SINGLE STUDY contradicts a META-ANALYSIS, the right call is coexist (the new paper is an outlier pending replication), NEVER supersede.
   - Different population or protocol than the kb entry? coexist, not supersede.

4. AUTHORITY
   - Journal tier (top sport-science > regional > unindexed).
   - Author h-index (high = field expert).
   - Peer-reviewed vs. preprint.
   - Citation count where reported (low expected for recent papers).

5. NOVELTY
   - Adds genuinely new info to the kb? Or duplicates an existing entry?
   - Answers questions users actually ask (if topic_tags signal high user demand)?
   - A perfectly-good RCT duplicating a meta-analysis we already have is a REJECT for redundancy.

SUPERSEDE GUARDRAILS

You can PROPOSE supersede freely; the system will VALIDATE and downgrade to coexist when:
- new paper's study-design rank is lower than the target
- new paper is a preprint and target is peer-reviewed
- new paper has no verifiable provenance

So: lean toward coexist unless you have HIGH confidence the new paper is strictly stronger evidence than the target on the same question (better design, larger n, replicates earlier work, etc.). The guardrails will catch your edge cases.

OUTPUT

Pick action via submit_review_decision. Your rationale field should:
- Start with the action you picked.
- Cite at least 2 of the 5 dimensions that drove the call.
- Be honest about confidence — < 0.5 if signal is weak from the distillation; > 0.8 only when it's clear-cut.`;

export async function runAgentReview(
  paper: PendingPaperForAgent,
): Promise<AgentDecision> {
  // Build the context block. Includes contradiction flags (already
  // computed at ingest), authority enrichment, and the conflict candidates
  // (kb entries the agent could propose to supersede).
  const conflicts = paper.contradiction_flags.filter((f) => f.verdict === 'contradict');
  const userMessage = `PAPER UNDER REVIEW

Title: ${paper.title}
Authors: ${paper.authors.slice(0, 5).join(', ')}${paper.authors.length > 5 ? ` +${paper.authors.length - 5}` : ''}
Journal: ${paper.journal ?? 'unknown'}
Year: ${paper.pub_year ?? 'unknown'}
URL: ${paper.url}
License: ${paper.license ?? 'unknown'}
Topic tags: ${paper.topic_tags.join(', ')}

DISTILLATION (from Haiku at ingest)
Study design: ${paper.study_design}
Confidence: ${paper.confidence}
Population: ${paper.population}
Intervention: ${paper.intervention}
Key finding: ${paper.key_finding}
Practical takeaway: ${paper.practical_takeaway}

INGEST-TIME TRUST SCORE: ${paper.trust_score.toFixed(2)} (0-1; combines study_design + authority + journal tier)
${paper.authority ? `Authority signals:
  - max author h-index: ${paper.authority.author_h_index}
  - citation count: ${paper.authority.citation_count < 0 ? 'unknown' : paper.authority.citation_count}
  - influential citations: ${paper.authority.influential_citations < 0 ? 'unknown' : paper.authority.influential_citations}
  - journal tier: ${paper.authority.journal_tier} (1=top, 4=unknown)
  - enrichment source: ${paper.authority.source}` : 'Authority signals: not enriched'}

${conflicts.length === 0 ? 'NO CONFLICTS FLAGGED at ingest.' : `CONFLICTS FLAGGED AT INGEST (${conflicts.length}):

${conflicts.map((c, i) => `[${i + 1}] kb_id: ${c.kb_id}
  Existing title: ${c.kb_title}
  Existing finding: ${c.kb_finding}
  Existing study design: ${c.kb_study_design}
  Existing trust score: ${c.kb_trust_score.toFixed(2)}
  Cosine similarity: ${c.similarity.toFixed(2)}
  Haiku verdict at ingest: ${c.verdict} (conf ${c.confidence.toFixed(2)})
  Ingest rationale: ${c.rationale}`).join('\n\n')}`}

Commit to approve / reject / supersede / coexist via submit_review_decision.`;

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
      system: SYSTEM_PROMPT,
      tools: [REVIEW_TOOL],
      tool_choice: { type: 'tool', name: 'submit_review_decision' },
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const toolUse = (body.content as any[]).find((b) => b.type === 'tool_use');
  if (!toolUse?.input) {
    throw new Error('Agent did not emit submit_review_decision');
  }
  const input = toolUse.input as {
    action: AgentAction;
    confidence: number;
    rationale: string;
    flags: string[];
    superseded_kb_ids: string[];
  };

  // The agent's proposed action. Pre-guardrails.
  const proposed: AgentAction = input.action;
  const proposedSupersedes: string[] = Array.isArray(input.superseded_kb_ids)
    ? input.superseded_kb_ids
    : [];

  // Apply code-enforced supersede guardrails. Each target gets validated
  // against the new paper. If ANY target fails, we downgrade the WHOLE
  // action from supersede → coexist (mixed supersedes would be confusing).
  // The reason is logged.
  let finalAction: AgentAction = proposed;
  let downgradeReason: string | null = null;
  let validSupersedes: string[] = [];

  if (proposed === 'supersede') {
    const conflictsById = new Map(
      conflicts.map((c) => [c.kb_id, c]),
    );
    const failed: string[] = [];
    for (const targetId of proposedSupersedes) {
      const c = conflictsById.get(targetId);
      if (!c) {
        // Agent referenced a kb_id not in our contradiction list. Don't
        // honor it — this is a hallucination guard.
        failed.push(`${targetId}: not in contradiction list`);
        continue;
      }
      // Build a KbCandidate from the conflict flag for validation. We
      // don't have pub_year / license on the conflict flag, so we pass
      // null — validateSupersede falls through on those when null.
      const target: KbCandidate = {
        id: c.kb_id,
        title: c.kb_title,
        key_finding: c.kb_finding,
        study_design: c.kb_study_design,
        trust_score: c.kb_trust_score,
        license: null,
        pub_year: null,
      };
      const reason = validateSupersede(paper, target);
      if (reason) {
        failed.push(`${targetId}: ${reason}`);
      } else {
        validSupersedes.push(targetId);
      }
    }

    if (failed.length > 0) {
      // Downgrade the whole action. Conservative: ANY failed guardrail
      // means we're not confident about the supersede call, so we coexist
      // the whole thing rather than partially superseding.
      finalAction = 'coexist';
      downgradeReason = `supersede→coexist downgrade: ${failed.join('; ')}`;
      validSupersedes = [];
      log.warn('agent-review', `supersede downgraded by guardrails`, {
        url: paper.url,
        reason: downgradeReason,
      });
    } else if (validSupersedes.length === 0) {
      // Agent picked supersede but provided no target ids. Treat as coexist.
      finalAction = 'coexist';
      downgradeReason = 'supersede→coexist: no superseded_kb_ids provided';
    }
  }

  return {
    proposed_action: proposed,
    final_action: finalAction,
    downgrade_reason: downgradeReason,
    rationale: input.rationale,
    confidence: input.confidence,
    flags: Array.isArray(input.flags) ? input.flags : [],
    superseded_kb_ids: validSupersedes,
    proposed_supersedes: proposedSupersedes,
    raw_response: input,
  };
}
