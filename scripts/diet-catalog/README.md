# diet-catalog build pipeline

Offline repo tooling that builds the food catalog for the macro tracker. It is **not
shipped code** — it runs locally (or in CI), and its committed output is what the app
bundles. See `.planning/diet-tracking-plan.md` → "Data sourcing" for the full rationale.

## What it produces

Two artifacts (committed, regenerated on refresh):

1. `lib/foods.generated.ts` — the bundled static `FOOD_LIBRARY` (offline base). Merged
   with / replaces the hand-curated starter list currently in `lib/foods.ts`.
2. `supabase/seed/foods_seed.generated.sql` — `INSERT`s for the global `foods` rows
   (`created_by` null), applied **as service role** so the rows stay global (not tagged
   to whoever runs them — the bug migration 0036 fixed for exercises). `ON CONFLICT DO
   NOTHING` against the `uq_foods_name_global` index makes re-seeding idempotent.

## The layered sourcing model (legal, not just technical)

Each layer uses the legally-correct source. **This is load-bearing, do not shortcut it.**

| Layer | Source | License | Rule |
|---|---|---|---|
| Gym staples + raw ingredients | USDA FoodData Central (SR Legacy + Foundation) | CC0 / public domain | Bundle freely. `source='usda'`. |
| Indian branded + barcode | Open Food Facts, `countries:india` + global gym brands | ODbL | Bundle **segregated** (`source='off'`) + attributed. |
| Indian raw ingredients | IFCT 2017 (ICMR-NIN) | copyrighted govt publication | **Reference only** until written permission. Do NOT ingest verbatim. |
| Indian cooked dishes | computed by us (see `indian-dishes.ts`) | our own work product | Bundle. `source='curated'`. |

### Hard guardrails (enforced in code where possible)

- **Never ingest IFCT 2017 / INDB / the `nodef/ifct2017` npm package / their Kaggle
  re-uploads verbatim.** They are copyright-restricted (NIN forbids electronic storage
  "for creating a product" without permission). Use only as a human reference.
- **For Indian cooked dishes, compute, do not copy.** Each dish in `indian-dishes.ts`
  is defined as an ingredient breakdown; macros are computed from the clean ingredient
  base (USDA + our curated raw values). Nutrient numbers are facts; a curated table is
  not. Computing our own rows sidesteps the copyright chain.
- **Open Food Facts rows stay segregated.** Tag every OFF-derived row `source='off'`,
  never merge OFF values irreversibly into a non-OFF row. This keeps ODbL share-alike
  scoped to that subset. Ship the attribution string (below) and a custom User-Agent on
  any live API call. Do not bundle OFF product images (CC BY-SA).
- **Attribution to ship in-app** (Settings → About / Licenses):
  - "Includes data from Open Food Facts, licensed under ODbL (opendatacommons.org/licenses/odbl)."
  - Courtesy: "Generic food data from FoodData Central, U.S. Department of Agriculture."

## Inputs (downloaded manually, git-ignored — not committed)

Place under `scripts/diet-catalog/data/` (git-ignored):

- `usda/` — USDA FDC bulk CSV download (SR Legacy + Foundation Foods).
  https://fdc.nal.usda.gov/download-datasets/  (CC0)
- `off/` — Open Food Facts bulk dump, filtered to India. Easiest is the country export
  or the Parquet via Hugging Face; or the full JSONL filtered on `countries_tags`.
  https://world.openfoodfacts.org/data  (ODbL)

The allow-lists in `allowlist.ts` keep the output small and high-quality (a curated
few-hundred-item catalog, not the multi-GB raw dumps).

## Run

```bash
# from repo root, once the data/ inputs are in place
npx tsx scripts/diet-catalog/build.ts
```

(If `tsx` is not installed: `npx -y tsx ...`, or wire an npm script.)

## Status

- **Compute-dishes: working.** Indian dishes computed from `indian-dishes.ts`.
- **USDA ingest: working.** Downloads SR Legacy (CC0), parses `food.csv` +
  `food_nutrient.csv`, matches the `USDA_ALLOWLIST`, emits authoritative per-100 g
  rows (`source='usda'`). Verified: chicken breast 165 kcal/31 g P, oats 379 kcal,
  olive oil 884 kcal. 31 picks land today; expand `USDA_ALLOWLIST` for more breadth.
- **OFF ingest: working (server catalog).** `scripts/diet-catalog/ingest-off.ts`
  pulls branded SKUs from the **search-a-licious** API (`search.openfoodfacts.org`) —
  no multi-GB dump needed. Gym brands global, Indian FMCG scoped to `en:india`,
  English/India names only, complete macro panels + plausibility guards. Emits
  `supabase/seed/off_foods.generated.sql` (`source='off'`, segregated per ODbL),
  loaded via `scripts/load-usda-seed.sh <seed>`. **LOADED to prod 2026-07-07: 788
  branded foods.** Reversible: `delete from public.foods where 'off' = any(sources)`.
  KNOWN GAP: search-a-licious does not expose `serving_quantity`/micros, so OFF rows
  ship with a canonical `100 g` serving only. Real servings + micros need OFF's
  per-barcode product API (`/api/v2/product/{barcode}`), which was returning 503 at
  build time — barcodes are stored on every row for a later backfill enrichment pass.
  The `buildOff()` in `build.ts` (the small bundled-offline library) is still a stub
  and unused for the server catalog.

Latest run emits 35 foods (31 USDA + 4 dishes) to `lib/foods.generated.ts` +
`supabase/seed/foods_seed.generated.sql`.
