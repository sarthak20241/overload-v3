-- 0069: schema-boundary invariants for the diet log + preserve "unknown vs zero"
-- on the meal_entries nutrient snapshot (PR #44 review).
--
-- 1) CHECK constraints so a buggy/offline client can't persist values that the
--    nutrition-stat rollup would then treat as real:
--      * meal_entries.quantity > 0, position >= 0, grams_logged null-or-> 0
--      * core macros (kcal/protein/carb/fat) >= 0  (stay NOT NULL — always known)
--      * extended macros >= 0 when present
--      * user_profiles nutrition targets >= 0 when present
-- 2) Make the EXTENDED snapshot columns (fiber/sugar/sat_fat/sodium) NULLABLE and
--    drop their default, mirroring foods in 0066. A partially-enriched food logged
--    today kept "unknown" as 0 before this; now NULL survives the log, so a future
--    "unknown vs 0 g" surface can tell them apart. Core macros stay NOT NULL (the
--    stat trigger sums only those; a NULL there would poison daily totals).
-- Fix-forward: 0047/0065 are already applied live; live had no violating rows when
-- this ran. Applied live via Supabase MCP (project convention: never `db push`).

begin;

-- 2) nullable extended snapshot (match public.foods, 0066)
alter table public.meal_entries alter column fiber_g   drop not null;
alter table public.meal_entries alter column fiber_g   drop default;
alter table public.meal_entries alter column sugar_g   drop not null;
alter table public.meal_entries alter column sugar_g   drop default;
alter table public.meal_entries alter column sat_fat_g drop not null;
alter table public.meal_entries alter column sat_fat_g drop default;
alter table public.meal_entries alter column sodium_mg drop not null;
alter table public.meal_entries alter column sodium_mg drop default;

-- 1) meal_entries invariants
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meal_entries_quantity_positive') then
    alter table public.meal_entries add constraint meal_entries_quantity_positive check (quantity > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meal_entries_position_nonneg') then
    alter table public.meal_entries add constraint meal_entries_position_nonneg check (position >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meal_entries_grams_logged_positive') then
    alter table public.meal_entries add constraint meal_entries_grams_logged_positive
      check (grams_logged is null or grams_logged > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meal_entries_core_macros_nonneg') then
    alter table public.meal_entries add constraint meal_entries_core_macros_nonneg
      check (kcal >= 0 and protein_g >= 0 and carb_g >= 0 and fat_g >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meal_entries_ext_macros_nonneg') then
    alter table public.meal_entries add constraint meal_entries_ext_macros_nonneg
      check ((fiber_g   is null or fiber_g   >= 0)
         and (sugar_g   is null or sugar_g   >= 0)
         and (sat_fat_g is null or sat_fat_g >= 0)
         and (sodium_mg is null or sodium_mg >= 0));
  end if;
end $$;

-- 1) nutrition targets on user_profiles
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_nutrition_targets_nonneg') then
    alter table public.user_profiles add constraint user_profiles_nutrition_targets_nonneg
      check ((daily_calorie_target is null or daily_calorie_target >= 0)
         and (protein_target_g    is null or protein_target_g    >= 0)
         and (carb_target_g       is null or carb_target_g       >= 0)
         and (fat_target_g        is null or fat_target_g        >= 0));
  end if;
end $$;

commit;
