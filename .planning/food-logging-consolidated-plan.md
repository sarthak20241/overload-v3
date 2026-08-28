# Food Logging: Master Build & Test Plan

Status: ACTIVE v2 (2026-08-23). This file owns the sequence, the build tasks,
and the test gates. The evidence record stays in food-logging-tiers-plan.md
(all IDs I1-I17 and P0-P6 refer there; do not duplicate reasoning here).

## Where we are

SHIPPED + DEPLOYED on branch claude/eggs-amul-milk-macros-c94f42 (pushed, NOT
merged to main):
- P0 guardrail fixes (id retarget, row-name display, variant chips, both
  caption bugs), P1 ranking layer (migration 0103 live (renumbered from 0102 at merge; main took 0102)), P2 Voyage reranker,
  FatSecret source (OAuth 1.0, Basic/US), OFF self-heal.
- P3 code-fill built, in SHADOW (PARSE_SKIP_DECIDE=shadow), n=2 so far.

NOT STARTED: Fast / Smart / Super as user-facing modes.
NEVER RUN: the eval baseline. 88 cases exist, no baseline number recorded.

CLOSED (do not reopen): I4 prompt cache dead on Haiku 4.5 (accepted);
guardrail parallelization (measured 20 microseconds, a no-op); I5 = P3.

## Locked design decisions (2026-08-23, with user)

1. Modes are USER-FACING: Smart default, Fast a choice, Super credit-gated.
2. ONE SSE transport + ONE event vocabulary for all three modes:
   item (row appears, shimmer macros) / fill (macros land, chips) /
   progress (source status lines) / drona (coach line) / end (totals, seals).
   The progressive card is built ONCE and must tolerate out-of-order fills;
   totals recompute per fill until end seals them.
   SSE LIFECYCLE CONTRACT (settled 2026-08-23; the client cannot be written
   without it, and "out-of-order fills" + "never mutates after render" only
   coexist because of these rules):
   - Every event carries item_id: a STABLE server-assigned id minted when the
     item is EXTRACTED (Lane A: input index; Lane B: line ordinal). Not the
     food name, which changes when a row is picked; not food_id, which is null
     until then.
   - Every per-item event carries a monotonic rev. A fill whose rev is <= the
     rendered rev is DROPPED. That makes reordered and duplicated fills safe
     without the client keeping history.
   - At most ONE applied fill per item. "Never mutates after render" means:
     after end, nothing changes. Before end an item goes shimmer -> filled
     exactly once, which is filling, not mutating.
   - The Drona line is its OWN event and must arrive before or with end. If it
     is not ready when the pipeline finishes, end ships the template line and
     any late async line is DISCARDED - it never rewrites a sealed card. This
     is the I15 rule applied to our own stream.
   - end carries the authoritative totals and final item list; the client
     reconciles to it. Add stays DISABLED until end, so a user can never tap
     Add on numbers still in flight (the exact I15 complaint).
   - Streams are single-use: a dropped connection re-requests the parse rather
     than resuming, so "replay" only ever means duplicate events inside one
     stream.
3. Fast = two lanes over ONE shared backend (search -> code pick -> fill).
   - Lane A (zero-LLM naming): grammar (qty+unit+food) or user-staple match.
     HEDGE: a small Haiku estimate call fires in PARALLEL with every Lane A
     search; grounded -> discarded, miss -> fills at ~1.3s with the chip.
   - Lane B (streaming): Haiku extract WITHOUT forced tool (forced tool does
     not stream, measured); NDJSON one item per line; each completed line
     paints the row, fires that item's search, holds qty/unit for conversion.
   - Fast excludes decide, reranker (~400ms/item + 429 risk), FatSecret
     (~4s cold cache), web. Corrections -> Smart, challenge -> Super,
     malformed stream -> silent Smart fallback.
   - REJECTED: the old fused extract+estimate call (estimates fatten output;
     output tokens ARE the latency; forced tools do not stream).
4. acceptCandidate(userWords, row): ONE shared pure gate used by Lane A,
   Lane B, and the P3 skip-decide path.
   DESIGN CONSTRAINTS found while diagnosing paneer-roti (2026-08-23):
   - It compares the EXTRACTED name, not the user's raw text. Extract already
     normalises regional terms (its system prompt corrects spelling and maps
     chai -> milk tea), and audit-hindi-doodh passes today because extract
     turns "doodh" into "milk". So the synonym burden is much smaller than a
     raw-text gate would carry - but it is not zero, and a small synonym
     safety net (doodh/dahi/chawal) belongs in the gate, per the I11b
     droppable list.
   - Word coverage is the check that catches the WORST failures, because a
     missing catalog row does not degrade to an estimate, it degrades to a
     DIFFERENT FOOD: "paneer bhurji" -> Bhujia, a fried snack at 609 kcal.
     "paneer" appears nowhere in "Bhujia", so coverage rejects it and the line
     falls to a labelled estimate that is roughly right.
   - Therefore coverage is NOT merely a Fast-mode component. PROPOSED: pull the
     word-coverage half forward into Phase 2b next to I11, since both rules say
     the same thing - reject a candidate that does not cover what the user
     said. Awaiting user decision. Walks top ~5 candidates in 0103
   order; accept only if ALL pass: (1) word coverage with I17 proportional
   typo tolerance, (2) no variantClash, (3) no unhonouredGrade,
   (4) similarity floor OR user-history row, (5) per-100 plausibility.
   No survivor => ungrounded => estimate. Pure string ops (microseconds).
   Unit-tested against the full real bug corpus (egg/yolk, milky mist,
   bikano/bikaji, creatine/creatinine).
5. I12 per-item decide is ADOPTED for Smart AND Super. Each item's decide
   call finishes on its own clock; its completion is that item's fill event.
   In Super, an item's decide fires when THAT item's sources are done, so a
   cache-hit item lands at Smart speed while a web-bound sibling still cooks.
6. Super: per-ITEM web queries, web ALWAYS parallel (not only on
   disagreement), precise cache short-circuits web, 2+ independent sources
   within 10% = verified badge, Sonnet decide with disagreements in-prompt.
7. I15: the post-card web refine dies; I14 discoverability ships with it.

Invariant everywhere: every number the user sees is source-grounded or wears
the estimate chip. No silent model arithmetic. No bulk-copy of licensed rows.
Version-skew rule (learned on 0088): the client must understand a capability
BEFORE the server starts emitting it; unknown enum values fail open.

## Phases

Each phase ships alone, deploys alone, and has a written gate. Risky flips
(P3, I12, I11) pass through SHADOW with criteria written BEFORE the flip.

### Phase 0. Merge + eval baseline  [MERGE = USER GATE]
Build: merge the branch to main. Run the 88-case suite once; write
scripts/parse-meal-eval/BASELINE.md (pass/fail per case + per tag).
Test: audit-*/accept-* are EXPECTED failures (they gate later phases). The
suite is flaky (~4 cases/run): judge changes by rerunning failures, never by
one full-suite number.
Gate: baseline committed. After this, no prompt/pipeline change lands
without its eval delta.

### Phase 1. Deterministic code fixes (no prompts)
Build:
- I17: wordsOverlap -> proportional Damerau-Levenshtein (distance / shorter
  length <= ~0.2). Extract the distance fn as a shared util; acceptCandidate
  reuses it in Phase 6.
- I16: delete stale hedged-web-lookup comments; ARCHAEOLOGY: recover why the
  pre-card web race was removed, write the finding into the tiers plan
  (it shapes Phase 7).
- I7: DONE, but NOT via strict. Measured strict on Haiku 4.5: +96% extract
  output tokens and +572ms per call, it silently no-ops when placed inside
  input_schema, and it cannot express our nullable enum. Shipped
  coerceQuantity() instead - same guarantee, no latency. Full numbers in the
  tiers plan.
Test: 11-pair unit table for I17; strict-mode schema round-trip; full-suite
eval no-regression.
Deploy: edge deploy; watch parse_traces for one day.

### Phase 2 STATUS 2026-08-24: 2a, 2b, 2c, 2d DONE and deployed. 2e SKIPPED.

All four verified on the eval AND on-device against production (ai-coach v108).
Order was changed deliberately: I11 (2b) went first, ahead of I6, because it
had three failing gates and a live user-reported bug rather than edge cases.

  2b I11/I11b  graded products resolve correctly. The routing code was only
               half of it - the real cause was a MISLABELED catalog row
               ('Toned Milk' at 48 kcal / 1.6 g fat is double-toned
               composition under a toned name) plus four grades with no row at
               all. Migration 0106 seeds the FSSAI ladder. PROD: "50g milky
               mist low fat paneer and amul double toned milk 300ml" ->
               Low Fat Paneer 95 + Double Toned Milk 141.3, both catalog, both
               high confidence. That closes the 2026-08-20 report.
  2a I6        deletion by text (was IMPOSSIBLE to express - the no-drop guard
               resurrected every removal) and challenge-carries-fix. PROD:
               "Remove the tofu" -> tofu actually goes.
  2c I13       staples by frequency with 7d decay, count + median amount.
               DEVIATION, documented: 14d stays the default but widens to 30d
               under 5 staples, because our most active account logs 8 meals in
               14 days and the >= 2 filter returned nothing. NOT device-verified
               (that history is on the DEV Clerk account; the sim runs PROD).
  2d I1        corrections re-resolve only what changed. PROD trace shows
               correction_scope {changed:1, untouched:1} and the untouched
               line's macros byte-identical across the correction.

  2e I3        SKIPPED, deliberately. It is prompt REORGANISATION with a
               behaviour-neutral requirement - no user-visible gain, real
               regression risk, and the suite is flaky enough that proving
               neutrality costs several runs. The content it would tidy has
               just changed substantially (I6 + I11b both edited the prompts),
               so doing it now would also mean redoing it later. Revisit when
               the prompts are stable and someone can watch the eval.

### Phase 2. Extract & decide quality (prompt work, each change eval-gated)
In order, one deploy per sub-step:
- 2a I6 extract holes: deletion contract, challenge+fix, correction+addition,
  multi-meal collapse, mentioned-not-eaten. Gates: audit-* cases.
- 2b I11/I11b acceptable-candidate (commodity vs formulated taxonomy) into
  decide. FIRST measure the grounded->estimate flip rate in shadow on real
  traces (thin Indian branded coverage is the risk); write the acceptable
  flip threshold before enabling. Gates: accept-* cases, both directions.
- 2c I13 staples list: 14d window, >=2 occurrences, frequency + ~7d-half-life
  decay, "name (N times, usually X ml)". Degrade under 14d of history.
  Test: decide latency unchanged (input tokens do not move output-bound
  latency); 10.4ms query verified on the existing index.
- 2d I1 changed-only corrections: filter extItems to changed lines;
  keepUncoveredPrevious restores the rest verbatim. Doubt => re-resolve.
  Test: correction eval cases; unchanged lines byte-identical after a
  correction.
- 2e I3 prompt reorganization LAST, once content is settled. Test: full-suite
  eval parity (this change must be behavior-neutral).

### Phase 3. Mode semantics (pre-transport)
Build:
- I15 + I14 TOGETHER (client + server): remove kickWebRefine, web_refine,
  refineMeal, the "checking trusted sources" card state; add the challenge
  affordance on low-confidence lines only.
- P3 flip check: query shadow counters; flip PARSE_SKIP_DECIDE to "on" only
  at 50+ parses, >95% same_macros, zero cases where code grounds what decide
  refused. If underpowered, leave in shadow and continue.
- I12 prereqs: meal_type -> code (clock-based), Drona line -> template/async.
Test: on-device, the card never mutates after render; affordance renders on
low-confidence lines only; meal_type parity on traces.

### Phase 4 M1 RESULT 2026-08-27: STREAMING WORKS, END TO END, ON DEVICE

The risk is retired. Measured with a throwaway probe (supabase/functions/
sse-probe + app/sse-probe.tsx, both deletable once M2 lands) rather than
assumed.

SERVER. A Supabase edge function streams and nothing in the edge runtime or the
CDN in front of it buffers. Ten events sent 400ms apart arrived 400ms apart:
  cold isolate  first byte 1.75s
  warm          first byte 0.46-0.86s, gaps 0.35-0.47s

CLIENT. expo/fetch on iOS hands chunks over as they arrive; res.body is a real
ReadableStream and the reader yields per chunk:
  status 200 @ 333-471ms, first event @ 359-483ms, gaps 377-435ms

CALIBRATION THAT CHANGES THE PLAN. The transport floor is ~350-480ms warm from
India, because execution is pinned to us-east-1 (deliberate: it removes several
internal round trips at the cost of one cross-ocean user hop). So:
  Fast Lane A (no LLM)      ~0.5s transport + search/fill  -> sub-second is real
  Fast Lane B (Haiku first) ~0.5s + ~1.2s extract          -> first row ~1.6-1.7s
The "first row under 1 second" target holds for Lane A and does NOT hold for
Lane B. Either state that honestly, or route more inputs into Lane A.

ONE THING RULED OUT. The first run showed the final `end` event arriving 1718ms
after the previous one while every other gap was ~400ms. It did NOT reproduce
(397ms on the next run): cold-start noise on the first request after a deploy,
not a flush-on-close problem. Recorded because it would otherwise look like a
reason to redesign how `end` seals the card, and it is not.

ANDROID: PROVEN TOO (2026-08-27), so the both-platforms gate is met.
Worth having run rather than reasoned about: SSE is only a protocol, but
expo/fetch is a native module with SEPARATE implementations (Swift/NSURLSession
on iOS, Kotlin/OkHttp on Android) and either could have buffered the body.
Android's pumpResponseBodyStream emits per chunk, and the device agrees:
  server sends  400ms apart
  iOS receives  377-435ms apart
  Android       246-455ms apart
Run on a STANDALONE SDK-54 app in Expo Go: the real app needs native modules
Expo Go lacks, and an Android dev build is a long gradle cycle for one
question. Pinning to 54 mattered - the scaffold defaults to SDK 57, and proving
streaming there would have proven nothing about what we ship. Ignore Android's
6.5s to first byte: emulator plus Expo Go overhead, not a device number. The
GAPS are the evidence.

CLIENT-CODE HAZARD found in the native source, true on BOTH platforms: chunks
are buffered into a sink until the JS side starts reading, and only emitted
once it does. So take getReader() IMMEDIATELY after the fetch resolves. Any
await in between and early chunks pile up and land in a lump - which would look
exactly like the transport buffering, and send the next person chasing the
wrong thing.

### Phase 4. Transport (the risk phase)
Build: SSE streaming out of the edge function BEHIND a client-declared flag
(old clients keep the JSON response; version-skew rule); expo/fetch streaming
consumption; the progressive card UI; the 4-event vocabulary.
Test DAY ONE: a throwaway probe streams 10 events through the production path
on iOS AND Android dev clients. Then: mid-stream disconnect -> client falls
back to buffered-complete; event replay/idempotence; old-client compat.
Gate: stream verified on device, both platforms, with fallback proven.

#### Phase 4 M3 RESULT 2026-08-28: THE GATE WAS DEAD, AND THE EVAL COULD NOT SEE IT
The card render works (verified on device: 2 catalog rows, 143 + 122 kcal, high
confidence). Getting there exposed the bigger finding.

`handleParseMealRequest` read the speed tier off `body.mode`, which is the
DISPATCH value and is already "parse_meal" by the time that code runs. So
`body.mode === "fast"` could never be true: Fast mode and SSE streaming were
both unreachable from the app for their entire build. On device every request
silently took the standard pipeline (~9s, zero `items` frames).

The eval could not catch it: `scripts/parse-meal-eval/run.ts` calls
`runParseMeal` DIRECTLY and never crosses the HTTP boundary. 84/87 @ 3807ms was
true of the pipeline and said nothing about whether the app could reach it.

Fixed: the tier rides on its own `body.speed` field. Standing rule for the rest
of this plan - **a green eval is not evidence that a request-shape gate works.**
Anything read off the request body needs one check that actually crosses HTTP.

Also, the simulator's synthetic keyboard drops roughly half the characters and
can background the app, so it cannot drive the nutrition input. `app/sse-probe.tsx`
fires the real streaming call on one tap instead; delete it when Phase 4 signs off.

### Phase 5. Smart progressive
- 5a Stage-boundary events, ZERO pipeline change: item events when extract
  returns (~1.3s), fill events when decide returns, end after guardrails.
  Test: TTFT measured on device (target rows <= 1.5s); out-of-order render.
- 5b I12 per-item decide behind PARSE_ITEM_DECIDE (off|shadow|on). N parallel
  per-item Haiku calls; each completion emits that item's fill.
  Test: SHADOW first, same pattern as P3 (per-item vs monolith, same_macros
  metric, cost delta logged; criteria: 50+ parses, >95%, then flip). Eval
  parity on the full suite; 7-item meal wall time ~9s -> ~3.5s in traces.

### Phase 6. Fast
- 6a Lane A + hedge: grammar parser, staple matcher, acceptCandidate gate,
  parallel estimate, template line, meal_type by clock.
  Test: grammar unit corpus incl. Hinglish ("2 roti", "paneer 200g",
  "doodh 1 glass"); acceptCandidate bug-corpus table; on-device full card
  <= 0.8s; estimate-fallback path <= 1.5s.
- 6b Lane B: streaming NDJSON extract, per-line search fire, per-item fill.
  Test: malformed-line injection (skip line, keep stream); first row <= 1.2s
  on device; every-line-garbage -> silent Smart fallback.
- 6c Hardening: correction/challenge reroutes, both-fail reroute, eval run
  with mode=fast across the corpus. EXPECTED: parity with Smart on
  simple-tagged cases; measured (not assumed) small loss on messy phrasing.
Gate: Lane A parity on simple cases; reroutes silent; TTFT numbers recorded.

### Phase 7. Super
- 7a precise_cache migration: write-through after verification, read
  short-circuit before web. REVOKE-first grants (Supabase default-grant
  lesson); anon NOT granted.
- 7b Per-item web search in the resolve fan-out. ARCHAEOLOGY DONE (I16,
  2026-08-23): two web designs have already shipped and been removed here.
  501a614 raced the lookup against decide with a 4s grace window and upgraded
  estimates SERVER-SIDE before render - dropped for being SILENT (the user
  never knew their numbers were swapped). abebc86 replaced it with the visible
  two-phase refine that swaps numbers in AFTER render - being removed by I15
  for mutating a card while Add is live. The axis is not visible-vs-silent, it
  is WHEN: before render the card is stable, after it is not. Super is the only
  design that gets both - the lookup sits inside resolve (before decide, before
  render) and is narrated by progress events plus the verified badge. Do not
  re-litigate this; both alternatives are already known to fail.
  Then: code cross-check + verified badge; Sonnet per-item decide
  (reuse 5b machinery, model swap + disagreements in-prompt).
- 7c Progress events per source; challenge flow reroutes here; credit gate.
- 7d Cache-to-catalog promotion (user decision 2026-08-23): a NIGHTLY job
  promotes precise_cache rows into foods so Fast/Smart search finds them too.
  Bar: verified only (2+ INDEPENDENT sources within 10%; FatSecret-only
  evidence never qualifies, keeps us clear of replicating their DB), logged
  >=2 times or by >=2 users, dedup check against existing rows first,
  source='web_verified' + last_verified_at (self-heal pattern re-checks).
  Never inline with a parse.
Test: THE CANONICAL CASE: "milky mist low fat paneer" must ground from web
with the right macros. Cache: the second identical parse must serve without a
web call (trace assert). Badge only at 2+ independent sources within 10%
(OFF rows sourced from FatSecret are NOT independent). Credit-gate deny path.
Cost per parse logged to token_usage_log.
Gate: canonical case green; cache short-circuit proven; super-tagged evals.

### Phase 8. Mode UI + routing
Build: toggle on the input bar, persisted pref, routing matrix (Fast
fail-silent -> Smart; corrections -> Smart; challenge -> Super; Super needs
credits). Test: pref survives restart; typed-routes compile; reroute matrix
exercised on device; Fast toggle hidden/disabled gracefully on old servers.

### Phase 9. Features on top
- I8 full-day logging: meal type per item end-to-end (extract schema, decide,
  card sections, client). Gate: audit-multi-meal-day. Revisit the 500-char cap.
- I10 personalized household units: learn per-user bowl/katori/glass weights
  from edit history; population defaults until n>=3 edits; spoons stay fixed.

## Testing infrastructure (cross-phase)
- Eval harness gains a mode parameter; new tags `fast-*` / `super-*`;
  BASELINE.md updated at every phase gate.
- TTFT is measured on the CLIENT (send -> first item event) and reported into
  the trace on Add; server stage timings already in steps.
- Shadow pattern is the standard for risky flips (P3, I12 5b, I11 2b):
  SQL-queryable counters, flip criteria written before the flag exists.
- Device verification per phase on iOS sim + Android dev client.

## Parallel / external tracks (not on the critical path)
- P6 FatSecret Premier: awaiting reply (US+India+UK+EU asked 2026-08-21).
  On grant: set region, retest the canonical case at tier 2.
- INDB (Anuvaad): confirm license, then batch-ingest as source='indb'.
- Rerank vendor eval (Voyage vs Cohere) on parse_traces, open since P2.
- food_log_stats / commonality refresh cadence.
