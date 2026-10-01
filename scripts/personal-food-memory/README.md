# Personal food shorthand

Confirmed aliases live on each user's `user_food_cache` row. Food snapshots
are learned from saved diary entries; aliases additionally need a matching
trusted parse item carrying `memory_input_name`. Parse previews never confirm
an alias. Existing apps need no release: a database trigger matches saved
cards against their trace, and successful auto-log traces confirm server writes.

Exact aliases resolve without Jev before shortlist limits. New shorthand uses
`personal-shorthand-v1`: omitted descriptors are unspecified; explicit brand,
flavour, ingredient and preparation conflicts still reject a candidate. Distinct
passing products are ambiguous, even when their nutrition is equal. The parser
asks for a more specific name rather than substituting another food for an
ambiguous personal match. Ordinary lookup misses keep the existing pipeline.

The user's own number overrides, nutrition tier eligibility, and follow-up
correction behavior remain intact. Cache rows retain per-100 nutrition and
servings, so each request scales its new portion. Alias provenance references
the saved entry and trace. Undo/product replacement retracts that evidence;
deleting the latest snapshot deletes its cache row conservatively.

## Validation

```sh
deno test --allow-all supabase/functions/ai-coach/userFoodMemory.test.ts
deno run --allow-read --allow-env --allow-net scripts/personal-food-memory/eval.ts
```

The live eval uses the real matcher and pinned Jev model, with no Anthropic
calls. Set `FOOD_MEMORY_ENV_FILE` to an env file outside the checkout if needed.
The 24 cases include product shorthand, competing flavours, brand/ingredient
conflicts and additional products held out from the initial diagnosis.

Run `supabase/tests/personal_food_aliases.sql` on the migrated database. It
checks save-only learning, auto-log ordering, edited cards, replacements, Undo,
provenance and user isolation under authenticated Clerk claims, then rolls
back all synthetic fixtures.

## Deploy and observe

1. Apply `20261001024340_personal_food_aliases.sql`, then the
   `personal_food_cache_grants` and `personal_food_cache_indexes` migrations
   with Supabase MCP. The warm-up
   uses only real saved entries in the recent window and guesses no aliases.
2. Run the SQL integration checks, then deploy `ai-coach` from this PR's tested
   commit using `Deploy Edge Functions` workflow dispatch. No mobile OTA required.
3. Observe `parse_traces.steps` where `tool=user_memory` and
   `result.policy=personal-shorthand-v1`. `result.path` distinguishes Jev from
   confirmed aliases; `decision.reason` records ambiguous/missed matches.
4. Track alias confirmations, direct alias hits, declined ambiguous requests,
   subsequent correction requests, and web lookups after memory misses. A
   correction is an investigation signal, not proof that the identity was wrong.

No absolute model accuracy is claimed. Save-and-repeat alias behavior is
covered deterministically; first-use shorthand remains a model judgment.
Rollback is redeploying the preceding `ai-coach` commit. The new cache tables
and triggers can remain inert; to stop new learning, drop `cache_saved_food`,
`cache_auto_log_aliases`, and `retract_food_aliases` triggers. No diary rows need
changing.
