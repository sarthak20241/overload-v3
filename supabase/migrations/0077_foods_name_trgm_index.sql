-- 0077: speed up the food catalog search.
--
-- search_foods_ranked filters with `name ILIKE '%q%'` (leading wildcard), which
-- no btree index can serve — so it sequential-scanned all ~25k foods on every
-- keystroke (~44ms server-side, and growing with the catalog). A pg_trgm GIN
-- index on name makes that substring/ILIKE match index-backed (measured
-- 44ms -> 6ms for "chicken"). Purely additive; apply to live via Supabase MCP
-- apply_migration only (project rule: never db push).

create extension if not exists pg_trgm;

create index if not exists idx_foods_name_trgm
  on public.foods using gin (name gin_trgm_ops);

analyze public.foods;
