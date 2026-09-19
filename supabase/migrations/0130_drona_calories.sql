-- 0130_drona_calories.sql — B1: lower calories when logging is good and weight is flat
--
-- The first card the MODEL decides (plan section 3). This file is the data
-- and the two moves; the gate, the validator and the prompt are TS.
--
--   get_drona_diet_facts   the series the model reads: food by day, weight by
--                          day, every past calorie change from the diary, the
--                          body numbers a safety floor needs. Service role only.
--   drona_apply_targets    "Set 2000 kcal". Profile targets, and the current
--                          phase's, with the macros re-derived on the user's
--                          own energy split (the same rule the goal sheet uses).
--   drona_undo_targets     puts the old four numbers back, seven days.

create or replace function public.get_drona_diet_facts(p_user_id text, p_as_of date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with profile as (
    select clerk_user_id, tier, tier_expires_at, gender, height_cm, weight_kg,
           case when date_of_birth is not null
                then extract(year from age(p_as_of, date_of_birth))::int end as age_years,
           daily_calorie_target, protein_target_g, carb_target_g, fat_target_g
      from user_profiles where clerk_user_id = p_user_id
  ),
  phase as (
    select ph.id, ph.diet_calorie_target, ph.diet_protein_g, ph.diet_carb_g, ph.diet_fat_g
      from coach_programs p
      join coach_program_phases ph
        on ph.program_id = p.id
       and p_as_of >= p.start_date + (ph.start_offset_weeks * 7)
       and p_as_of <  p.start_date + ((ph.start_offset_weeks + ph.duration_weeks) * 7)
     where p.user_id = p_user_id and p.status = 'active'
     limit 1
  ),
  food as (
    select coalesce(jsonb_agg(jsonb_build_object('day', day, 'kcal', round(kcal)::int, 'protein_g', round(protein_g)::int)
                              order by day desc), '[]'::jsonb) as items
      from user_nutrition_stats
     where user_id = p_user_id and day > p_as_of - 28 and day <= p_as_of and (kcal > 0 or protein_g > 0)
  ),
  weight as (
    select coalesce(jsonb_agg(jsonb_build_object('day', metric_date, 'kg', round(value::numeric, 1))
                              order by metric_date desc), '[]'::jsonb) as items
      from daily_metrics
     where user_id = p_user_id and metric_type = 'bodyweight_kg'
       and metric_date > p_as_of - 28 and metric_date <= p_as_of
  ),
  changes as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', occurred_at, 'source', source, 'card_id', card_id,
             'from', (changes->'daily_calorie_target'->>'from')::int,
             'to',   (changes->'daily_calorie_target'->>'to')::int
           ) order by occurred_at desc), '[]'::jsonb) as items,
           max(occurred_at) as last_at
      from (
        select occurred_at, source, card_id, changes
          from plan_changes
         where user_id = p_user_id and entity = 'targets' and action = 'changed'
           and changes ? 'daily_calorie_target'
         order by occurred_at desc limit 6
      ) recent
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'as_of', p_as_of,
    'tier', (select tier from profile),
    'tier_expires_at', (select tier_expires_at from profile),
    'body', jsonb_build_object(
      'gender', (select gender from profile),
      'height_cm', (select height_cm from profile),
      'weight_kg', (select weight_kg from profile),
      'age_years', (select age_years from profile)
    ),
    'targets', jsonb_build_object(
      'kcal', (select daily_calorie_target from profile),
      'protein_g', (select protein_target_g from profile),
      'carb_g', (select carb_target_g from profile),
      'fat_g', (select fat_target_g from profile)
    ),
    'phase', case when (select id from phase) is null then null else jsonb_build_object(
      'id', (select id from phase),
      'kcal', (select diet_calorie_target from phase),
      'protein_g', (select diet_protein_g from phase),
      'carb_g', (select diet_carb_g from phase),
      'fat_g', (select diet_fat_g from phase)
    ) end,
    'food', (select items from food),
    'weight', (select items from weight),
    'target_changes', (select items from changes),
    'days_since_target_change', (select (p_as_of - last_at::date) from changes)
  ));
$function$;

revoke all on function public.get_drona_diet_facts(text, date) from public, anon, authenticated;
grant execute on function public.get_drona_diet_facts(text, date) to service_role;

-- ── The move ─────────────────────────────────────────────────────────────────
-- Four numbers that add up, on the user's own energy split (lib/dietData
-- macrosForKcal): protein and fat round first, carbs take the leftover.
create or replace function private.macros_for_kcal(p_kcal int, p_protein int, p_carb int, p_fat int)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_p numeric := coalesce(p_protein, 0) * 4;
  v_c numeric := coalesce(p_carb, 0) * 4;
  v_f numeric := coalesce(p_fat, 0) * 9;
  v_total numeric := 0;
  v_protein int; v_fat int; v_carb int;
begin
  v_total := v_p + v_c + v_f;
  if v_total <= 0 then
    -- nothing to take a ratio of: the goal sheet's default split
    v_p := 0.30; v_c := 0.40; v_f := 0.30;
  else
    v_p := v_p / v_total; v_c := v_c / v_total; v_f := v_f / v_total;
  end if;
  v_protein := greatest(0, round(p_kcal * v_p / 4));
  v_fat     := greatest(0, round(p_kcal * v_f / 9));
  v_carb    := greatest(0, round((p_kcal - v_protein * 4 - v_fat * 9) / 4.0));
  return jsonb_build_object('protein_g', v_protein, 'carb_g', v_carb, 'fat_g', v_fat);
end;
$function$;

-- Sets or restores the four targets from a card's payload. Moves only while
-- the profile still holds what the card said it did; a hand edit wins.
create or replace function private.drona_targets_move(p_card_id uuid, p_undo boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_payload jsonb;
  v_from int; v_to int; v_expect int; v_target int;
  v_current int;
  v_macros jsonb;
  v_phase uuid;
begin
  select user_id, payload into v_owner, v_payload from drona_cards where id = p_card_id for update;
  if v_owner is null then return 'no_card'; end if;

  v_from := (v_payload->>'from_kcal')::int;
  v_to   := (v_payload->>'to_kcal')::int;
  if v_from is null or v_to is null or v_from = v_to then return 'bad_payload'; end if;
  v_phase := nullif(v_payload->>'phase_id', '')::uuid;

  if p_undo then
    v_expect := v_to; v_target := v_from;
    -- Undo puts back the exact four numbers the card saw, not a re-derivation.
    v_macros := jsonb_build_object(
      'protein_g', (v_payload->>'from_protein_g')::int,
      'carb_g',    (v_payload->>'from_carb_g')::int,
      'fat_g',     (v_payload->>'from_fat_g')::int);
  else
    v_expect := v_from; v_target := v_to;
    v_macros := private.macros_for_kcal(v_to,
      (v_payload->>'from_protein_g')::int, (v_payload->>'from_carb_g')::int, (v_payload->>'from_fat_g')::int);
  end if;

  select daily_calorie_target into v_current from user_profiles where clerk_user_id = v_owner;
  if v_current = v_target then return 'ok'; end if;   -- the same move, replayed
  if v_current is distinct from v_expect then return 'moved_on'; end if;

  update user_profiles
     set daily_calorie_target = v_target,
         protein_target_g = (v_macros->>'protein_g')::int,
         carb_target_g    = (v_macros->>'carb_g')::int,
         fat_target_g     = (v_macros->>'fat_g')::int
   where clerk_user_id = v_owner;

  -- The phase carries the same numbers while it is the one the plan follows.
  if v_phase is not null then
    update coach_program_phases
       set diet_calorie_target = v_target,
           diet_protein_g = (v_macros->>'protein_g')::int,
           diet_carb_g    = (v_macros->>'carb_g')::int,
           diet_fat_g     = (v_macros->>'fat_g')::int
     where id = v_phase and user_id = v_owner
       and (diet_calorie_target = v_expect or diet_calorie_target is null);
  end if;
  return 'ok';
end;
$function$;

revoke all on function private.macros_for_kcal(int, int, int, int) from public, anon, authenticated;
revoke all on function private.drona_targets_move(uuid, boolean) from public, anon, authenticated;

create or replace function public.drona_apply_targets(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text; v_topic text; v_status text; v_result text;
begin
  select user_id, topic, status into v_owner, v_topic, v_status from drona_cards where id = p_card_id;
  if v_owner is null then return 'no_card'; end if;
  if v_owner is distinct from current_clerk_user_id() then return 'forbidden'; end if;
  if v_topic <> 'calories' then return 'not_calories'; end if;
  if v_status <> 'pending' then return 'already_decided'; end if;

  v_result := private.drona_targets_move(p_card_id, false);
  if v_result = 'ok' then
    update drona_cards set status = 'applied', decided_at = now() where id = p_card_id;
  end if;
  return v_result;
end;
$function$;

create or replace function public.drona_undo_targets(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text; v_topic text; v_status text; v_since timestamptz; v_result text;
begin
  select user_id, topic, status, decided_at into v_owner, v_topic, v_status, v_since
    from drona_cards where id = p_card_id;
  if v_owner is null then return 'no_card'; end if;
  if v_owner is distinct from current_clerk_user_id() then return 'forbidden'; end if;
  if v_topic <> 'calories' then return 'not_calories'; end if;
  if v_status <> 'applied' then return 'already_decided'; end if;
  if v_since is null or v_since < now() - interval '7 days' then return 'too_late'; end if;

  v_result := private.drona_targets_move(p_card_id, true);
  update drona_cards
     set status = case when v_result = 'ok' then 'undone' else 'dismissed' end,
         decided_at = now()
   where id = p_card_id and status = 'applied';
  return v_result;
end;
$function$;

revoke all on function public.drona_apply_targets(uuid) from public, anon;
revoke all on function public.drona_undo_targets(uuid) from public, anon;
grant execute on function public.drona_apply_targets(uuid) to authenticated;
grant execute on function public.drona_undo_targets(uuid) to authenticated;
