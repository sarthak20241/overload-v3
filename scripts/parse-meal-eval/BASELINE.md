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
| 2026-08-23 | 81/88 | + I17 proportional typo matcher (`b112e92`) — **current baseline** |

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

### The 7 failures

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
