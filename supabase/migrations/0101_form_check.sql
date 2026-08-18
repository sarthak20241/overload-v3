-- 0101_form_check.sql
--
-- Form checking (Drona Eyes). Pose estimation runs ON DEVICE; only per-rep
-- angle summaries reach the server. Nothing here stores video, frames, or
-- keypoints, and that is deliberate: the privacy promise in the UI ("your video
-- stays on your phone") has to be true at the schema level, not just in copy.
--
-- Three things get added:
--
--   1. exercises.movement_pattern + exercises.form_rules
--      Rules are DATA, not app code, because the catalog is ~800 global rows
--      plus an open-ended tail of exercises Coach Drona invents mid-workout.
--      `movement_pattern` tags a row with its family (a squat is a squat
--      whether it is a back squat or a goblet squat) and the app ships a rule
--      template per family, so tagging alone makes an exercise checkable.
--      `form_rules` holds a per-exercise override for the cases where the
--      family template is not good enough, or a spec authored on demand for a
--      movement nothing in the catalog resembles.
--
--   2. form_checks
--      One row per checked set: the compact summary, Drona's note, the score.
--
--   3. form_check_rate_limit + try_reserve_form_check_slot
--      Same race-free cap pattern as 0089. Form check is metered for free
--      users rather than gated behind Pro, so the cap is the only bound on
--      Anthropic spend and it has to be atomic.
--
-- GRANTS: Supabase ships project-wide default privileges that grant
-- authenticated FULL access to every new table in `public`. A bare GRANT never
-- narrows that. So every new table below REVOKEs first, then re-grants the
-- minimum, per the lesson recorded in 0091.

-- ─── 1. Rules on the exercise catalog ───────────────────────────────────────

alter table exercises
  add column if not exists movement_pattern text;
alter table exercises
  add column if not exists form_rules jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exercises_movement_pattern_check') then
    alter table exercises add constraint exercises_movement_pattern_check
      check (movement_pattern is null or movement_pattern in (
        'squat','hinge','lunge',
        'horizontal_press','vertical_press',
        'horizontal_pull','vertical_pull',
        'elbow_flexion','elbow_extension',
        'none'));
  end if;
end $$;

comment on column exercises.movement_pattern is
  'Movement family used to pick a form-rule template. ''none'' means we know '
  'this exercise and know a phone camera cannot judge it (machine isolation, '
  'cardio, static holds). NULL means not yet classified.';
comment on column exercises.form_rules is
  'Per-exercise FormRuleSpec override (lib/form/spec.ts). NULL means fall back '
  'to the movement_pattern template. Always re-validated client-side before '
  'use: a spec authored by an older model must never be trusted blindly.';

-- Only rows that actually carry an override need the index; the vast majority
-- are NULL and inherit their family template.
create index if not exists idx_exercises_form_rules
  on exercises (id) where form_rules is not null;

-- Backfill. This CASE chain mirrors NAME_RULES in lib/form/patterns.ts and the
-- ORDER IS LOAD-BEARING: "Romanian Deadlift" must be caught by the hinge rule
-- before the generic squat rule ever sees it, and "Leg Curl" must be caught as
-- unjudgeable machine work before the elbow-flexion rule turns a hamstring
-- machine into a biceps curl.
--
-- Postgres word boundaries are \y, not \b (\b is a backspace escape here).
update exercises set movement_pattern = case
  when name ~* '\y(treadmill|run|jog|cycl|bike|row erg|elliptical|stair|walk|sled|carry|plank|hold|stretch)\y'
    then 'none'
  when name ~* '\y(calf|shrug|fly|flye|lateral raise|front raise|rear delt|face pull|pullover|wrist|crunch|sit.?up|twist|raise)\y'
    then 'none'
  when name ~* '\y(leg curl|leg extension|hamstring curl|lying curl)\y'
    then 'none'
  when name ~* '\y(romanian|rdl|stiff.?leg|good morning|hip thrust|hip hinge|back extension|deadlift)\y'
    then 'hinge'
  when name ~* '\y(lunge|split squat|step.?up|bulgarian)\y'
    then 'lunge'
  when name ~* '\y(squat|leg press|hack)\y'
    then 'squat'
  when name ~* '\y(pull.?up|chin.?up|lat pulldown|pulldown)\y'
    then 'vertical_pull'
  when name ~* '\y(row|seated row|t.?bar)\y'
    then 'horizontal_pull'
  when name ~* '\y(overhead press|shoulder press|military|push press|arnold)\y'
    then 'vertical_press'
  when name ~* '\y(bench|push.?up|chest press|dip)\y'
    then 'horizontal_press'
  when name ~* '\ycurl\y'
    then 'elbow_flexion'
  when name ~* '\y(tricep|pushdown|press.?down|skull|extension|kickback)\y'
    then 'elbow_extension'
  else null
end
where movement_pattern is null;

-- ─── 2. Form check results ──────────────────────────────────────────────────

create table if not exists form_checks (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null default (auth.jwt()->>'sub'),
  -- Keep the check when the exercise row goes away; the coaching still applies.
  exercise_id uuid references exercises(id) on delete set null,
  -- Denormalised so history stays readable after a rename or a deletion.
  exercise_name text not null,
  movement_pattern text,
  source text not null default 'live',
  -- The FormSummary from lib/form/summarize.ts. Angles and flags only.
  summary jsonb not null,
  note text,
  score integer,
  created_at timestamptz not null default now(),
  constraint form_checks_source_check check (source in ('live','upload')),
  constraint form_checks_score_check check (score is null or (score >= 0 and score <= 100))
);

create index if not exists idx_form_checks_user_recent
  on form_checks (user_id, created_at desc);
create index if not exists idx_form_checks_user_exercise
  on form_checks (user_id, exercise_id, created_at desc);

alter table form_checks enable row level security;

drop policy if exists form_checks_select_own on form_checks;
create policy form_checks_select_own on form_checks
  for select using (user_id = current_clerk_user_id());

drop policy if exists form_checks_delete_own on form_checks;
create policy form_checks_delete_own on form_checks
  for delete using (user_id = current_clerk_user_id());

-- Rows are written by the edge function under service_role, which bypasses
-- RLS. Clients only read and delete their own: letting a client INSERT would
-- let it fabricate a score, and letting it UPDATE would let it rewrite the
-- coaching history the coach later reads back as context.
revoke all on public.form_checks from authenticated, anon;
grant select, delete on public.form_checks to authenticated;

-- ─── 3. Rate limit ──────────────────────────────────────────────────────────

create table if not exists form_check_rate_limit (
  user_id text not null,
  request_at timestamptz not null default now()
);

create index if not exists idx_form_check_rl_recent
  on form_check_rate_limit (user_id, request_at desc);

-- RLS on with zero policies: clients are locked out entirely. Only the
-- SECURITY DEFINER function below and service_role can touch it.
alter table form_check_rate_limit enable row level security;
revoke all on public.form_check_rate_limit from authenticated, anon;

create or replace function try_reserve_form_check_slot(p_cap int)
returns table (inserted boolean, current_count int)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   text;
  v_count int;
begin
  v_uid := current_clerk_user_id();
  if v_uid is null then
    inserted := false;
    current_count := 0;
    return next;
    return;
  end if;

  -- Per-user, transaction-scoped serialization, so N concurrent requests
  -- cannot each read a count under the cap before any insert lands.
  perform pg_advisory_xact_lock(hashtext('form_check_slot:' || v_uid));

  select count(*)::int into v_count
    from form_check_rate_limit
   where user_id = v_uid
     and request_at >= now() - interval '24 hours';

  if v_count >= p_cap then
    inserted := false;
    current_count := v_count;
    return next;
    return;
  end if;

  insert into form_check_rate_limit(user_id) values (v_uid);
  inserted := true;
  current_count := v_count + 1;
  return next;
end;
$$;

revoke all on function try_reserve_form_check_slot(int) from public;
grant execute on function try_reserve_form_check_slot(int) to authenticated;
