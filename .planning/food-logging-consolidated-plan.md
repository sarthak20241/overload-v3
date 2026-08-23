# Food Logging: Consolidated Plan (tiers + exploration improvements)

Status: ACTIVE (2026-08-23). This file owns the SEQUENCE. The evidence lives in
food-logging-tiers-plan.md (measurements, benchmarks, full reasoning per item);
item IDs (I1-I17, P0-P6) refer to that file. Do not duplicate reasoning here.

## Where we are

SHIPPED + DEPLOYED on branch claude/eggs-amul-milk-macros-c94f42 (pushed, NOT
merged to main):
- P0 guardrail fixes: id retarget, row-name display, variant chips, both
  caption bugs (bare-unit quantity, estimate-line gate)
- P1 ranking layer: migration 0102 live (rank_boost + popularity + user history)
- P2 Voyage reranker: live, fail-open, margin + topScore logged
- FatSecret source: OAuth 1.0, Basic key (US data), v1 search + food.get.v4
- OFF self-heal (15% drift band)
- P3 code-fill: built, running in SHADOW (PARSE_SKIP_DECIDE=shadow), n=2 so far

NOT STARTED: Fast / Smart / Super as user-facing modes.
NEVER RUN: the eval baseline. 88 cases exist; no baseline number is recorded.

CLOSED (do not reopen):
- I4 prompt cache dead on Haiku 4.5 (4096-token minimum, ours ~1.5k). Accepted.
- Guardrail parallelization: measured 20 microseconds per meal. A no-op.
- I5 is the same thing as P3; tracked as P3 below.

## Sequencing principle

1. Merge + baseline first. Nothing ships un-evaled again.
2. Deterministic code fixes next: no prompts touched, low risk, high value.
3. Prompt and extract quality, each change gated by eval before/after.
4. Mode SEMANTICS: what the modes mean (I15 + I14, P3 flip, I12 prereqs).
5. The modes themselves, then features on top.

Why this order: Fast and Super are thin wrappers once the quality substrate is
right. Building them first would bake today's extract and matching bugs into
three pipelines instead of one.

## The sequence

### Step 0. Merge to main  [USER DECISION]
Branch is 27+ commits ahead and its code is already DEPLOYED to ai-coach, so
main currently lies about production (the coach-retrieval drift mistake).
Merge before new work, or accept the drift consciously.

### Step 1. Eval baseline (I2)  - THE GATE
Run the full 88-case suite once. Record pass/fail per case and per tag in
scripts/parse-meal-eval/ (a BASELINE.md or json). audit-* and accept-* cases
are EXPECTED to fail; they are gates for later steps. The suite is flaky
(~4 cases drift per run): judge any change by rerunning its failures, never by
one full-suite number. Every later step reruns its relevant tags against this.

### Step 2. Deterministic code fixes (no prompt changes)
- I17: wordsOverlap fuzzy match -> proportional Damerau-Levenshtein,
  distance / shorter-word length <= ~0.2. Settled with user; benchmark 11/11.
  Unit tests from the 11-pair table in the tiers plan.
- I16: delete/rewrite the stale hedged-web-lookup comments. While in there,
  recover WHY the pre-card web race was dropped; that answer feeds Super.
- I7: strict tool use on extract (verify Haiku 4.5 supports strict first).
  Kills the string-"250"-sanitizes-to-1 class.
Gate: eval no-regression on the full suite + new unit tests green.

### Step 3. Extract and decide quality (prompt work, each eval-gated)
In order:
1. I6 extract holes (user named this the first work item): deletion contract,
   challenge+fix drops the fix, correction+addition undefined, multi-meal
   collapse, mentioned-food-logs-as-eaten. Gates: audit-* cases.
2. I11 + I11b: define "acceptable candidate" in decide (commodity vs
   formulated taxonomy). MEASURE the grounded->estimate flip rate on real
   traces before shipping; thin Indian branded coverage makes this the risk.
   Gates: accept-* cases, both directions.
3. I13: one staples list in decide context. 14-day window, >= 2 occurrences,
   frequency-ranked with ~7d-half-life recency decay, "name (N times, usually
   X ml)" format. Degrade gracefully under 14d of history.
4. I1: corrections re-resolve CHANGED lines only; keepUncoveredPrevious
   restores the rest verbatim. Doubt => re-resolve.
5. I3: prompt reorganization LAST, once the content above is settled.

### Step 4. Mode semantics
- I15 + I14 SHIP TOGETHER: kill the post-card web refine (kickWebRefine,
  web_refine field, refineMeal, the "checking trusted sources" card state) and
  add the challenge affordance on low-confidence lines in the same release.
  Once the automatic path is gone, the manual path is the only recovery route.
- P3 flip shadow -> on. Criteria unchanged: 50+ shadow parses, > 95%
  same_macros, zero cases where code fill grounds an item decide refused.
  Shadow data accumulates passively during steps 1-3; check the counter here.
- I12 prerequisites: move meal_type assignment to code, make the drona line
  async/template. The actual per-item parallel decide flip can ride with Step 5
  (it IS Fast/Smart latency work).

### Step 5. The modes (P4, P5)
- P4 Fast: mode param + toggle UI + persisted pref. Fused extract+estimate
  call, catalog+OFF only (1.5s budget), code pick, template line. p50 ~2.7s.
- P5 Super: web search INSIDE the resolve fan-out, 2-source 10% cross-check
  badge, Sonnet decide with disagreements in-prompt, precise cache
  write-through, challenge flow reroutes here, credit gate. p50 <= 12s.
- Smart is what Steps 1-4 already made the default pipeline.

### Step 6. Features on top
- I8 full-day logging (meal type per item end to end; gate audit-multi-meal-day).
- I10 personalized household units (learn per-user katori/bowl/glass weights
  from edit history; spoons stay physics).

## Parallel / external tracks (not on the critical path)
- P6 FatSecret Premier: awaiting their reply (asked US+India+UK+EU,
  2026-08-21). On grant: set region, retest the milky-mist case at tier 2.
- INDB (Anuvaad): confirm license, then batch-ingest as source='indb'.
- Rerank vendor eval (Voyage vs Cohere) on parse_traces, open since P2.
- food_log_stats / commonality refresh cadence.

## Standing gates for every step
- Eval: rerun the step's tagged cases + a full-suite sanity pass.
- Deploy: edge function deploys are cheap; client changes ride releases.
- Invariant: every number the user sees is source-grounded or carries the
  estimate chip. No silent model arithmetic. No bulk-copying licensed rows.
