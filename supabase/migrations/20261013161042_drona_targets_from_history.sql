-- 20261013161042_drona_targets_from_history.sql: the facts read the app's own day targets
--
-- private.drona_target_on rebuilt each day's target from the plan_changes diary.
-- That diary never saw fuel days (0139) or a goal set for one day only (0151),
-- so a long-run Sunday eaten to its +300 read as over the target. Main added
-- the real record in the meantime: user_target_history (0150, back to the
-- start for everyone with targets) and user_day_targets (0151). This follows
-- the app's rule exactly (_shared/targetHistory.ts targetsForDay):
--
--   a goal for this one day > the snapshot in force on a past day > the live
--   goal (today on, or a day older than every snapshot); then that weekday's
--   fuel day adds on top, as carbs.
--
-- One difference on purpose: a target nobody set stays empty here ('none'),
-- where the app fills in its defaults (2000 kcal, 125 g protein). A fact must
-- not invent a goal.
--
-- Proved by scripts/drona-facts/targets-compare.mts: 36 people x 47 days x 4
-- targets, 6,768 of 6,768 equal to the app's answer. The old lookup, run
-- through the same check, got 52 wrong. src is now one_day / history / live /
-- assumed_current.

create or replace function private.drona_target_on(p_user text, p_key text, p_day date, p_tz text)
returns table (val numeric, src text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $function$
declare
  v_col    text;
  v_today  date := (now() at time zone p_tz)::date;
  h        user_target_history%rowtype;
  p        user_profiles%rowtype;
  o        user_day_targets%rowtype;
  v_base   numeric;
  v_boosts jsonb;
  v_src    text;
  v_fuel   numeric;
begin
  v_col := case p_key when 'daily_calorie_target' then 'kcal' when 'protein_target_g' then 'protein_g'
                      when 'carb_target_g' then 'carb_g' when 'fat_target_g' then 'fat_g' end;
  if v_col is null then
    val := null; src := 'none'; return next; return;
  end if;
  select * into p from user_profiles where clerk_user_id = p_user;
  -- A past day reads the goal snapshot in force on it (0150); today and later,
  -- or a day older than every snapshot, read the live goal.
  if p_day < v_today then
    select * into h from user_target_history
     where user_id = p_user and effective_from <= p_day
     order by effective_from desc limit 1;
  end if;
  if h.user_id is not null then
    v_base := (to_jsonb(h) ->> v_col)::numeric; v_boosts := h.calorie_day_boosts; v_src := 'history';
  else
    v_base := (to_jsonb(p) ->> p_key)::numeric; v_boosts := p.calorie_day_boosts;
    v_src := case when p_day >= v_today then 'live' else 'assumed_current' end;
  end if;
  -- A goal set for this one day replaces the base; a macro it left empty keeps the usual one (0151).
  select * into o from user_day_targets where user_id = p_user and day = p_day;
  if o.user_id is not null and (to_jsonb(o) ->> v_col) is not null then
    v_base := (to_jsonb(o) ->> v_col)::numeric; v_src := 'one_day';
  end if;
  -- The weekday's fuel adds on top, as carbs (_shared/fuelDays.ts: snapped to
  -- 50, at least 50, at most 1000, the last entry for a weekday wins).
  if v_base is not null and p_key in ('daily_calorie_target', 'carb_target_g') and jsonb_typeof(v_boosts) = 'array' then
    select least(1000, round(((x.e ->> 'kcal')::numeric) / 50) * 50) into v_fuel
      from jsonb_array_elements(v_boosts) with ordinality x(e, i)
     where jsonb_typeof(x.e -> 'dow') = 'number' and (x.e ->> 'dow')::numeric = extract(dow from p_day)
       and jsonb_typeof(x.e -> 'kcal') = 'number' and round(((x.e ->> 'kcal')::numeric) / 50) * 50 >= 50
     order by x.i desc limit 1;
    if v_fuel is not null then
      v_base := v_base + case when p_key = 'daily_calorie_target' then v_fuel else round(v_fuel / 4) end;
    end if;
  end if;
  val := v_base; src := case when v_base is null then 'none' else v_src end;
  return next;
end;
$function$;
revoke all on function private.drona_target_on(text, text, date, text) from public, anon, authenticated;
