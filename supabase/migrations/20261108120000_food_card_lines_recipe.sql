-- food_card_lines.recipe: a dish built from its parts (Precise step 5,
-- ai-coach/recipe.ts) keeps its parts in the thread store, so restore_card,
-- read_card and copy_lines hand them back, not only the line's 160-character
-- note. Same shape as meal_entries.recipe (20261107120000): a JSON array of
-- {name, grams, per100, source, assumed}.
--
-- Additive and re-runnable. The edge function works before and after it:
-- before, food_card_write ignores the field and reads return no recipe.
-- Apply to live via Supabase MCP apply_migration only (project rule).

alter table public.food_card_lines
  add column if not exists recipe jsonb;

-- 1 to 20 parts: the same bound as parseRecipe's MAX_PARTS
-- (supabase/functions/_shared/foodOrigin.ts) and meal_entries.recipe. Raise
-- them together. Each part is checked on read (parseRecipe), not here.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'food_card_lines_recipe_check') then
    alter table public.food_card_lines add constraint food_card_lines_recipe_check
      check (recipe is null or (jsonb_typeof(recipe) = 'array' and jsonb_array_length(recipe) between 1 and 20));
  end if;
end $$;

-- The one conditional write (20261106120000), now writing `recipe` too.
-- Everything else is unchanged.
create or replace function public.food_card_write(
  p_card_id uuid,
  p_base_version integer,
  p_lines jsonb,
  p_client_id text default null,
  p_status text default null,
  p_meal_type text default null
)
returns table (out_version integer, out_written boolean, out_retry boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_new integer;
  v_cur integer;
  v_last text;
begin
  update public.food_cards c
     set version = p_base_version + 1,
         last_client_id = p_client_id,
         status = coalesce(p_status, c.status),
         meal_type = coalesce(p_meal_type, c.meal_type),
         max_line_no = greatest(c.max_line_no, coalesce((
           select max(substring(e->>'line_id' from 2)::integer)
             from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
            where e->>'line_id' ~ '^L[0-9]{1,6}$'
         ), 0)),
         updated_at = now()
   where c.id = p_card_id
     and c.version <= p_base_version
     and (p_client_id is null or c.last_client_id is distinct from p_client_id)
  returning c.version into v_new;

  if v_new is null then
    select c.version, c.last_client_id into v_cur, v_last from public.food_cards c where c.id = p_card_id;
    -- out_retry: this client id made the current version (a retried send),
    -- as against a base older than the server's (another write got there).
    return query select v_cur, false, (p_client_id is not null and v_last is not distinct from p_client_id);
    return;
  end if;

  insert into public.food_card_lines (
    card_id, version, line_id, line_no, name, said_name, grams, quantity, unit,
    kcal, protein_g, carb_g, fat_g, fiber_g, source, source_ref, confidence, note, meal_type, recipe
  )
  select p_card_id, v_new, e.j->>'line_id', e.ord::integer, e.j->>'name', e.j->>'said_name',
         (e.j->>'grams')::numeric, (e.j->>'quantity')::numeric, e.j->>'unit',
         (e.j->>'kcal')::numeric, (e.j->>'protein_g')::numeric, (e.j->>'carb_g')::numeric,
         (e.j->>'fat_g')::numeric, (e.j->>'fiber_g')::numeric,
         e.j->>'source', e.j->>'source_ref', e.j->>'confidence', e.j->>'note', e.j->>'meal_type',
         -- A dish's parts: kept only as a non-empty array (the edge function
         -- checks each part with parseRecipe when it reads them back).
         case when jsonb_typeof(e.j->'recipe') = 'array' and jsonb_array_length(e.j->'recipe') between 1 and 20
              then e.j->'recipe' end
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as e(j, ord);

  return query select v_new, true, false;
end;
$$;

revoke all on function public.food_card_write(uuid, integer, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.food_card_write(uuid, integer, jsonb, text, text, text) to service_role;
