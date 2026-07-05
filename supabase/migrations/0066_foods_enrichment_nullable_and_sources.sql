-- 0066: make the catalog enrichment-ready for ingesting datasets one by one.
--
-- We ingest sources in sequence (USDA, then OFF, then IFCT/INDB). When a later,
-- richer source matches a food we already have, we want to fill missing fields,
-- not clobber good data. For that, a missing value must be distinguishable from a
-- real 0, so the extended macros become NULLABLE. `sources[]` records every dataset
-- that contributed to a row: it keeps OFF-touched rows identifiable for ODbL, and
-- distinguishes a single-source row from an enriched one. Core macros stay NOT NULL
-- (every dataset provides kcal/protein/carb/fat). Tables are empty (pre-launch).
-- Applied to live via Supabase MCP (project convention: never `db push`).

begin;

alter table public.foods alter column fiber_g   drop not null;
alter table public.foods alter column fiber_g   drop default;
alter table public.foods alter column sugar_g   drop not null;
alter table public.foods alter column sugar_g   drop default;
alter table public.foods alter column sat_fat_g drop not null;
alter table public.foods alter column sat_fat_g drop default;
alter table public.foods alter column sodium_mg drop not null;
alter table public.foods alter column sodium_mg drop default;

alter table public.foods add column if not exists sources text[];

commit;
