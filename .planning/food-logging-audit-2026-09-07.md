# Food logging: plan vs code audit

Date: 2026-09-07. Tree audited at `c677d21`; `origin/main` was `c201ec2` (7 commits
ahead, PR #147's consensusPanel work). Method: every discrete item in the five
food-logging plan files, classified against the code with file:line evidence.
Plan status text was ignored on purpose - the "Where we are" block is dated
2026-08-23 and is wrong in both directions.

States: DONE / BUILT BUT NOT WIRED / PARTIAL / NOT STARTED / CLOSED-SUPERSEDED.

## Headlines

1. The nightly cache-to-catalog promotion DOES run. It is a GitHub Action
   (`.github/workflows/promote-food-cache.yml:33`, cron `10 4 * * *`), not
   pg_cron. An earlier note in this session said it never runs; that was wrong,
   and it was wrong because only `supabase/migrations/` was searched.
2. Two flags are permanently stuck in shadow. `PARSE_FAST_GRAMMAR` and
   `PARSE_SKIP_DECIDE` both default to `shadow` and neither appears in the
   project's secrets. Their work runs on every parse and the result is thrown
   away, which costs an extra `verifyItems` pass per Smart parse.
3. Phase 5 is called "Smart progressive" and Smart does not stream. Streaming is
   hard-gated to Fast on both ends: `index.ts:2091` requires `wantsFast`, and
   `lib/dietData.ts:842` hardcodes `speed: 'fast'`. 5a therefore only landed for
   Fast.
4. The 500-char cap cuts the real model input, not just the trace.
   `parseMeal.ts:4303` is `input.text.trim().slice(0, 500)`. The multi-meal plan
   asserted this cap was trace-only and that a full day needs ~800 chars. A long
   full-day message silently loses its tail.
5. The precise cache is read on every tier. `index.ts:1629` installs
   `preciseCacheGet` with no tier check, and `parseMeal.ts:2788` short-circuits
   before the fan-out for all modes. A row Super banked, including the +-19%
   wobble 7e was written to explain, is served to Quick and Thorough for the full
   90-day TTL, bypassing the plausibility filter, the reranker and the 6-row cap.
6. Correcting an auto-logged meal double-logs. `nutrition.tsx:419` builds
   `prevReview` from `status === 'review'` only, so a follow-up after a
   "Just log it" write is treated as a brand new meal and added on top.
   (Plan item B3.)

Correction to headline 5 of the raw agent report: it claimed Super is off by
default and silently downgrades. The code default IS `"off"`
(`index.ts:117`), and `wantsSuper` at `index.ts:2083` does go false with no
client signal. But `PARSE_SUPER_MODE` IS set in production (secrets list,
updated 2026-09-04), so live users are not affected. The real exposure is a
fresh environment, or the secret being removed: the tier degrades to Thorough
with no error and no chip. `PARSE_FAST_GRAMMAR` and `PARSE_SKIP_DECIDE` are
absent from that same secrets list, which is how headline 2 was confirmed.

## Phase 0 - merge + eval baseline

| Item | State | Evidence |
|---|---|---|
| Merge branch to main | DONE | PRs #141/#143/#144/#145/#146 landed |
| BASELINE.md written | DONE, 15 rows, latest 88/91 API | `scripts/parse-meal-eval/BASELINE.md:30` |

## Phase 1 - deterministic code fixes

| Item | State | Evidence |
|---|---|---|
| I17 proportional Damerau-Levenshtein as shared util | DONE | `textMatch.ts:49`, `:99`; `acceptCandidate.ts:22` |
| I16 delete stale hedged-web-lookup comments | DONE | `parseMeal.ts:1280-1291`, `:1504` |
| I7 coerceQuantity (strict rejected) | DONE | `parseMeal.ts:1476`; `quantity.test.ts` |

## Phase 2 - extract and decide quality

| Item | State | Evidence |
|---|---|---|
| 2a I6 extract holes (deletion by text, challenge+fix, correction+addition, multi-meal, mentioned-not-eaten) | DONE | `parseMeal.ts:3325`, `:3348`, `:1900`; eval cases audit-delete-by-text, audit-challenge-plus-fix, audit-asked-not-eaten |
| 2b I11/I11b acceptable-candidate taxonomy into decide | DONE | `parseMeal.ts:2205`, `:3195`, `:3226`; `0106_milk_grade_ladder.sql` |
| 2b measure grounded-to-estimate flip rate in shadow BEFORE enabling | NOT STARTED - shipped straight on, no flag, no threshold recorded | no such flag among `index.ts:100-158` |
| 2b pull word-coverage forward out of Fast into all modes | NOT STARTED | `firstAcceptable` called only inside `if (fastMode)` at `parseMeal.ts:4829` |
| 2c I13 staples by frequency, 7d half-life, 14d-to-30d widening | DONE | `index.ts:1497`, `:1470`, `:1563` |
| 2d I1 changed-only correction resolve | DONE | `parseMeal.ts:3273`, `:4708-4721`; `correctionScope.test.ts` |
| 2e I3 prompt reorganisation | CLOSED-SUPERSEDED, skipped on purpose | plan `food-logging-consolidated-plan.md:161-167` |

## Phase 3 - mode semantics

| Item | State | Evidence |
|---|---|---|
| I15 remove kickWebRefine / web_refine / refineMeal / "checking trusted sources" | DONE, zero hits | grep across repo, nothing outside `.planning/` |
| I14 challenge affordance on low-confidence lines only | DONE | `ParsedMealCard.tsx:160`, `:271`; `nutrition.tsx:630` |
| P3 flip PARSE_SKIP_DECIDE to on at 50+ parses / >95% same_macros | NOT STARTED, still shadow | `index.ts:152-153`; metric at `parseMeal.ts:5126-5135` |
| I12 prereq: meal_type by clock | DONE | `parseMeal.ts:1780` `mealForHour` |
| I12 prereq: Drona line template/async | PARTIAL - template used on Fast and skip-decide paths; Smart decide still gets `drona_line` from the model synchronously | `parseMeal.ts:622`, used `:4943`, `:5000`; decide reads `raw.drona_line` at `:5175` |

## Phase 4 - transport

| Item | State | Evidence |
|---|---|---|
| SSE behind a client-declared flag | DONE | `index.ts:2091` |
| expo/fetch streaming consumption | DONE | `lib/dietData.ts:871` |
| Progressive card UI | DONE | `ParsedMealCard.tsx` `streamingRows`, wired `nutrition.tsx:1132` |
| The 5-event vocabulary (item/fill/progress/drona/end) | PARTIAL - only `items`, `fill`, `end`, `error` ship | `parseMeal.ts:812-813`; `index.ts:2126`, `:2144`, `:2229` |
| Lifecycle contract: stable server-minted `item_id` | NOT STARTED | `ProgressItem` `parseMeal.ts:801-810` has no id |
| Lifecycle contract: monotonic `rev`, drop stale fills | NOT STARTED | same struct; no rev check in `dietData.ts:881-893` |
| Mid-stream disconnect to buffered-complete fallback | DONE | `lib/dietData.ts:912`, `:932` |
| Old-client compat | DONE, stream is opt-in per request | `index.ts:1613-1621`, `:2091` |
| Delete throwaway sse-probe | DONE, both gone | no `sse-probe` in `supabase/functions/` or `app/` |

## Phase 5 - Smart progressive

| Item | State | Evidence |
|---|---|---|
| 5a stage-boundary item/fill events | PARTIAL - events exist and fire, but only in Fast | emit wrapped in `if (fastMode)` at `parseMeal.ts:4742`; `index.ts:2091`; `lib/dietData.ts:842` |
| 5b I12 per-item decide behind PARSE_ITEM_DECIDE | NOT STARTED | no such flag; Stage 3 monolithic at `parseMeal.ts:4778-4783` |

## Phase 6 - Fast

| Item | State | Evidence |
|---|---|---|
| 6a grammar parser (Lane A) | BUILT BUT NOT WIRED - runs, but extract is only skipped at `on`, and nothing sets it | `fastGrammar.ts:1`; `index.ts:108`; `parseMeal.ts:4258` |
| 6a Lane A staple matcher | NOT STARTED - `fastGrammar.ts` is pure grammar | exports only `parseFastGrammar` |
| 6a acceptCandidate gate | DONE (Fast only) | `acceptCandidate.ts:155`, `:201`; `parseMeal.ts:4829`; `acceptCandidate.test.ts` |
| 6a parallel estimate hedge | CLOSED-SUPERSEDED, contrary to plan - the plan rejected a fused extract+estimate call and that is what shipped | `parseMeal.ts:2003-2008`, `:4283`; BASELINE 2026-08-30 "FAST v2: estimate-first rewrite" |
| 6a template Drona line | DONE | `parseMeal.ts:4943` |
| 6a meal_type by clock | DONE | `parseMeal.ts:4935` |
| 6b Lane B streaming NDJSON extract, per-line paint | NOT STARTED - no NDJSON; one batched `items` event after the whole extract | `parseMeal.ts:4742`, comment at `:4797` |
| 6c correction reroute to Smart | DONE | `nutrition.tsx:485` |
| 6c malformed / both-fail reroute, silent | DONE | `lib/dietData.ts:901`, `:912`, `:932` |
| 6c eval run with mode=fast across the corpus | DONE | `scripts/parse-meal-eval/run.ts:334`; BASELINE rows 2026-08-28 to 2026-09-01 |

## Phase 7 - Super

| Item | State | Evidence |
|---|---|---|
| 7a precise_cache migration, REVOKE-first, anon not granted | DONE | `0109_precise_cache.sql:1`; `index.ts:1624-1628` |
| 7a write-through after verification | DONE | `parseMeal.ts:2694-2706`; `index.ts:1646` |
| 7a read short-circuit before web | DONE, but NOT Super-scoped (headline 5) | `parseMeal.ts:2788-2805` |
| 7b per-item web search inside the resolve fan-out | DONE | `parseMeal.ts:4771-4772`, `:2657`, `:1679` |
| 7b code cross-check, 2+ independent sources within 10% | DONE | `preciseCache.ts:216`; `parseMeal.ts:2467`; 32 tests in `reconcileReadings.test.ts` |
| 7b verified badge | DONE end to end | `parseMeal.ts:576`, `:3428`; `lib/dietData.ts:667`; `ParsedMealCard.tsx:240-243` |
| 7b Sonnet decide for Super | NOT STARTED - whole pipeline pinned to Haiku | `index.ts:99`, used unconditionally at `:1603` |
| 7b disagreements in-prompt | DONE | `parseMeal.ts:2343`; prompt rule `:2208` |
| 7c progress events per source | NOT STARTED - no `progress` event, and Super runs on the non-streaming path | `parseMeal.ts:811-813`; `index.ts:2091`. Stale claim at `parseMeal.ts:1288` |
| 7c challenge flow reroutes to Super | NOT STARTED - Check routes to `researchPrevious` on Smart | `nutrition.tsx:641-660`; `parseMeal.ts:4534` |
| 7c credit gate | PARTIAL - shipped as a Pro-entitlement 402, not credits; correctly ordered before the rate-limit slot | `index.ts:1824-1830`; `parseSpeed.ts:62`; `ParseSpeedSheet.tsx:90` |
| 7d cache-to-catalog promotion, nightly, never inline | DONE and wired | `promoteCache.ts`; `tools/promote-food-cache/run.ts:31`; `.github/workflows/promote-food-cache.yml:33`; 28 tests |
| 7d FatSecret supersede (`via` decides independence) | DONE in code, stale in docs | `preciseCache.ts:216-249`; stale `.github/workflows/promote-food-cache.yml:12` |
| 7 canonical case + cache short-circuit assert | DONE | `tools/super-canonical-case.ts:1-18` |
| 7 cost per parse to token_usage_log | DONE | `0113_web_search_server_tool_cost.sql:88`; `index.ts:2179`, `:2329` |
| 7 super-tagged evals | NOT STARTED | `run.ts:334` has FAST_MODE only; no `super-*` ids in `cases.ts` |
| 7e (3 items) | DEFERRED by the user, not audited. Note: the measurement half of the third item exists at `tools/super-probe/wobble.ts:1-23`, budget-capped at ~$0.24 |

## Phase 8 - mode UI and routing

| Item | State | Evidence |
|---|---|---|
| Toggle + persisted pref | DONE | `lib/parseSpeed.ts:23-52`; `ParseSpeedSheet.tsx` |
| Routing matrix | DONE except challenge-to-Super (see 7c) | `nutrition.tsx:477-484`; `parseSpeed.ts:29` |
| Fast toggle degrades gracefully on old servers | DONE | `index.ts:119`, `:2072`, `:2281` |

## Phase 9 - features on top

| Item | State | Evidence |
|---|---|---|
| I8 meal per item, extract schema (both tools) | DONE | `parseMeal.ts:1156-1165`; `:2004` |
| I8 precedence item ?? explicit ?? carried ?? fallback | DONE, all 7 return paths | `parseMeal.ts:1817-1880`; call sites `:4546, :4565, :4662, :4926, :4981, :5166`; 18 tests |
| I8 decide prompt line "do not move items between meals" | PARTIAL - enforced in code, never written into the prompt | `parseMeal.ts:2225`; enforcement `:1821-1828` |
| I8 client grouped sections, "Add to N meals", strip summary | DONE | `ParsedMealCard.tsx:204-207`, `:302`, `:475-505`, `:575` |
| I8 edit sheet meal picker | DONE | `ParsedItemEditor.tsx:26`, `:65`, `:157` |
| I8 raise the 500-char cap | NOT STARTED (headline 4) | `parseMeal.ts:4303`; no `maxLength` on the composer |
| I10 personalized household units | NOT STARTED | `gramsPerUnit` at `parseMeal.ts:435` reads catalog labels only |

## Testing infrastructure

| Item | State | Evidence |
|---|---|---|
| Eval harness mode parameter | PARTIAL - FAST_MODE only, no super | `run.ts:334` |
| Tags `fast-*` / `super-*` | NOT STARTED - `cases.ts` has no tags field | `cases.ts:11-31` |
| BASELINE.md updated at every gate | DONE, 15 dated rows | `BASELINE.md:30-46` |
| TTFT measured on the CLIENT, into the trace on Add | NOT STARTED - only `tools/plan-eval/` has TTFT, a different pipeline | grep `ttft` |
| Shadow pattern with SQL-queryable counters | DONE for P3 and Lane A | `parseMeal.ts:5126`, `:4433`, `:4441` |
| Device verification per phase | DONE, recorded in plan | plan `:229-242`, `:296-299` |

## Tiers plan P0-P6

| Item | State | Evidence |
|---|---|---|
| P0 land deployed work | DONE | `parseMeal.ts:3371`, `:3169`; `index.ts:16`; `parseMeal.ts:2985-2996` |
| P1 ranking layer | DONE | `0103_food_search_ranking.sql`, fixed by 0105 and 0107 |
| P2 Voyage reranker behind a flag | DONE | `rerank.ts`; `index.ts:148`, `:1656`; `parseMeal.ts:3039-3042` |
| P2 vendor eval Voyage vs Cohere | NOT STARTED | no Cohere reference anywhere |
| P3 skip-decide gate | BUILT BUT NOT WIRED - correct, never leaves shadow | `parseMeal.ts:4960-5007`; `index.ts:152` |
| P4 Fast mode user-facing | DONE | `index.ts:2072`; `lib/parseSpeed.ts` |
| P5 Super mode | BUILT, wired, and ON in production; code default is off | `index.ts:117`, `:2083`; secrets list 2026-09-04 |
| P6 FatSecret Premier (external) | NOT STARTED - plumbing ready, region must stay unset on Basic | `index.ts:156-157`, `:143-145` |
| INDB (Anuvaad) ingest | NOT STARTED - forbidden until licensed | `scripts/diet-catalog/README.md:31` |
| food_log_stats refresh cadence | DONE - resolved as trigger-kept, not cron | `0103:62-83`; `0105:1` |

## Multi-meal and "Just log it"

| Item | State | Evidence |
|---|---|---|
| A1-A5 server | DONE (A3 prompt line PARTIAL, A5 cap NOT STARTED) | as Phase 9 I8 |
| A6-A10 client | DONE | `lib/dietData.ts:1045-1093`; `ParsedMealCard.tsx:302`, `:475` |
| A gate: audit-multi-meal-day asserts per-item meal | DONE, plus two held-out cases | `cases.ts:869-870`, `:882-884`, `:898-899` |
| B1 server: flag, detached parse, diary write, idempotency, trace | DONE | `autoLog.ts:51,81,116,138,239`; `index.ts:2143-2150`; 0114, 0115 |
| B2 client: toggle, send state, strip, pending, reconcile, Undo | DONE | `lib/autoLog.ts:29-90`; `nutrition.tsx:446-455`, `:559`, `:1202`, `:1236` |
| B3 corrections against an auto-logged meal | NOT STARTED - double-logs (headline 6) | `nutrition.tsx:419`; the `'logged'` state at `:76` is never fed back as `previous` |
| B4 push notification | NOT STARTED, explicitly v1-optional | no push-token registration for this |

## Older base plans

| Item | State | Evidence |
|---|---|---|
| ai-food P0-P3 + MFP-parity surfaces | DONE | `parseMeal.ts`, `ParsedMealCard.tsx`, `EntryEditSheet.tsx`, `SaveMealSheet.tsx`, `food-search.tsx`, `meal-builder.tsx` |
| ai-food P4 photo logging | NOT STARTED - deps present, no camera affordance | no camera/mic in `nutrition.tsx` |
| ai-food P5 voice | NOT STARTED | no STT dependency |
| diet P3 offline meal sync queue | NOT STARTED - `lib/mealQueue.ts` does not exist | `lib/syncQueue.ts` is workouts only |
| diet P7 barcode scan + OFF enrichment | NOT STARTED | only `lib/foods.ts:99` `barcode?`; no scanner UI |

## Test gaps

Shipped, reachable in production, and covered by no unit test and no eval case:

- `codeFillItems` and the whole P3 skip-decide path (`parseMeal.ts:501`, `:4960-5007`).
  The riskiest one: it is a single env var away from replacing the decide call on
  every Smart parse, it re-runs the entire guardrail chain independently, and
  nothing exercises it. `code_fill_shadow` is a metric, not a test.
- `voyageRerank` (`rerank.ts`) - shipped, no unit tests, no eval asserts ordering.
- `searchFatSecret` (`fatsecret.ts`) - OAuth 1.0 signing, sanitize path, and the
  zero-macro bug CodeRabbit caught on PR #120 are all untested.
- `searchOpenFoodFacts` and the OFF self-heal / backfill (`parseMeal.ts:960`) -
  largest untested function in the file.
- The SSE transport itself (`index.ts:2091-2250`). No test crosses the HTTP
  boundary. This is the exact class the Phase 4 M3 lesson was written about.
- `runSuperLookup` (`parseMeal.ts:1679`) - only the reconciliation half is tested;
  the tool loop, `pause_turn`, and `report_sources` parsing are not.
- Guardrails, none imported by any test: `clampVolumetricGrams` `:3738`,
  `checkAtwater` `:3784`, `reconcileQuantity` `:3813`, `flagPrepMismatch` `:3876`,
  `verifyItems` `:3498`, `keepUncoveredPrevious` `:254`, `preserveManual` `:283`,
  `reconcileExtracted` `:324`, `retargetMismatchedIds` `:3371`.
- `tryFastCorrection` `:4066` - only indirectly, via flaky `refine-*` cases.
- Client `logParsedMeal` multi-section rollback (`lib/dietData.ts:1088-1093`).
  The "breakfast logged, lunch missing" failure the plan names has no test.
- `sectionsOfItems` (`lib/dietData.ts:1061`) - decides whether the card goes
  multi-meal.

## Migrations 0100 and up

| File | Purpose | Note |
|---|---|---|
| 0100_routines_program_phase | routine to program-phase link | not food logging |
| 0101_form_check | form-check schema | not food logging |
| 0102_form_check_slot_revoke_anon | fixes 0101's ineffective revoke | supersedes part of 0101 |
| 0103_food_search_ranking | P1 ranking: rank_boost, food_log_stats, ranked search | partly superseded by 0104, 0105, 0107 |
| 0104_food_log_stats_grant_anon | without it every anon catalog search returned nothing | fixes 0103 |
| 0105_food_log_stats_track_updates | 0103's trigger missed food_id UPDATEs | fixes 0103 |
| 0106_milk_grade_ladder | FSSAI graded-milk ladder + low-fat paneer | |
| 0107_history_escapes_prefix_tier | own repeated food outranks generic prefix match | supersedes 0103's search body |
| 0108_toned_milk_atwater_consistent | one-row fix, 58 to 58.6 kcal | |
| 0109_precise_cache | precise_cache + precise_cache_get, service_role only | |
| 0110_ai_coach_keep_warm | pg_cron warm ping | superseded by 0112; hard-codes the prod URL |
| 0111_search_foods_fast | LIKE-only search for Fast, 478-1413ms to 51-217ms | used via `lean` at `index.ts:1381` |
| 0112_keep_warm_env_scoped | rebuild keep-warm off DB settings | supersedes 0110 |
| 0113_web_search_server_tool_cost | price the web_search server tool | |
| 0114_meal_entries_ai_auto | logged_via ai_auto + meal_entries.client_id | partly superseded by 0115 |
| 0115_meal_entries_client_id_unique | unique index, entry idempotency as a DB guarantee | fixes 0114 |

No missing numbers in 0100-0115.

## Dead code and stale docs

Nothing is orphaned; several things are read and then never allowed to act.

- `PARSE_FAST_GRAMMAR` (`index.ts:108`) - grammar computed on every Fast parse,
  discarded at the `shadow` default. Not in the secrets list. `parseMeal.ts:4239`
  documents a latent bug waiting for whoever flips it. Measured coverage was 1 of
  8 real inputs (`parseMeal.ts:4428`).
- `PARSE_SKIP_DECIDE` (`index.ts:152`) - same shape; costs an extra `verifyItems`
  pass per Smart parse (`parseMeal.ts:5099-5106`).
- `FATSECRET_REGION` / `FATSECRET_LANGUAGE` (`index.ts:156-157`) - must stay unset
  until Premier (P6).
- `webSearchEnabled` does not do what its name says. `PARSE_MEAL_WEB_SEARCH=false`
  gates only `researchPrevious` (`parseMeal.ts:3964`) and `answerAboutPrevious`
  (`:4610`). Super's own searches (`:1679`) never consult it, so the kill switch
  cannot stop the expensive path.
- The `fill` SSE variant is write-only on the client. Server emits
  (`parseMeal.ts:4944`), `index.ts:2126` forwards, `lib/dietData.ts:881` handles
  only `items` and `end`. The frame is parsed and dropped.
- Stale text pointing at behaviour that no longer exists:
  `.github/workflows/promote-food-cache.yml:12` ("FatSecret never counts"),
  `parseMeal.ts:1288` ("narrated by progress events"), and `runSuperLookup`'s own
  system prompt at `parseMeal.ts:1705-1707`, which still tells the model
  "FatSecret pages do not count toward agreement". Commit `ed9ae11` claimed to fix
  that last one and the text is still there.

## Plan drift

Code does something no plan describes:

1. Fast is one fused extract+estimate call. The consolidated plan rejected this in
   bold (`:63-64`, "estimates fatten output; output tokens ARE the latency") and
   `parseMeal.ts:2003-2008` is exactly that design, re-adopted with no amendment.
   BASELINE records the result, not the reversal.
2. The precise cache is a global tier, not a Super feature.
3. The label chain (`applyLabelChain` `parseMeal.ts:1954`, `label_applies`,
   `serving_g` / `serving_kcal` / `pieces_per_serving` recall) is a real accuracy
   mechanism that appears only in BASELINE's history table, in no plan.
4. `consensusPanel` and whole-panel reconciliation tiers, on `origin/main` - a
   fourth Super reconciliation strategy with no plan entry.
5. Precise degrades silently when `PARSE_SUPER_MODE` is off. The routing matrix
   has no "server disabled the tier" branch.

Plan describes behaviour the code does not have:

1. The five-event SSE vocabulary and the whole lifecycle contract (item_id,
   monotonic rev, drona as its own event, `end` reconciling an authoritative
   list). Two events ship; ids and revs do not exist. The contract's stated
   justification, that "out-of-order fills" and "never mutates after render" only
   coexist because of these rules, is currently satisfied by accident: only one
   batched `items` frame is ever sent.
2. Phase 5 is "Smart progressive" and Smart does not stream.
3. acceptCandidate as "ONE shared pure gate used by Lane A, Lane B, and the P3
   skip-decide path" (locked decision 4). One caller, in the Fast branch.
4. "challenge to Super" appears in the mode contract, the Phase 8 routing matrix,
   and Phase 7c. The Check button routes to `researchPrevious` on Smart.
5. "Sonnet stays only for Super's decide" (2026-08-22 decision). Everything is
   Haiku.
6. Phase 2b's "measure the flip rate in shadow first, write the threshold before
   enabling". I11 shipped with neither.
7. The Drona line "async in Smart/Super". Still synchronous and model-authored on
   the decide path.
8. The plan's "Where we are" block understates progress: it claims Fast/Smart/Super
   are NOT STARTED as user-facing modes and that the eval baseline was NEVER RUN.
   Both are false. Its inline DONE markers are accurate everywhere checked except
   7d's FatSecret clause and 5a's scope.

---

## Resolved since this audit (2026-09-09)

This file is a snapshot and is left as written. Two of its findings have been
acted on in the same branch, so read those rows against this note:

- **Headline 4 / "I8 raise the 500-char cap" (was NOT STARTED).** Fixed. The
  cap was on the user's text at THREE points, not the two found here: the
  extract message in both shapes and the decide payload. Now one exported
  constant at 2000, with a `user_text_clamped` trace step when it bites.
  Measured at 500 on a 712-character message: three of six foods came back,
  with a confident Drona line about the day.
- **The 12-item ceiling.** Not a finding in this audit at all; it surfaced
  when the first long-message eval case was written and came back with exactly
  twelve rows. Raised to 50 (`MAX_ITEMS_PER_PARSE`), with the Smart extract,
  decide, web-label and super-source budgets raised to 5000 to match, since a
  50-item answer does not fit a budget sized for 12. Sarthak's numbers,
  deliberately past any real day rather than tight; optimise from usage.

Both were invisible to the eval suite because the longest case here was 89
characters. `audit-long-message-tail` (712 chars, six foods) and
`audit-full-day-many-items` (a real day, 17 foods) now cover them, and each
isolates one limit so the other cannot mask it.

The test-gap list above is otherwise unchanged, except that `sanitizeItems` is
now exported and covered (`itemCeiling.test.ts`).
