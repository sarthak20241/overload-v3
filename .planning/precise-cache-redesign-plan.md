# Precise tier redesign (Jev-judged sources, searchable cache)

Status: 2026-09-26. Architecture agreed with the owner. The Tavily + Jev web
lookup is BUILT (uncommitted, branch claude/precise-tier-logging-costs-9470b2),
not yet probed against the live web, not deployed. The searchable cache and
Jev calls 1-2 are not built.

## Built: Tavily + Jev web lookup (step 1 of the web plan)

- `ai-coach/tavily.ts`: search + extract client, never throws, retries once
  without optional params on a 400, 432/433 read as out of credits.
- `ai-coach/tavilyLookup.ts`: search (India boost, label sites preferred) ->
  Jev noul per result (floor 0.6) -> panel cut in code -> one forced Haiku read
  (numbers as printed, per serving + grams, kJ) -> per-100 g and physics in
  code. Second search only when the first gave no panel. Extract only for a
  relevant page with no panel in its search text.
- `parseMeal.ts`: `webLookup: "anthropic" | "tavily"`; Tavily unusable -> falls
  back to the Anthropic lookup; "found nothing" does not fall back.
- `index.ts`: `PRECISE_WEB_PROVIDER` (default anthropic), `TAVILY_API_KEY`,
  `PRECISE_SEARCH_COUNTRY` (default india); Tavily credits logged as their own
  `provider='tavily'` row. Migration 0140 prices a credit at $0.008.
- Tests: `tavilyLookup.test.ts`, 18, each key behaviour mutation-checked.
- Probe: `WEB=tavily npx tsx tools/super-probe/run.ts` now prints cost.

Probe, 2026-09-26 (16 Indian packaged foods, catalog off): API run 16/16,
median kcal error 0.4%, worst 8.5%, 14/16 verified, $0.028 per food at
pay-as-you-go ($0.013 tokens at ~9.7k input, + 2 Tavily credits). Two CLI runs
15/16 and 15/15. Old path in prod: ~39k input tokens a log, ~$0.045 per food
looked up. Jev now also picks WHICH piece of each page is the panel (look 2),
and every kept page without full text is extracted (fixed Amul Lassi -23%).

To ship: apply 0140, set
`TAVILY_API_KEY` + `PRECISE_WEB_PROVIDER=tavily` as Supabase secrets, deploy
ai-coach (owner's word for deploy:yes).

## Goal

Precise gives accurate, consistent numbers. Web searches are allowed, time is
not a constraint, spend should stay low.

- **Accurate**: a served number comes from a source Jev judged to be exactly
  this food, and code checked the numbers.
- **Consistent**: the same food asked two ways lands on the same saved answer.
- **Cheap**: the web runs only when our own sources have no match.

## What we measured (live, to 2026-09-24)

- 17 Precise logs, $1.37, about $0.08 per log. 27 web lookups, 11 cache hits.
- One web lookup costs about $0.045 (2 search fees + about 15k page tokens).
  Everything else in a Precise parse is cheap.
- 23 of 27 lookups were plain foods whose web answer equalled the USDA row
  already in `foods` (almonds 579, pear 57, kiwi 61, chia 486, walnuts 654).
- The cache key is literal (`cacheKey`, preciseCache.ts): `eggs`, `whole eggs`,
  `boiled eggs` were three paid lookups.
- On a miss Precise goes straight to the web and never searches `foods`.
- Nothing checks that a web page is about the exact product (an Amul Mishti
  Doi page can vouch for Amul Masti Dahi).

## Architecture

```
message
  -> Jev intent router (log / create / other)            [exists]
  -> split call: one line per food, with amount, brand,  [exists: extract]
     state (raw, cooked, fried), restaurant if named
  -> per food, in parallel:
       A. search our sources   (free)
       B. Jev call 1: kind     (one request for the whole meal)
  -> Jev call 2: match, question chosen by kind          (one request)
  -> no confident match: 1-2 web searches
       -> Jev call 3: is each web source about exactly this food
       -> code: do two relevant sources agree within 10%
  -> final call: grams + card; "estimate" when nothing was relevant  [exists: decide]
  -> save the answer + the user's words to the Precise cache
```

### A. Search our sources

Sources: Precise cache, `foods` (usda, cofid, ciqual, off, curated,
web_verified). Search is the RECALL layer: loose on purpose, because Jev and
code decide what is actually the same food.

Three legs, merged and de-duplicated, top 8 go to Jev:

1. **Alias exact.** Normalised user words -> `precise_alias` -> row. Free,
   instant. Every phrase that ever resolved to a row becomes an alias, so a
   repeat costs nothing and skips Jev entirely.
2. **Fuzzy (pg_trgm).** On cache names + aliases, and `foods` via the existing
   `search_foods_ranked` (0079). Catches typos (panner/paneer), plurals and
   word order (rice cake pintola).
3. **Meaning (pgvector + Voyage).** `foods` already has voyage-3 embeddings on
   32k of 32k rows and `search_foods_semantic` (0080). Add the same column to
   the cache and aliases, embedded once at write time. Catches synonyms trigram
   cannot: curd / dahi / yogurt, brinjal / eggplant, chapati / roti. The query
   is embedded ONCE per food and reused for `foods` and the cache.

Gap found: the 16 `web_verified` rows promoted into `foods` have no embedding,
so meaning search cannot find them. The promotion job should embed on write.

#### How the cache gets its embeddings

- **Same model and shape as `foods`**: voyage-3, 1024 numbers, text
  `"name [brand], kind"`, `input_type: "document"`. One vector space, so one
  query vector searches both tables.
- **At write time**: after a new row or a new alias is saved, the edge function
  embeds it (a few tokens, a fraction of a millionth of a dollar) and updates
  the row. Not awaited: a Voyage failure must never cost the user their meal.
- **Safety net**: rows left with no embedding (Voyage down, rate limited) are
  filled by a backfill, same pattern as
  `scripts/diet-catalog/backfill-food-embeddings.ts`. The 28 existing rows are
  backfilled once when the migration lands.
- **Query side**: the food line is embedded once (`input_type: "query"`,
  `embedQuery` in index.ts) and that vector is passed to both
  `search_foods_semantic` and the cache RPC. No second Voyage call.
- **Aliases are embedded too**, so "dahi" typed once and matched to a curd row
  helps the next "dahi" with no Jev call, and helps "dahi 200g" by meaning.

### B. Jev call 1: what kind of food

One `choice` per food, examples for each:

- **plain**: one ingredient, no brand. Banana, peanuts, chia seeds, boiled egg.
- **packaged**: a branded product with a label. Amul cheese slice, Pintola rice
  cake, MyProtein casein.
- **restaurant**: a named restaurant or chain item. McDonald's McAloo Tikki,
  Domino's farmhouse pizza. Chains publish nutrition pages.
- **dish**: made food with no label or chain. Chole bhature, homemade dal,
  paneer bhurji.

Runs in parallel with the search: it needs only the food line.

### Jev call 2: which result is the same food

Question chosen by kind. All foods of the meal in one request.

- **plain**: same food AND same state. Raw rice is not cooked rice; boiled egg
  and egg are the same per 100 g.
- **packaged**: same brand, same product, same variant. Amul Gold is not Amul
  Taaza; low fat paneer is not paneer.
- **restaurant**: same chain, same item, same size when the size changes it.
- **dish**: same dish. "dal" is not "dal makhani".
- `none` when unsure.

Policy written as ordered cases with a worked example each (the shape that
took Drona card choice to 6/6). Tuned on the TUNE set only; eval inputs never
go into the prompt.

### Code gates on every Jev answer

- **Confidence floor**, tuned on the eval, start at 0.75. Under 0.55 is a coin
  flip in every Jev eval so far. Below the floor = no match = web.
- **Brand veto**: both sides branded and the brands differ = no match. A brand
  inside the food name counts (fixes `pintola rice cake`).
- **Kind rules**: a plain food may be answered by a usda / cofid / ciqual row
  with no web (owner decision 2026-09-26: yes). Packaged and restaurant need a
  row of that brand or chain. A dish may take a reference row or the web.

### Web, only on no match

1 or 2 searches (today's `runSuperLookup`, `max_uses: 2`). The model reports
each source separately with its url and name. Then:

- **Jev call 3**: for each reported source, is it about exactly this food?
  Irrelevant sources are dropped before any number is counted.
- **Code**: two relevant sources from different hosts within 10% = verified.
- **Dishes and restaurant items** from the web are shown as "typical, may vary"
  (owner decision 2026-09-26). Web agreement cannot tell us which recipe or how
  much oil.
- Nothing relevant: the final call estimates and the card says "estimate".

### How the web search works today, and what it costs

`runSuperLookup` (parseMeal.ts): one Haiku call PER FOOD with Anthropic's
server tool `web_search_20250305` (`max_uses: 2`), up to 4 turns, 20 s cap.
The tool pastes the full search results into Haiku's context, Haiku reads them
and calls `report_sources` with one reading per site. On a `pause_turn` the
whole conversation, results included, is sent again.

Measured on the 17 Precise logs: $1.37 total, 56 searches = $0.56 in search
fees ($10 per 1,000, see 0113), the rest tokens. Average input 39k tokens per
log, nearly all of it search result pages. So about 40% fees, 60% pages read.

### Web search plan, in order

1. **Stop searching what we already know** (the architecture above): our
   sources + Jev first. Biggest saving, no change to the web code.
2. **Seed restaurant chains once.** Chains publish nutrition tables. Load the
   common ones (McDonald's, Domino's, KFC, Subway, Starbucks, Burger King in
   India) into `foods` as a static source, so a chain item rarely needs the web.
3. **Batch the misses of one meal into one lookup call.** `runSuperLookup`
   already accepts a list; today `superLookupOne` calls it once per food, so
   the instructions and turn overhead are paid per food.
4. **Jev call 3 before counting.** Irrelevant sources are dropped, so a wrong
   page never becomes one of the "two agreeing sources".
5. **Trial a cheaper search path, behind a flag, eval-gated.** Our code calls a
   plain search API (Brave, Tavily, Exa or similar; pick on current price and
   India coverage), gets titles + urls + snippets for pennies, Jev judges which
   results are about exactly this food, our code fetches only those 2 or 3
   pages and cuts out the nutrition panel text, and Haiku reads only that
   (hundreds of tokens, not tens of thousands). Expected per-food web cost a
   small fraction of today's. Risks: some pages block fetches or need
   JavaScript, panel extraction is fiddly, and one more vendor key. Ships only
   if the super-probe cases (tools/super-probe) match today's accuracy.

### One good source is enough (owner decision 2026-09-26)

Two agreeing sources are a CONFIDENCE signal, not a requirement. One relevant,
trustworthy source (brand site, label listing, chain nutrition page) can
answer. Badge levels: `verified` (two relevant sources within 10%), `source`
(one relevant source, named on the card), `typical` (dish / restaurant),
`estimate` (nothing relevant). Promotion into `foods` still needs `verified`.

### Web candidates to test side by side

All three go through the same eval cases; accuracy on Indian brands decides.

- **Today**: Anthropic `web_search` in a Haiku call. About $0.045 per food.
- **Tavily + Jev + Haiku**: search $0.008 (1 credit, 1,000 free a month),
  `country: "india"`, `include_domains` prefer mode, `include_raw_content`; Jev
  picks relevant results; Haiku reads only the panel text. About $0.01-0.02.
- **Perplexity Sonar**: one call searches, reads and answers.
  `response_format` json_schema (per-source readings + urls),
  `search_domain_filter`, `web_search_options.user_location.country = "IN"`,
  `search_context_size: "low"`. Price: $1/M tokens in and out plus $5-6 per
  1,000 requests at low context. Estimate under $0.01 per food. Risk: the
  number is Sonar's reading and we cannot see the page it read, so Jev checks
  each cited result's title/snippet is the exact product and code runs
  checkAtwater on the numbers.

Tavily extras worth using: `include_answer` (an AI answer, no extra credit),
Extract (5 pages per credit, for pages search text missed), Map/Crawl (to seed
chain and brand nutrition pages into `foods` once). Tavily Research (4 to 250
credits a request) is overkill here.

### Beyond web search (later, discussed 2026-09-26)

- **The user's own label beats any search for packaged food.** Barcode scan ->
  `foods.barcode` / Open Food Facts (free). Label photo -> one Haiku vision
  call reads the printed panel. Exact numbers, a cent or less, and the saved
  answer serves everyone after. Needs a scanner screen and a native build;
  react-native-vision-camera v5 is already installed (form checker) and `foods`
  already has a `barcode` column. No scanner UI exists today.
- **Search where Indian labels live.** Prefer brand sites and grocery listings
  (BigBasket, Blinkit, Amazon.in, JioMart) via Tavily `include_domains` in
  `prefer` mode. Many show the panel as an IMAGE, which text extraction misses;
  a Haiku vision read of that image is the fallback.
- **Search API bake-off.** Tavily, Exa, Brave, Serper (Google results) through
  the same eval harness; India brand coverage decides, not the price sheet.

### Save the answer (consistency)

Whatever answered is written to the Precise cache with the user's words as an
alias: a web answer as a new row, a matched `foods` row as a pointer, a Jev
match as a new alias on the existing row. The next person asking the same
thing gets the same number for free.

## Data model (migration, next free number)

- `precise_alias(alias_key text primary key, row_id uuid, source text,
  confidence numeric, embedding vector(1024), created_at)`. `source` is
  `lookup` (the words that paid for the row) or `jev` (matched later).
- `precise_cache`: add `kind`, `food_id` (when the row points at `foods`),
  `embedding vector(1024)`, trigram index on `display_name`. Existing
  `cache_key` values become the first alias of each row.
- One RPC for cache candidates (alias exact + trigram + cosine), same result
  shape as `search_foods_ranked` so one hydrate path serves both.
- service_role only. REVOKE first, then grant (0102/0103 lesson).
- 90-day TTL unchanged, in both TS and SQL.

## Rollout

`PRECISE_MATCH_MODE` = `off` / `shadow` / `on`, same shape as FOOD_INTENT_MODE.

1. **Eval first**, no prod change. `scripts/precise-match/eval.mts`:
   - kind: labelled food lines across all four kinds;
   - match: (food, candidates, correct pick), weighted to near misses: raw vs
     cooked, low fat vs full, brand vs brand, variant vs variant, word-order
     swaps (chocolate milk / milk chocolate), plus the real misses above;
   - web relevance: reported sources that are and are not the exact product.
   TUNE and FRESH groups; FRESH is never used to tune. Gate: **zero false
   matches on FRESH** at the chosen floor.
2. **Shadow**: live parses keep today's path; the new path runs beside it and
   the trace records what it would have served. Read a week of rows.
3. **On**.

Deploys follow CLAUDE.md: `deploy:yes` only on the owner's word; the migration
goes live via MCP before the function that reads it.

## Cost model

Per food: alias hit $0; search + 3 Jev questions about $0.00003 plus one
Voyage query embedding (negligible); web only on no match, about $0.045.
Estimate on the measured lookups: 70 to 85% fewer web searches, falling further
as aliases accumulate.

## Open

- Jev call 1 and call 2 could merge into one request if the kind is not needed
  to pick call 2's question (it is today, so two calls).
- Whether a restaurant item with no chain page should fall back to "dish".
