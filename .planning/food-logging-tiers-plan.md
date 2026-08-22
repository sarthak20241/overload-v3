# Food Logging Tiers (Fast / Balanced / Precise) - Plan

Status: PLANNED (2026-08-21). Extends the shipped parse_meal pipeline
(supabase/functions/ai-coach/parseMeal.ts). Follows the id-slip retarget +
row-name reconciliation + OFF self-heal fixes landed 2026-08-21.

Design principle, carried from the AI food logging plan: friction is the enemy,
Drona is the narrator, and the model only matches and counts. Macros always come
from a source row, never from model arithmetic.

## The proving case (tested live, 2026-08-21)

User types: **"milky mist low fat paneer"**.

| Source | Result | Verdict |
|---|---|---|
| Our catalog (`search_foods_ranked_with_servings`) | full query: 0 rows. Word-drop ladder lands on "Milky Mist Paneer", the FULL FAT row (283 kcal, 22g fat) | Silently wrong: logs 283 kcal for a 190 kcal product |
| Open Food Facts (live, search-a-licious) | brand exists (curd, skyr, cheese), low fat paneer variant absent | Miss |
| FatSecret India (fatsecret.co.in) | **"Milky Mist High Protein Low Fat Paneer": 190 kcal, 25g P, 7g F, 6.7g C per 100g** | Exact hit |
| Web search (Anthropic tool, current tier 3) | finds the FatSecret/label pages | Hit, ~5s slower |

This is not hypothetical. The user logged "35g milky mist high protein paneer"
on 2026-08-20 and the pipeline matched it to full-fat Milky Mist Paneer.
Fat logged ~3x too high, protein ~40% too low.

## Source landscape (researched 2026-08-21)

| Source | Coverage | Cost | Latency | Use it? |
|---|---|---|---|---|
| Our catalog (~30k rows: USDA, CoFID, Ciqual, OFF, curated) | good generics, growing branded | free | ~200ms | Tier 1 always |
| Open Food Facts live | global branded, patchy India, crowd-quality | free (ODbL) | ~1-2s | Already tier 2; keep + self-heal |
| **FatSecret Platform API** | 2.3M foods, 58 markets, 90%+ barcode coverage. Proven hit on the test case | Basic = free, 5k calls/day, US only. **Premier Free = free, unlimited, but US only per their editions page.** Premier (paid) = quote-only, priced per MARKET not per call | ~300-800ms | **Yes - the key new source.** DECIDED 2026-08-21: apply for Premier Free and ask them to extend it to our markets |
| Nutritionix | 800k branded, US/restaurant focus, enterprise $1,850/mo | too much | - | No |
| Edamam | 900k foods, NL parser, weak India | mid | - | No (parser duplicates what Drona does) |
| Bon Happetee | 20k+ Indian foods, IFCT/NIN-derived, licensed (sidesteps our IFCT ban) | contact sales | ~500ms | Maybe later, for Indian generics/dishes; get a quote |
| **INDB (Anuvaad)** | 1,014 common Indian RECIPES, per-100g + per-serving, open access | free (verify license terms before ingest) | offline ingest | **Yes - batch-ingest as new `source='indb'` layer** for cooked dishes (dal makhani, poha, sabzi) |
| Anthropic web search | anything with a label page | ~$10/1k searches | ~5s | Keep as precise tier + last resort |
| Photo (Cal AI style) | out of scope here | - | - | Later; capture-only, catalog still supplies numbers |

Legal guardrails carried forward: never bulk-copy FatSecret/proprietary rows
into `foods`. Per-lookup caching of individual facts is fine (facts are not
copyrightable); bulk replication of their DB is not. Same rule that already
governs the web tier. OFF rows stay `source='off'` (ODbL segregation).

## The three modes (REVISED 2026-08-22, user decision)

Modes are USER-FACING: Smart is the default, Fast is a user choice, Super is
credit-gated (and powers the challenge flow). Full component diagrams:
https://claude.ai/code/artifact/f8b7a309-5d48-4243-8700-de32afc5ddf4

Invariant everywhere: a number the user sees comes from a source row, or is
labeled Drona's estimate. Never silent model arithmetic.

### Fast (user picks, p50 ~2.5-3s)

ONE fused Haiku call does extract AND a per-item macro estimate (the searches
depend on extracted names, so they cannot precede the LLM; fusing the estimate
into that same call is what makes "parallel" real). Then catalog + OFF per item
in parallel under a hard 1.5s budget (OFF timeout tightened from 2.5s). Code
picks (history > commonality > rank; no reranker, no decide), code fills.
Anything ungrounded uses the estimate from call 1 with the estimate chip.
Drona line from a template. Fast never escalates and never blocks on accuracy.

### Smart (default, p50 ~3.5s clear / ~6s hard)

Haiku extract -> catalog + OFF + FatSecret in parallel -> merge -> rerank
(Voyage rerank-2.5-lite, ~300ms) -> confidence gate PER ITEM:
- confident (big margin, clear units, not a correction): CODE fill, no decide.
- unsure / messy units / corrections: decide (Haiku) over the top 6.
Items no source grounded get a Haiku estimate in the fill step itself, chipped.
Drona line async, lands after the card. Weak lines still offered phase-2 refine.

### Super (credit-gated, p50 ~8-12s)

DECIDED 2026-08-22: Haiku extract in ALL modes (extraction is the easy step;
Sonnet there buys little and costs ~1s). Sonnet stays only for Super's decide,
where it reasons over source disagreements.

Haiku extract -> catalog + OFF + FatSecret + Anthropic web search + precise
cache, ALL parallel (~5s wall, web sets the pace) -> quality rerank -> code
cross-check (2+ independent sources within 10% = verified badge) -> Sonnet
decide always, disagreements in-prompt, card names the label that won ->
guardrails -> cache write so the next user gets it at Smart speed.
Nothing ships as estimate if any source grounded it. Challenge flow = Super.

### Card filling is code, not a model

Once a row is picked: macros = per-100 x grams, servings from anchors, chips
from variant guards. The model appears in filling only as (a) the estimate
fallback, one Haiku call, chipped; (b) the one-line coach sentence, template in
Fast, async Haiku in Smart/Super.

### Reranker (decision)

Placement: after source merge, before any pick, in every mode that uses one.
Vendor: Voyage rerank-2.5-lite (~300ms, per-token pricing ~fraction of a cent
per parse, and VOYAGE_API_KEY already exists in the edge function for semantic
embeddings, so zero new vendors). Runner-up Cohere Rerank 4-fast (~600ms,
$2/1k). Self-hosted BGE/Jina rejected: no GPU host. Final call gated on an
NDCG/top-1 eval over parse_traces real queries via tools/parse-meal-eval.

## The shared ranking layer (build FIRST - it lifts every tier)

Order of signals, applied to the merged candidate list before decide:

1. **User history**: foods this user logged before rank above everything.
   "milk" from this user means the Amul row they always log.
2. **Commonality prior**: a popularity boost in the RPC so chicken egg beats
   duck egg. (The egg bug: whole chicken egg ranked 6/6 behind duck, quail,
   yolk, turkey, white.) Compute log-frequency from `meal_entries` food_id
   counts + a small curated staples list; add as a rank term in
   `search_foods_ranked_with_servings`. Zero latency.
3. **Cross-encoder rerank**: query + top ~20 candidates -> reranker -> top 6.
   Cohere Rerank (~$2/1k, ~600ms) or Voyage lite (~300ms). Runs inside
   resolve's parallel window so wall-time cost is ~0 for balanced.
4. **Variant guards** (shipped 2026-08-21): retargetMismatchedIds + variantClash
   stay as the last line.

## Routing summary

```
user text
  -> extract
  -> catalog search + history match
       all high-confidence + seen before?  -> FAST (no decide call)
       else                                -> BALANCED
            weak line / challenge / new?   -> PRECISE (or phase-2 refine)
```

Confidence per line, not per meal: "2 eggs and a bhakarwadi" logs the eggs
fast-path and escalates only the bhakarwadi.

## Costs (est., 1,000 parses/day)

| Item | Cost/day |
|---|---|
| Haiku extract+decide (today) | ~existing |
| Rerank (1 call/parse) | ~$2 |
| FatSecret Premier | contract - get quote; Basic/Premier-Free is $0 during dev |
| Web search (precise only, ~10% of parses x 2 searches) | ~$2 |
| Sonnet on precise (~10%) | ~$3-5 |

## Build phases (locked 2026-08-22)

Each phase ships alone, is verifiable alone, and never breaks the pipeline it
lands in. Order chosen so accuracy fixes land before speed work.

### P0. Land the deployed work  [COMMITTED 2026-08-22; PR pending]
The egg/name/self-heal fixes + FatSecret source are DEPLOYED but uncommitted
(the coach-retrieval drift mistake, again). Commit on this branch, PR to main.
Verify: git clean, PR open, next parse trace shows lookup_fatsecret firing.

### P1. Ranking layer (zero latency)  [DONE 2026-08-22: migration 0102 live, 'eggs' ranks whole chicken egg 1st, 32ms]
Migration: foods.rank_boost column + curated staple boosts (whole chicken egg,
cow milks, common dals...) + rewrite search_foods_ranked_with_servings to score
trigram + rank_boost + global popularity (distinct users >= 2, log-scaled) +
caller's own frequent foods (>= 2 logs, via meals.user_id = jwt sub).
Verify: SQL before/after for 'eggs' (whole chicken egg must rank 1st), 'milk',
'paneer'; parse-meal-eval regression run.

### P2. Reranker in resolve  [DONE 2026-08-22: rerank.ts deployed, live-tested, margin logged; vendor eval vs Cohere still open]
Voyage rerank-2.5-lite over merged candidates (top ~20 -> ordered top 6 +
margin), inside the resolve window, behind VOYAGE_RERANK env flag.
Also: eval harness compares Voyage vs Cohere on parse_traces real queries.
Verify: margin logged in steps; eval NDCG/top-1 up vs P1 baseline.

### P3. Smart skip-decide gate  [BUILT, RUNNING IN SHADOW 2026-08-22]

Shipped behind PARSE_SKIP_DECIDE (off | shadow | on), deployed on SHADOW:
decide still owns the answer, we only record whether the code fill agreed.

Findings from the first on-device shadow samples:
- Gate keys on rerank **topScore, NOT margin**. Real margins are tiny
  (0.012-0.094) precisely because the top candidates are near-duplicates of the
  same food; topScore (0.83-0.90) is what actually says "right food found".
- "100g paneer and 250ml toned milk" -> filled, AGREED with decide exactly.
- "250ml toned milk and 1 scoop whey" -> filled, DISAGREED on row: code fill
  took "100% Whey Protein 31g", decide took "Whey Protein 32g". Both defensible,
  near-identical macros. This is why the metric now records same_row AND
  same_macros: strict row equality would veto the skip over distinctions the
  user cannot perceive.
- "2 rotis and a bowl of dal" -> correctly BLOCKED ("unresolvable unit bowl"),
  fell through to decide as designed.

Flip to "on" when same_macros agreement holds over a real sample (target: 50+
parses, >95% same_macros, zero cases where code fill grounds an item decide
refused). Not yet: n=2 filled.

### P3 (original scope)
Per-item confidence gate (rerank margin + clear units + not a correction) ->
code fill with no decide call; mini-decide only for unsure items; ungrounded
items get the Haiku estimate in the fill step (chipped). Drona line: template
first, async call later. Target p50 ~3.5s clear path.
Verify: eval accuracy within noise of always-decide; latency p50 drop in traces.

### P4. Fast mode (user-facing)
mode: 'fast' param from client + toggle UI + persisted pref. Pipeline: lean
extract, then estimate call in PARALLEL with catalog+OFF (no FatSecret), OFF
timeout 1.5s, code pick, estimate fallback, template line. Target p50 ~2.7s.
Verify: on-device timing; estimate chip renders; toggle persists.

### P5. Super mode (credit-gated)
Web search moves into the resolve fan-out; cross-check (2+ sources within 10%
= verified badge); Sonnet decide with disagreements in-prompt; precise cache
table + write-through; challenge flow reroutes here. Client: Super button +
credit gate. Target <= 12s.
Verify: milky-mist-class query grounds from web; verified badge renders;
cache hit serves next identical query at Smart speed.

### P6. FatSecret Premier (external dependency)
When sales replies: set FATSECRET_REGION=IN (+ others), re-eval India coverage
(the original milky mist case must resolve at tier 2), revisit quota.

## Open questions

- **FatSecret market access (blocking the integration, email sent 2026-08-21).**
  Target markets: **US, India, UK, EU**. US matters too, and Premier Free
  covers exactly that, so the free tier is real value on day one and the paid
  conversation is only about the other three. The tension: Premier Free is
  documented as US-only, so we are asking them to confirm or waive that. If they
  will not, get the paid Premier quote for those three markets only (never all
  58 - price scales per market). Until it is signed, the web tier remains the
  branded fallback and costs latency, not money, so nothing is blocked.
  Note EU/UK are the CHEAPEST markets to lose: our catalog already carries CoFID
  (UK) + Ciqual (FR) generics and OFF is Europe-heavy. India is the real gap and
  the one ask worth paying for if they make us choose.
- INDB license text: confirm redistribution terms before ingest.
- Rerank vendor: Cohere vs Voyage; pick by eval NDCG on our own query log
  (parse_traces has every real query + what was picked).
- Commonality table refresh cadence (nightly cron vs trigger).

## Exploration findings (2026-08-22, ongoing)

Living companion: the Drona Parse Explorer artifact (clickable pipeline map +
improvement log). Open items surfaced by walking the code with the user:

- I1 (quality+latency, PROPOSED, user idea): corrections re-resolve and
  re-decide UNTOUCHED lines; a re-decide can silently flip an unchanged line to
  a different row. Fix: filter extItems to changed-only before resolve;
  keepUncoveredPrevious already restores the rest verbatim. Doubt => re-resolve.
- I2 (process, NEXT): eval corpus (parse_traces + synthetic + user cases)
  gating ALL prompt edits. Prereq for I1/I3.
- I3 (quality, after I2): prompt organization drift; rules split between system
  prompt and schema descriptions with no principle; name-field overloaded.
- I4 (cost, ACCEPTED): prompt cache dead on Haiku 4.5 (4096-token min, ~1.5k
  prefix). Do not pad. See memory reference-prompt-cache-haiku-minimum.
- I5 (latency, IN SHADOW): P3 skip-decide gate, see phase section above.
- I6 (quality, FIRST WORK ITEM after exploration, per user 2026-08-22):
  extract prompt holes found by field audit:
  deletion by text is impossible (nets restore + qty clamp), challenge+fix
  drops the fix, correction+addition undefined, multi-meal collapses to one
  section, mentioned food logs as eaten. Delete needs a contract change.
- I7 (quality, PROPOSED): strict tool use on extract. Schema is advisory
  today; proven trap: quantity emitted as string "250" sanitizes to 1, so
  "250ml milk" becomes 1 ml. strict:true + additionalProperties:false +
  full required lists kills the class. Verify Haiku 4.5 support first.
- I8 (product FEATURE, user decision 2026-08-22): full-day logging. One message
  ("breakfast was 2 eggs, lunch was dal chawal") logs every named meal to its
  own section. Needs meal type PER ITEM (extract schema + decide + card +
  client sections) and a rethink of the 500-char input cap. Gate:
  audit-multi-meal-day eval case.
- I10 (quality, PROPOSED): personalized household units. Container sizes
  (katori/bowl/glass/roti) vary +/-30% by household; spoon weights are physics
  and stay hardcoded. Learn per-user unit weights from edit history, inject
  into decide user_context, fall back to population defaults.
- I11 (quality, PROPOSED, user idea refined): unhonoured macro-changing
  qualifier (low fat / high protein / zero sugar / prep) with NO candidate
  honouring it => treat as no-acceptable-candidate: decide estimates (visible
  chip) instead of passing a generic row as a confident match; Super spends a
  targeted web search on that item. Brand alone does NOT trigger (generic rows
  are correct for commodity foods). Detector exists: unhonouredGrade, today a
  verify-time chip; move the signal before decide.
- I12 (latency, PROPOSED, user question): parallel per-item decide. Decide is
  ONE serial call; latency is output tokens at ~7.4 ms/tok (measured, 55
  parses, 262-1289 tok). N concurrent per-item calls => wall time ~2s at any
  meal size (7-item: 9.2s -> ~2s); cost is input tokens x N, ~1 paisa/meal.
  Blockers: meal_type (move to code) and drona_line (async/template).
  Composes with P3 (skip) and I1 (changed-only).
- I11b (quality, DRAFTED): DEFINE "acceptable candidate". The decide prompt
  says "No acceptable candidate: estimate" but never defines acceptable, so
  the rule fires on an undefined predicate. Proposed test and taxonomy:

    A candidate is ACCEPTABLE if eating it instead of what the user described
    moves the macros by less than ~10%. Judge the WORDS THE USER USED, not how
    close the names look.

    DROPPABLE (match the row anyway):
      - brand on a STANDARDIZED food (toned milk is 3% fat by regulation, so
        Amul = Mother Dairy): milk of a stated grade, curd, plain paneer, ghee,
        oil, atta, rice, dal, sugar, eggs
      - provenance/marketing: fresh, farm, pure, natural, organic, homemade,
        packet, tetra pack
      - regional synonyms: doodh = milk, dahi = curd, chawal = rice

    NOT DROPPABLE (no candidate carries it => estimate instead):
      - fat/grade: low fat, full fat, full cream, toned, double toned, skimmed
      - protein/sugar claims: high protein, zero sugar, no added sugar, diet
      - part/variant: yolk, white, whole, brown, wholewheat, maida
      - prep state: raw, boiled, roasted, fried, dried (2-3x density)
      - brand on a FORMULATED product (the recipe IS the product): protein bars
        and powders, biscuits, cereals, sauces, ready meals, flavoured yogurt
      - a DISH reduced to an ingredient: paneer butter masala is not Paneer

    Principle: commodity = composition fixed by standard or nature, brand is
    decoration. Formulated = composition is the manufacturer's recipe, brand IS
    the product. Same phrase shape ("amul toned milk" vs "quest protein bar"),
    opposite verdicts.

  Evidence from real logs 2026-08-23: "low fat paneer" -> Milky Mist Paneer,
  "high protein paneer" -> Milky Mist Paneer, "double toned milk amul" ->
  Amul Taaza Toned Milk (~38% kcal error). All silent.
  RISK: thin Indian branded coverage means stricter rules convert some grounded
  rows into estimates. Eval must measure the flip rate before shipping.
  Gates: accept-* cases in cases.ts (both directions).
- Eval corpus: 16 audit-derived cases landed in scripts/parse-meal-eval/cases.ts
  (audit-*) plus 5 acceptability cases (accept-*). I6*/I8/I11-tagged ones are
  EXPECTED to fail until fixed; they are the gates. Full corpus now 88 cases.
  Also fixed: eval Tier type was missing 'fatsecret' since that source landed.
