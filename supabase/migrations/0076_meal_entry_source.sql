-- 0076: meal_entries.source — record where an AI-logged food's macros came from.
--
-- The Drona parse path (the "Tell Drona what you ate" bar AND the new "Ask Drona
-- to find it" fallback on an empty catalog search) resolves each food through a
-- ladder: catalog → live Open Food Facts → web search → estimate. logged_via='ai'
-- already marks an entry as AI-created, but not whether its numbers are a real
-- product-label / web hit versus a pure estimate. This column stores that so the
-- diary can later distinguish "found" from "estimated".
--
-- Nullable: manual picker logs leave it null (logged_via already separates
-- manual vs ai). Purely additive. Apply to live via Supabase MCP apply_migration
-- only (project rule: never db push). meal_entries is not tracked in schema.sql,
-- so there is nothing to mirror there.

alter table public.meal_entries
  add column if not exists source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meal_entries_source_check') then
    alter table public.meal_entries add constraint meal_entries_source_check
      check (source is null or source in ('catalog', 'off', 'web', 'estimate'));
  end if;
end $$;
