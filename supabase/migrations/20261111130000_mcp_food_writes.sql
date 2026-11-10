-- Food writes for the MCP connector (ChatGPT / Claude, supabase/functions/mcp).
-- Plan: .planning/mcp-tools-plan.md, step 2.
--
-- 1. meal_entries.logged_via gains 'mcp': a line the user's assistant wrote.
--    The app reads it as neither 'ai' nor 'manual' (foodPatterns relogLabels,
--    yourFoods entryTrust ranks by origin first), Drona's day facts count only
--    'ai'/'ai_auto' as AI logs, and stamp_tier skips anything not 'ai'.
-- 2. mcp_requests: one row per request_id, so a retried call never logs twice.
-- 3. Three functions, one transaction each, so a failed write never leaves
--    half a meal behind. They take the user id as an argument (the function
--    runs with the service role; the Clerk OAuth token is not a Supabase
--    session), check every row against it, and only service_role may call them.
--
-- The lines are origin 'guess', source 'estimate': the numbers came from the
-- user's assistant, not our catalog. Food memory ranks 'guess' lowest
-- (origin_rank 1), so such a line never replaces a label, catalog or typed
-- food in user_food_cache; it waits as a lower version.

-- ── 1. logged_via ───────────────────────────────────────────────────────────
alter table public.meal_entries drop constraint if exists meal_entries_logged_via_check;
alter table public.meal_entries add constraint meal_entries_logged_via_check
  check (logged_via is null or logged_via in ('manual', 'ai', 'ai_auto', 'mcp'));

-- ── 2. request ids ──────────────────────────────────────────────────────────
create table if not exists public.mcp_requests (
  user_id     text not null references public.user_profiles (clerk_user_id) on delete cascade,
  request_id  text not null check (char_length(request_id) between 1 and 100),
  tool        text not null check (char_length(tool) <= 64),
  -- null while the first call runs; the saved answer after.
  result      jsonb,
  created_at  timestamptz not null default now(),
  primary key (user_id, request_id)
);
alter table public.mcp_requests enable row level security;
revoke all on table public.mcp_requests from anon, authenticated;

-- ── helpers ─────────────────────────────────────────────────────────────────

-- The user's meal of this type inside [p_start, p_end), made if missing.
create or replace function public.mcp_meal_for(
  p_user text, p_meal_type text, p_start timestamptz, p_end timestamptz, p_logged_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_id uuid;
begin
  if p_meal_type not in ('breakfast', 'lunch', 'dinner', 'snack') then
    raise exception 'bad meal type' using errcode = '22023';
  end if;
  if p_logged_at < p_start or p_logged_at >= p_end then
    raise exception 'logged_at outside the day' using errcode = '22023';
  end if;
  select id into v_id from meals
   where user_id = p_user and meal_type = p_meal_type
     and logged_at >= p_start and logged_at < p_end
   order by logged_at limit 1
   for update;
  if v_id is null then
    insert into meals (user_id, meal_type, logged_at) values (p_user, p_meal_type, p_logged_at)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- An entry row as the tools show it.
create or replace function public.mcp_entry_json(e meal_entries, p_meal_type text, p_logged_at timestamptz)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'id', e.id, 'meal', p_meal_type, 'logged_at', p_logged_at, 'name', e.food_name,
    'quantity', e.quantity, 'unit', e.serving_unit, 'grams', e.grams_logged,
    'kcal', e.kcal, 'protein_g', e.protein_g, 'carb_g', e.carb_g, 'fat_g', e.fat_g, 'fiber_g', e.fiber_g,
    'logged_via', e.logged_via)
$$;

-- Removes the meal if nothing is left in it (the app does the same, lib/mealCleanup.ts).
create or replace function public.mcp_drop_if_empty(p_meal uuid)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  delete from meals m where m.id = p_meal and not exists (select 1 from meal_entries e where e.meal_id = m.id)
$$;

-- ── 3a. log ─────────────────────────────────────────────────────────────────
-- p_items: [{name, quantity, unit, grams, kcal, protein_g, carb_g, fat_g, fiber_g}],
-- already checked by the edge function; the table checks hold anything it missed.
create or replace function public.mcp_log_food(
  p_user text, p_meal_type text, p_start timestamptz, p_end timestamptz, p_logged_at timestamptz,
  p_items jsonb, p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_meal uuid; v_base int; v_ids uuid[]; v_lines jsonb; v_result jsonb; v_prev jsonb; v_claimed int := 0;
begin
  if not exists (select 1 from user_profiles where clerk_user_id = p_user) then
    raise exception 'no profile' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'items must be 1 to 30 lines' using errcode = '22023';
  end if;

  if p_request_id is not null then
    insert into mcp_requests (user_id, request_id, tool) values (p_user, p_request_id, 'log_food')
    on conflict do nothing;
    get diagnostics v_claimed = row_count;
    if v_claimed = 0 then
      select result into v_prev from mcp_requests where user_id = p_user and request_id = p_request_id;
      if v_prev is null then
        raise exception 'same request still running' using errcode = '55P03';
      end if;
      return v_prev || jsonb_build_object('replayed', true);
    end if;
  end if;

  v_meal := mcp_meal_for(p_user, p_meal_type, p_start, p_end, p_logged_at);
  select coalesce(max(position) + 1, 0) into v_base from meal_entries where meal_id = v_meal;

  with ins as (
    insert into meal_entries (
      meal_id, food_name, quantity, serving_unit, grams_logged,
      kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg,
      position, source, origin, logged_via)
    select v_meal, left(trim(i.item->>'name'), 120),
      (i.item->>'quantity')::numeric, left(coalesce(nullif(trim(i.item->>'unit'), ''), 'serving'), 24),
      nullif((i.item->>'grams')::numeric, 0),
      (i.item->>'kcal')::numeric, (i.item->>'protein_g')::numeric, (i.item->>'carb_g')::numeric,
      (i.item->>'fat_g')::numeric, (i.item->>'fiber_g')::numeric, null, null, null,
      v_base + i.n - 1, 'estimate', 'guess', 'mcp'
    from jsonb_array_elements(p_items) with ordinality as i(item, n)
    returning id
  )
  select array_agg(id) into v_ids from ins;

  select jsonb_agg(mcp_entry_json(e, p_meal_type, m.logged_at) order by e.position)
    into v_lines from meal_entries e join meals m on m.id = e.meal_id where e.id = any(v_ids);

  v_result := jsonb_build_object('meal_id', v_meal, 'lines', v_lines);
  if p_request_id is not null then
    update mcp_requests set result = v_result where user_id = p_user and request_id = p_request_id;
  end if;
  return v_result;
end;
$$;

-- ── 3b. update one line ─────────────────────────────────────────────────────
-- p_set: the final values of the fields that change (the edge function works
-- them out, e.g. macros scaled to a new amount). Any of: name, quantity, unit,
-- grams, kcal, protein_g, carb_g, fat_g, fiber_g, origin, source.
-- p_meal_type / p_start / p_end / p_logged_at: set to move the line to another
-- meal or day; all null to leave it where it is.
create or replace function public.mcp_update_food_entry(
  p_user text, p_entry uuid, p_set jsonb,
  p_meal_type text default null, p_start timestamptz default null, p_end timestamptz default null,
  p_logged_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare e meal_entries; m meals; v_after meal_entries; v_target uuid; v_before jsonb; v_new_meal meals;
begin
  select me.* into e from meal_entries me join meals ml on ml.id = me.meal_id
   where me.id = p_entry and ml.user_id = p_user
   for update of me;
  if e.id is null then
    raise exception 'no such food line' using errcode = 'P0002';
  end if;
  select * into m from meals where id = e.meal_id;
  v_before := mcp_entry_json(e, m.meal_type, m.logged_at);

  if p_set ? 'origin' and p_set->>'origin' not in ('user_typed', 'label', 'catalog', 'recipe', 'guess', 'unknown') then
    raise exception 'bad origin' using errcode = '22023';
  end if;

  update meal_entries set
    food_name    = case when p_set ? 'name' then left(trim(p_set->>'name'), 120) else food_name end,
    quantity     = case when p_set ? 'quantity' then (p_set->>'quantity')::numeric else quantity end,
    serving_unit = case when p_set ? 'unit' then left(coalesce(nullif(trim(p_set->>'unit'), ''), 'serving'), 24) else serving_unit end,
    grams_logged = case when p_set ? 'grams' then nullif((p_set->>'grams')::numeric, 0) else grams_logged end,
    kcal         = case when p_set ? 'kcal' then (p_set->>'kcal')::numeric else kcal end,
    protein_g    = case when p_set ? 'protein_g' then (p_set->>'protein_g')::numeric else protein_g end,
    carb_g       = case when p_set ? 'carb_g' then (p_set->>'carb_g')::numeric else carb_g end,
    fat_g        = case when p_set ? 'fat_g' then (p_set->>'fat_g')::numeric else fat_g end,
    fiber_g      = case when p_set ? 'fiber_g' then (p_set->>'fiber_g')::numeric else fiber_g end,
    origin       = case when p_set ? 'origin' then p_set->>'origin' else origin end,
    source       = case when p_set ? 'source' then p_set->>'source' else source end
  where id = p_entry;

  if p_meal_type is not null then
    v_target := mcp_meal_for(p_user, p_meal_type, p_start, p_end, p_logged_at);
    if v_target <> e.meal_id then
      update meal_entries set meal_id = v_target,
        position = (select coalesce(max(position) + 1, 0) from meal_entries where meal_id = v_target)
      where id = p_entry;
      perform mcp_drop_if_empty(e.meal_id);
    end if;
  end if;

  select * into v_after from meal_entries where id = p_entry;
  select * into v_new_meal from meals where id = v_after.meal_id;
  return jsonb_build_object('before', v_before, 'after', mcp_entry_json(v_after, v_new_meal.meal_type, v_new_meal.logged_at));
end;
$$;

-- ── 3c. delete lines this connector wrote ───────────────────────────────────
-- Only logged_via = 'mcp' lines go; anything else in p_ids is reported back,
-- untouched, so a wrong call never removes what the user logged in the app.
create or replace function public.mcp_delete_food_entries(p_user text, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_deleted jsonb; v_meals uuid[]; v_kept uuid[]; v_mid uuid;
begin
  if p_ids is null or cardinality(p_ids) not between 1 and 50 then
    raise exception 'ids must be 1 to 50' using errcode = '22023';
  end if;
  with gone as (
    delete from meal_entries me using meals ml
     where me.meal_id = ml.id and ml.user_id = p_user
       and me.id = any(p_ids) and me.logged_via = 'mcp'
    returning me.*, ml.meal_type as mt, ml.logged_at as la
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', food_name, 'kcal', kcal, 'meal', mt, 'logged_at', la)), '[]'),
         array_agg(distinct meal_id)
    into v_deleted, v_meals from gone;
  if v_meals is not null then
    foreach v_mid in array v_meals loop perform mcp_drop_if_empty(v_mid); end loop;
  end if;
  select array_agg(x) into v_kept from unnest(p_ids) x
   where not exists (select 1 from jsonb_array_elements(v_deleted) d where (d->>'id')::uuid = x);
  return jsonb_build_object('deleted', v_deleted, 'not_deleted', coalesce(to_jsonb(v_kept), '[]'));
end;
$$;

-- Only the edge function (service_role) may call these.
revoke all on function public.mcp_meal_for(text, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.mcp_entry_json(meal_entries, text, timestamptz) from public, anon, authenticated;
revoke all on function public.mcp_drop_if_empty(uuid) from public, anon, authenticated;
revoke all on function public.mcp_log_food(text, text, timestamptz, timestamptz, timestamptz, jsonb, text) from public, anon, authenticated;
revoke all on function public.mcp_update_food_entry(text, uuid, jsonb, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.mcp_delete_food_entries(text, uuid[]) from public, anon, authenticated;
grant execute on function public.mcp_log_food(text, text, timestamptz, timestamptz, timestamptz, jsonb, text) to service_role;
grant execute on function public.mcp_update_food_entry(text, uuid, jsonb, text, timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.mcp_delete_food_entries(text, uuid[]) to service_role;

notify pgrst, 'reload schema';
