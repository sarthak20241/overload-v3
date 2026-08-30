# parse_meal eval baseline

The number every later change is judged against. Phase 0 gate of
`.planning/food-logging-consolidated-plan.md`.

Re-record this file at each phase gate. Do not overwrite the history table.

## How to run

```bash
npx tsx scripts/parse-meal-eval/run.ts
```

Env comes from `.env.local` (Supabase URL/anon key, `ANTHROPIC_API_KEY`,
`FATSECRET_*`, `VOYAGE_API_KEY`). Web search is OFF unless `EVAL_WEB_SEARCH=1`.
OFF lookups run in dry-run, nothing is written. A full run costs well under
$0.10 of Haiku and takes ~11 minutes.

Single cases: `ONLY=boiled-eggs,chicken-200g npx tsx scripts/parse-meal-eval/run.ts`

## READ THIS BEFORE JUDGING A NUMBER

**The suite is flaky by nature.** It drives a real LLM against live search, so
roughly 4 cases drift between identical runs. A change is judged by rerunning
ITS OWN failures, never by comparing one full-suite total to another.

**Some failures are load-bearing.** The `audit-*` and `accept-*` cases were
written to fail. They are gates: each one turns green when its improvement
lands, and until then a green would mean the gate is not testing anything.
Read the gate table before treating a failure as a regression.

## History

| Date | Pass | Code under test |
|---|---|---|
| 2026-08-23 | 76/88 | pre-fix, first baseline ever run |
| 2026-08-23 | **81/88** | + FatSecret sanitize fix (`38f3b6c`) |
| 2026-08-23 | 81/88 | + I17 proportional typo matcher (`b112e92`) |
| 2026-08-23 | 80/86 | + I16 comments, I7 `coerceQuantity` — Phase 1 complete |
| 2026-08-24 | 81/86 | + I11 grade routing + migration 0106 milk ladder |
| 2026-08-24 | 85/86 | + I6 deletion-by-text and challenge-carries-fix |
| 2026-08-24 | 86/86 | + I13 frequency-ranked staples |
| 2026-08-24 | 83/86 | + I1 changed-only correction resolve |
| 2026-08-28 | **84/87** | **FAST MODE** (`FAST_MODE=on`) — one fused call, no decide |
| 2026-08-29 | **86/88** | + fast piece counts (count reaches the grams); API/Haiku |
| 2026-08-29 | **8/10 subset** | + prompt de-overfitted, 3 held-out probes added; both failures are the pack-portion serving bug, not the prompt |
| 2026-08-30 | **83/91 CLI** | **FAST v2**: estimate-first rewrite - calorie-tracker prompt + 4 few-shots, est_ fields are line TOTALS (per-100 retired), tool renamed estimate_meal; kcal no longer flows through the model's 2-5x-high gram guesses (6 cashews: 42 g -> 48 kcal, truth ~52). Known gaps: thin-biscuit kcal prior ~2x (tea-milk-default), est_total_g display label runs hot on estimate lines (gram bounds on estimate-tier cases now measure the LABEL, not the macros), edamame protein under. Decline judgement unreliable on CLI runs. |

### Fast mode measures as accurate as the full pipeline, and much cheaper

Run `FAST_MODE=on npx tsx scripts/parse-meal-eval/run.ts` to score the whole
corpus through the no-decide path. Follow-up cases carry previousItems, so
runParseMeal ignores the mode for those by design - fast is first-shot only.

```
                 standard          fast
accuracy         83/86             84/87
avg latency      ~6500ms           3807ms      (-41%)
tokens/run       ~540k             243k        (-55%)
tier mix         catalog 73        catalog 72, estimate 12
```

Same accuracy, no decide call. The estimate share roughly doubles, which is the
DESIGN working rather than a regression: the accept gate refuses a row that does
not cover the user's words, and the fused naming call has already produced an
estimate to fall back on.

Remaining fast failures are known and not fast-specific: `chole-bhature`
(composite dish the model splits differently run to run), `audit-multi-meal-day`
and `audit-range-quantity` (both I8 gates, expected to fail until multi-meal
lands).

### Run cases in parallel

`EVAL_CONCURRENCY=6` runs six cases at a time; an ~11 minute serial run finishes
in ~2. Verdicts print in COMPLETION order, not corpus order, so read the case id
rather than the position. Per-case latency stays valid, but `avg latency` from a
parallel run is not comparable to a serial baseline - the cases are competing
for the same API.

Pair it with `EVAL_VIA_CLI=1` for a correctness sweep on the subscription
instead of the API key. The CLI shim is NOT the production path: it occasionally
returns prose instead of JSON, which shows up as `anthropic_502: no JSON in CLI
reply` on the decline cases. Judge declines from an API run.

### The prompt must not be tuned on this corpus

`FAST_EXTRACT_RULES` once named these cases' own inputs and quoted their
observed failure values back at the model ("4 marie biscuits is ~20 g and never
44"). Those cases then passed by recall and measured nothing.

Removing it entirely was measured too, and does NOT work: held out, a shape-only
prompt sizes nuts correctly (6 cashews at 9 g) but returns 60 g for four thin
biscuits and 82 g for two cream ones - worse than before the fix, and it fails
the same way on Monaco, which no prompt has ever named. The model's prior for
"a biscuit" is roughly a small pack.

So the prompt carries the RULE plus one line of category reference data, and
`probe-count-monaco` / `probe-count-cashews` / `probe-count-rusk` use foods no
prompt names. If a prompt edit passes the biscuit cases but fails the probes, it
taught the answers instead of the rule.

### Known failure: a catalog serving that is a PACK portion

`probe-count-monaco` and `probe-count-rusk` fail today, and not on the prompt.
OFF's `serving_size` is the manufacturer's suggested serving, which for biscuits
is several pieces: `Parle Monaco Classic Biscuits` carries `1 serving (14.4 g)`
(~3 crackers) and `Britannia Marie Gold` carries `1 serving (15 g)` (~3
biscuits). A piece count then multiplies THAT, so "3 monaco biscuits" logs 43.2
g. `isBasisServing` cannot catch it: these are real named portions, not a
per-100 basis in disguise. Fixing it needs the serving's piece count read out of
the label, or a per-piece anchor preferred over a pack one.

### DEBUG_STEPS=1 prints the pick for a failing case

Fast has no decide output to read, so a wrong line is undiagnosable without it.
`DEBUG_STEPS=1 FAST_MODE=on ONLY=<case> npx tsx ...` prints each `search_foods`
and `fast_fill` step. Five real bugs were found this way in one smoke run; all
five had been invisible.

### A run that starves mid-way is not a result

2026-08-28: a standard run scored 70/87 and I nearly recorded it as a
regression. 9 cases had died instantly with `anthropic_400: credit balance is
too low` and 4 more timed out while the API was refusing. Check the failure
BODIES before believing a drop - `grep -oE "threw: [^\"]{0,60}"` over the log
separates a real regression from an infrastructure one in one command.

### I1: the number went DOWN and that is not a regression

Every correction case passed, which is the check that matters here:
refine-samosa-small, refine-quantity, followup-adds-not-corrects,
audit-delete-by-text, audit-challenge-plus-fix, audit-correction-plus-addition.

The three failures - paneer-roti, marie-gold, mcaloo-tikki - are all
catalog-coverage cases, and all three PASS on rerun. This is the flakiness this
file warns about in its opening section: comparing one full-suite total to
another is exactly the mistake, and 86 -> 83 measures the dice, not the change.

Two of them came back better than they used to be, from the I11b taxonomy
rather than from I1:
```
mcaloo-tikki  McDonald's Cheeseburger -> "McAloo Tikki burger" (labelled estimate)
paneer-roti   Bhujia 609 kcal         -> Matar Paneer 166
```

### 86/86 is a clean run, NOT a claim that nothing is left

`chole-bhature` passed here and failed 2 of the 3 runs before it, giving a
different answer each time. Nothing about I13 fixed it; the dish still has no
catalog row and the model improvises. Read this row as "no regressions", not
as "the corpus is solved". The honest state of that case is in the I6 section
above.

### I6 (Phase 2a): both gates green, verified in production

```
100g paneer and 50g tofu   ->  Paneer 265 + Tofu 74
Remove the tofu            ->  Paneer 265           (tofu used to come back)
that seems high, make it 100g -> Paneer at 100 g    (fix used to be discarded)
```

The single remaining failure, `chole-bhature`, is flaky in a way unrelated to
this change: three runs gave three answers (a spurious Starbucks line, a clean
pass, then the whole meal collapsed into one "Lentils" row). It is one of the
7 common Indian dishes measured as absent from the catalog on 2026-08-23, so
with no row to land on the model improvises afresh each run. INDB ingest is
the fix; no prompt will make an absent row exist.

### Ranking sanity after 0106 (no regression)

Adding four graded milk rows plus Low Fat Paneer could have pulled plain
queries toward a graded row. It did not:

```
search_foods_ranked('paneer')          -> Paneer 265 first, Low Fat Paneer 3rd
search_foods_ranked('double toned milk')-> Double Toned Milk 47.1
search_foods_ranked('full cream milk') -> Full Cream Milk 87.6, then real
                                          brands at 89 and 87 (cross-validates
                                          the FSSAI derivation)
```

### Testing gotcha worth remembering

A device test typed while an UNLOGGED card is still on screen is not a clean
test. The client sends that card as `previous_items`, extract can read the new
text as a correction of it, and the results merge (a 2-item meal came back with
4 items). Reload the app between cases, or the trace will look like a ranking
regression that is not there.

### I11 (Phase 2b): the three grade gates went green, and grounded

They do not merely stop being wrong; they resolve from the CATALOG at the
right numbers rather than falling back to estimates:

```
audit-low-fat-paneer       Milky Mist Paneer 141 kcal -> Low Fat Paneer 95
audit-double-toned-300     Amul Taaza Toned 174       -> Double Toned Milk 141
accept-grade-double-toned                             -> Double Toned Milk 236
```

Verified in PRODUCTION on device, the original 2026-08-20 report:
`50g milky mist low fat paneer and amul double toned milk 300ml` ->
Low Fat Paneer 95 [catalog, high] + Double Toned Milk 141.3 [catalog, high].

The fix that mattered was migration 0106, not the routing code. The catalog
carried ONE graded milk row and it was mislabeled ('Toned Milk' at 48 kcal /
1.6 g fat is double-toned composition under a toned name), so routing could
only reach an estimate - and the model priced double toned at 47 kcal/100 ml
in one case and 76 in another. 0106 seeds the FSSAI ladder instead.

`audit-no-sugar-tea` failed once in that run and passes on both reruns
(grounds to Chai / Milk Tea 67.5). Flaky, per this file's own rule.

> Corpus is **86 cases** from `b112e92` onward: two duplicate cases were removed
> (see below). The 88-case runs above predate that.

### I17 regression check (no change)

Same 81. Failure sets differ by two cases in each direction, which is the
documented flakiness, not a regression:

- `audit-challenge-plus-fix` flipped to pass
- `audit-hindi-doodh` flipped to fail — "doodh" matched Parlē Agro **Smoodh**
  Chocolate. Ruled out as an I17 effect two ways: `nearWord("doodh","smoodh")`
  is `false` (2 edits against a budget of 1) and the old prefix rule rejected it
  too, so `wordsOverlap` never saw the pair; and the case passes on both reruns.
  The cause is search/rank plus a FatSecret timeout (tier mix `fatsecret` 6 -> 5,
  consistent with the documented ~4s cold-cache penalty).

### Removed cases (they contradicted their twins)

`qualifier-double-toned-milk` and `qualifier-low-fat-paneer` duplicated the
`audit-*` cases on identical input text with different bands. The milk one was
not merely redundant, it was **wrong**: it documented double toned as "~55-60
kcal/100 ml" (that is toned) and its band `[110,230]` PASSED on Amul Taaza Toned
at 174 kcal — certifying the exact bug `audit-double-toned-300` exists to catch.
The surviving cases now carry the FSSAI composition ladder that makes the
qualifier non-droppable: skimmed <0.5% fat ~35 kcal/100 ml, double toned 1.5%
~42, toned 3.0% ~58, full cream 6% ~87.

### What the fix moved

`sanitizeItems` did not accept `"fatsecret"`, so every FatSecret pick was
relabelled `"estimate"` and, because the decide schema tells the model to omit
macros whenever a `food_id` is set, shipped with no numbers at all.

```
boiled-eggs   0kcal/0p  [estimate]  ->  231kcal/18.8p [fatsecret]
chicken-200g  0kcal/0p  [estimate]  ->  390kcal/59.2p [fatsecret]
```

Tier mix tells the same story: `fatsecret` went 0 -> 6 and `estimate` 14 -> 8.
Before the fix the source contributed nothing to any parse.

## Current baseline: 81/88

```
tier mix:     {"catalog":72,"fatsecret":6,"estimate":8}
avg latency:  6666ms
total tokens: 509221
OFF lookups:  113 (dry run)
```

### Phase 1 result: 80/86 (93.0%, vs 92.0% at the 81/88 baseline)

```
tier mix:     {"catalog":71,"fatsecret":4,"estimate":11}
avg latency:  6266ms
```

Six failures, and **five are gates**. Only `paneer-roti` is real; `mcaloo-tikki`
passed this run (it is one of the flaky ones). `accept-grade-double-toned`
appears here for the first time because the contradictory `qualifier-*` case
that used to mask it is gone — the gate is doing its job.

| Case | Kind | Owner |
|---|---|---|
| `audit-low-fat-paneer` | GATE | Phase 2b (I11) |
| `audit-double-toned-300` | GATE | Phase 2b (I11) |
| `accept-grade-double-toned` | GATE | Phase 2b (I11) |
| `audit-delete-by-text` | GATE | Phase 2a (I6) |
| `audit-multi-meal-day` | GATE | Phase 9 (I8) |
| `paneer-roti` | **REAL** | see below |

### Why `paneer-roti` fails every single run

Not ranking. **There is no Paneer Bhurji row in the catalog**, so the query
lands on `Bhujia` — a deep-fried snack at 609 kcal — and a paneer dish is
logged at roughly 3x its calories, confidently and with no chip.

Probed 33 common Indian dishes: 26 present, 7 missing (`paneer bhurji`,
`chole bhature`, `misal pav`, `gobi paratha`, `methi thepla`,
`sabudana khichdi`, `bisibelebath`). The gap is narrow; the failure MODE is the
finding — a missing row degrades to a *different food*, not to an estimate.
That is the `acceptCandidate` word-coverage argument, and why pulling it
forward into Phase 2b is proposed.

### The original 7 failures (81/88 run, kept for history)

Five are gates. Two are real.

| Case | Kind | Owner | What happens today |
|---|---|---|---|
| `audit-low-fat-paneer` | GATE | Phase 2b (I11/I11b) | "low fat paneer" takes a full-fat row; 172 kcal/50g vs expected 80-120 |
| `audit-double-toned-300` | GATE | Phase 2b (I11/I11b) | "double toned" takes Amul **Toned**; 174 kcal vs expected 90-140 |
| `audit-delete-by-text` | GATE | Phase 2a (I6) | deletion by text is impossible; the removed food comes back |
| `audit-challenge-plus-fix` | GATE | Phase 2a (I6) | a challenge carrying a fix drops the fix and declines |
| `audit-multi-meal-day` | GATE | Phase 9 (I8) | a whole day collapses to one meal section |
| `paneer-roti` | **REAL** | unassigned | "paneer bhurji" resolves to Bhujia / Egg Bhurji. The query ladder drops leading words, so the search runs on "bhurji". Catalog now merges both ends but still loses this one. Flaky across runs, always wrong |
| `mcaloo-tikki` | **REAL** | unassigned | "McAloo Tikki" resolves to a McDonald's Cheeseburger / Burger King Hamburger. Right brand, wrong product. Indian menu-item coverage gap; also a candidate-acceptance failure since "tikki" is uncovered |

Both real failures are the same shape as the acceptance work in Phase 6:
a candidate that shares a word (or a brand) but is not the food. The
`acceptCandidate` word-coverage rule is the thing that should reject them, so
re-test both once it exists rather than patching the ladder now.
