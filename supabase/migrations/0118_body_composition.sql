-- 0118_body_composition.sql
--
-- Body fat and tape measurements reach the server (they lived only in the
-- phone's AsyncStorage), and account deletion works again.
--
-- 1. daily_metrics accepts 'body_fat_percent' (%, one value per local day).
-- 2. sync_user_profile_bodyweight: the live trigger function (applied as
--    "bodyweight_profile_sync" on 2026-07-09, never committed) is captured here
--    and extended. After a bodyweight_kg or body_fat_percent write it copies the
--    latest day's value onto user_profiles.weight_kg / body_fat_percent, so the
--    profile and the coach context keep reading one current number.
-- 3. body_measurements: one row per (user, local day, site), in cm.
-- 4. delete_user_data: deletes body_measurements, and no longer fails. It
--    deleted from coach_conversation_messages and coach_conversations, which
--    were never created on the live project (0042 was not applied), so every
--    call raised 42P01 and the delete-account function returned 500.

-- 1 ───────────────────────────────────────────────────────────────────────────
alter table public.daily_metrics drop constraint if exists daily_metrics_metric_type_check;
alter table public.daily_metrics add constraint daily_metrics_metric_type_check
  check (metric_type in (
    'steps', 'sleep_minutes', 'sleep_quality', 'bodyweight_kg', 'body_fat_percent',
    'resting_hr_bpm', 'hrv_sdnn_ms', 'active_energy_kcal', 'readiness_score'));

-- 2 ───────────────────────────────────────────────────────────────────────────
create or replace function public.sync_user_profile_bodyweight()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  uid text := coalesce(new.user_id, old.user_id);
  mtype text := coalesce(new.metric_type, old.metric_type);
  latest numeric;
begin
  if mtype not in ('bodyweight_kg', 'body_fat_percent') then
    return null;
  end if;

  select value into latest from daily_metrics
  where user_id = uid and metric_type = mtype
  order by metric_date desc limit 1;

  if mtype = 'bodyweight_kg' then
    update user_profiles set weight_kg = latest where clerk_user_id = uid;
  else
    update user_profiles set body_fat_percent = latest where clerk_user_id = uid;
  end if;

  return null;
end;
$function$;

drop trigger if exists trg_sync_user_profile_bodyweight on public.daily_metrics;
create trigger trg_sync_user_profile_bodyweight
  after insert or update or delete on public.daily_metrics
  for each row execute function public.sync_user_profile_bodyweight();

-- 3 ───────────────────────────────────────────────────────────────────────────
create table if not exists public.body_measurements (
  user_id      text not null default (auth.jwt()->>'sub'),
  measured_on  date not null,                          -- user's LOCAL calendar day
  site         text not null check (site in (
                 'chest', 'shoulders', 'neck', 'bicep_l', 'bicep_r',
                 'forearm_l', 'forearm_r', 'waist', 'hips',
                 'thigh_l', 'thigh_r', 'calf_l', 'calf_r')),
  value_cm     numeric(6,2) not null check (value_cm >= 5 and value_cm <= 300),
  source       text not null default 'manual'
                 check (source in ('manual', 'healthkit', 'health_connect')),
  updated_at   timestamptz not null default now(),
  primary key (user_id, measured_on, site)
);

create index if not exists ix_body_measurements_user_day
  on public.body_measurements (user_id, measured_on desc);

alter table public.body_measurements enable row level security;

drop policy if exists "own body_measurements select" on public.body_measurements;
create policy "own body_measurements select" on public.body_measurements
  for select to authenticated
  using (user_id = auth.jwt()->>'sub');
drop policy if exists "own body_measurements insert" on public.body_measurements;
create policy "own body_measurements insert" on public.body_measurements
  for insert to authenticated
  with check (user_id = auth.jwt()->>'sub');
drop policy if exists "own body_measurements update" on public.body_measurements;
create policy "own body_measurements update" on public.body_measurements
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');
drop policy if exists "own body_measurements delete" on public.body_measurements;
create policy "own body_measurements delete" on public.body_measurements
  for delete to authenticated
  using (user_id = auth.jwt()->>'sub');

-- New public tables start fully granted to anon and authenticated. A bare GRANT
-- never narrows, so revoke first.
revoke all on public.body_measurements from anon, authenticated;
grant select, insert, update, delete on public.body_measurements to authenticated;

-- 4 ───────────────────────────────────────────────────────────────────────────
create or replace function public.delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from workout_sets ws
    using workouts w
    where ws.workout_id = w.id and w.user_id = p_user_id;
  delete from workouts where user_id = p_user_id;
  delete from routine_exercises re
    using routines r
    where re.routine_id = r.id and r.user_id = p_user_id;
  delete from coach_program_phases where user_id = p_user_id;
  delete from coach_programs where user_id = p_user_id;
  delete from routines where user_id = p_user_id;
  delete from user_exercise_notes where user_id = p_user_id;
  delete from user_lift_stats where user_id = p_user_id;
  delete from user_volume_stats where user_id = p_user_id;

  delete from meals where user_id = p_user_id;
  delete from user_nutrition_stats where user_id = p_user_id;

  delete from daily_metrics where user_id = p_user_id;
  delete from body_measurements where user_id = p_user_id;

  delete from coach_traces where user_id = p_user_id;
  delete from coach_trials where clerk_user_id = p_user_id;
  delete from ai_coach_rate_limit where user_id = p_user_id;
  -- Chat history tables exist only where 0042 was applied (not on the live
  -- project). Static SQL naming a missing table fails the whole function.
  if to_regclass('public.coach_conversation_messages') is not null then
    execute 'delete from coach_conversation_messages m using coach_conversations c
             where m.conversation_id = c.id and c.user_id = $1' using p_user_id;
  end if;
  if to_regclass('public.coach_conversations') is not null then
    execute 'delete from coach_conversations where user_id = $1' using p_user_id;
  end if;
  delete from weekly_reports where user_id = p_user_id;

  delete from bug_reports where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;
end;
$function$;
