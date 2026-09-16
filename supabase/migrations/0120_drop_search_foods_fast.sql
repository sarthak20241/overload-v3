-- DRAFT, NOT APPLIED. Do not run this against the live database without
-- Sarthak's say-so; apply it through the Supabase MCP like every other
-- migration in this project (never `db push`).
--
-- WHY: 0111 added a LIKE-only pair of search functions for Quick mode. The
-- ranked function's `<%` word-similarity path cost ~942ms of CPU for 'milk'
-- against 29ms for the LIKE tiers, and Quick could not afford that inside a
-- sub-second budget. Quick reached them through the `lean` flag and nothing
-- else did.
--
-- Quick stopped searching the catalog entirely on 2026-09-15 (PR #176): it now
-- returns the model's own estimate and makes no lookup at all. The `lean` flag
-- was removed in the commit that carries this file, so as of that commit NO
-- caller anywhere in the repo names either function. Verified by grepping the
-- whole tree, scripts/ and tests included:
--   search_foods_fast              -> only 0111 itself (its own inner call)
--   search_foods_fast_with_servings -> only 0111 itself
--
-- NOT DROPPED HERE: search_foods_ranked* and search_foods_semantic*. Thorough
-- and Precise still call both and are untouched by this work.
--
-- REVERSIBLE: re-running 0111 recreates both functions unchanged.

-- _with_servings wraps the base function, so it goes first.
drop function if exists public.search_foods_fast_with_servings(text, int);
drop function if exists public.search_foods_fast(text, integer);
