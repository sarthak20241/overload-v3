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
the saved entries and trace.

A deleted log means "I did not eat this", not "wrong food" (owner decision
2026-10-12, migration `20261012160000_food_memory_survives_delete`):

- Deleting a food's newest log moves its cache row to the next newest kept log
  of that food. The row goes only when no kept log is left.
- Each alias keeps every log that confirmed it (`alias_evidence.entry_ids`, the
  20 newest) and lives while any of them is kept. Entry and whole-meal deletes
  remove only their own logs from that list.
- A swap (a log renamed to a food with another name key) drops every alias that
  log confirmed, whatever else confirmed it. A rename that keeps the name key
  ("Nutrifit Dahi") is not a swap.

Before this, deleting the newest log cascaded away the whole row and every
alias on it. `food_memory_private.repair_lost_memory(apply)` restores what that
removed, from proof still in the diary: each lost food from its newest kept
log, and each alias only where a kept log matches, unchanged, the
high-confidence parse that resolved the user's words to it. Run it with
`false` first: it returns the plan and writes nothing. It is idempotent.

Food additions and identity replacements in follow-ups use the same personal
memory, saved-meal matching and precise cache as first-shot logs. Precise
retains its source matching and web lookup after a cache miss. Quick follow-ups
use the full extraction/correction pipeline so additions and edits preserve the
existing card. Pure questions, explicit research requests and existing card
quantity edits do not consult personal memory; manual portions rescale the
card's own numbers, including lines without a catalogue ID. Untouched lines
retain their numbers and meal sections. If decide omits a resolved food, the
fallback keeps its provenance, alias evidence and verification status.

## Validation

```sh
deno test --allow-all supabase/functions/ai-coach/userFoodMemory.test.ts
deno test --allow-all supabase/functions/ai-coach/followUpLogging.test.ts
deno run --allow-read --allow-env --allow-net scripts/personal-food-memory/eval.ts
```

The live eval uses the real matcher and pinned Jev model, with no Anthropic
calls. Set `FOOD_MEMORY_ENV_FILE` to an env file outside the checkout if needed.
The 24 cases include product shorthand, competing flavours, brand/ingredient
conflicts and additional products held out from the initial diagnosis.

Run `supabase/tests/personal_food_aliases.sql` on the migrated database. It
checks save-only learning, auto-log ordering, edited cards, replacements, Undo,
provenance and user isolation under authenticated Clerk claims, then rolls
back all synthetic fixtures. Also run
`supabase/tests/personal_food_alias_cleanup.sql` to verify historical-entry
Undo, whole-meal cascades, selective cleanup, ownership and trigger privileges,
`supabase/tests/personal_food_memory_survives_delete.sql` for deletes, swaps and
renames, and `supabase/tests/personal_food_memory_repair.sql` for the repair.

All four also run locally on an in-memory Postgres, before anything touches the
live database:

```sh
deno run --node-modules-dir=none --allow-read --allow-env --allow-net --allow-write --allow-sys supabase/tests/food_memory_local.ts
```

## Deploy and observe

1. Apply `20261001024340_personal_food_aliases.sql`, then the
   `personal_food_cache_grants` and `personal_food_cache_indexes` migrations
   with Supabase MCP, followed by `personal_food_alias_owner_cleanup`. The warm-up
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
`cache_auto_log_aliases`, `retract_food_aliases`, and `retract_meal_food_aliases` triggers. No diary rows need
changing.
