-- 0008_per_user_stats_tables.sql
--
-- Replace the global materialized views (user_lift_stats, user_volume_stats)
-- with regular tables maintained INCREMENTALLY by a per-row trigger on
-- workout_sets. Each set INSERT/UPDATE/DELETE recomputes ONLY the affected
-- (user_id, exercise_id) lift row and (user_id, muscle_group, week_start)
-- volume row — not the entire matview for every user.
--
-- Why we're moving away from matviews:
--   * REFRESH MATERIALIZED VIEW is whole-table; can't refresh per user.
--   * Original on-workouts trigger fired BEFORE sets were committed (the
--     client's INSERT workouts {finished_at: NOW()} happens in a separate
--     round-trip from the bulk INSERT workout_sets), leaving the matview
--     empty for the just-finished workout.
--   * Even after fixing the firing point, every set INSERT triggered a
--     full O(n_users × n_sets) refresh. Doesn't scale past a few users.
--
-- New design:
--   * user_lift_stats and user_volume_stats are REGULAR tables.
--   * Trigger on workout_sets (per row) recomputes the one affected row
--     for that user × exercise, and the one affected row for that user ×
--     muscle × week. Other users' stats are never touched.
--   * O(1) per write, scoped to one user. True per-user incremental.
--
-- The RPC `get_user_coach_context()` (migration 0004) reads from these
-- tables by name with the same column shape, so no RPC changes needed.

-- ── 1. Drop the old triggers, functions, and matviews ───────────────────────
drop trigger if exists trg_refresh_user_stats on workouts;
drop trigger if exists trg_refresh_user_stats_sets on workout_sets;
drop function if exists refresh_user_stats_views() cascade;
drop function if exists refresh_user_stats_from_sets() cascade;
drop materialized view if exists user_lift_stats cascade;
drop materialized view if exists user_volume_stats cascade;

-- ── 2. Regular tables with the same shape the RPC expects ──────────────────
create table user_lift_stats (
  user_id           text         not null,
  exercise_id       uuid         not null,
  exercise_name     text         not null,
  muscle_group      text         not null,
  estimated_1rm     numeric(10, 2),
  top_set_weight    numeric(10, 2),
  top_set_reps      integer,
  last_performed_at timestamptz,
  sessions_last_28d integer      not null default 0,
  updated_at        timestamptz  not null default now(),
  primary key (user_id, exercise_id)
);
create index idx_user_lift_stats_user on user_lift_stats(user_id);

create table user_volume_stats (
  user_id          text         not null,
  muscle_group     text         not null,
  week_start       date         not null,
  total_volume_kg  numeric(12, 2) not null default 0,
  set_count        integer      not null default 0,
  updated_at       timestamptz  not null default now(),
  primary key (user_id, muscle_group, week_start)
);
create index idx_user_volume_stats_user on user_volume_stats(user_id);

-- RLS: users see only their own rows. The coach RPC runs SECURITY DEFINER
-- so it bypasses these, but direct PostgREST reads (e.g., a future PR feed
-- screen) will respect them.
alter table user_lift_stats enable row level security;
alter table user_volume_stats enable row level security;

drop policy if exists "user_lift_stats_owner_read" on user_lift_stats;
create policy "user_lift_stats_owner_read" on user_lift_stats
  for select using (user_id = current_clerk_user_id());

drop policy if exists "user_volume_stats_owner_read" on user_volume_stats;
create policy "user_volume_stats_owner_read" on user_volume_stats
  for select using (user_id = current_clerk_user_id());

-- ── 3. Per-user recompute helpers ──────────────────────────────────────────
-- recompute_user_lift_stat(user, exercise): rebuild ONE row from raw
-- workout_sets. Uses min(Epley, Brzycki) — the conservative e1RM estimate.
create or replace function recompute_user_lift_stat(p_user_id text, p_exercise_id uuid)
returns void
language plpgsql
as $$
declare
  v_exercise_name text;
  v_muscle_group  text;
  v_e1rm          numeric(10, 2);
  v_top_weight    numeric(10, 2);
  v_top_reps      integer;
  v_last_at       timestamptz;
  v_sessions_28d  integer;
begin
  select e.name, e.muscle_group
    into v_exercise_name, v_muscle_group
  from exercises e
  where e.id = p_exercise_id;

  with cs as (
    select
      s.weight_kg,
      greatest(s.reps, 1) as reps,
      w.started_at,
      least(
        s.weight_kg * (1.0 + greatest(s.reps, 1) / 30.0),
        s.weight_kg * 36.0 / (37.0 - least(greatest(s.reps, 1), 36))
      )::numeric(10, 2) as e1rm
    from workout_sets s
      join workouts w on w.id = s.workout_id
    where w.user_id = p_user_id
      and s.exercise_id = p_exercise_id
      and s.completed = true
      and s.weight_kg > 0
      and w.user_id is not null
  )
  select
    max(e1rm),
    (array_agg(weight_kg order by e1rm desc))[1],
    (array_agg(reps      order by e1rm desc))[1],
    max(started_at),
    count(distinct date_trunc('day', started_at))
      filter (where started_at >= now() - interval '28 days')
    into v_e1rm, v_top_weight, v_top_reps, v_last_at, v_sessions_28d
  from cs;

  if v_e1rm is null then
    -- No qualifying sets remain — drop the row.
    delete from user_lift_stats
      where user_id = p_user_id and exercise_id = p_exercise_id;
    return;
  end if;

  insert into user_lift_stats (
    user_id, exercise_id, exercise_name, muscle_group,
    estimated_1rm, top_set_weight, top_set_reps,
    last_performed_at, sessions_last_28d, updated_at
  )
  values (
    p_user_id, p_exercise_id, v_exercise_name, v_muscle_group,
    v_e1rm, v_top_weight, v_top_reps,
    v_last_at, coalesce(v_sessions_28d, 0), now()
  )
  on conflict (user_id, exercise_id) do update set
    exercise_name     = excluded.exercise_name,
    muscle_group      = excluded.muscle_group,
    estimated_1rm     = excluded.estimated_1rm,
    top_set_weight    = excluded.top_set_weight,
    top_set_reps      = excluded.top_set_reps,
    last_performed_at = excluded.last_performed_at,
    sessions_last_28d = excluded.sessions_last_28d,
    updated_at        = now();
end;
$$;

-- recompute_user_volume_stat(user, muscle, week): rebuild ONE row.
create or replace function recompute_user_volume_stat(
  p_user_id      text,
  p_muscle_group text,
  p_week_start   date
)
returns void
language plpgsql
as $$
declare
  v_volume numeric(12, 2);
  v_count  integer;
begin
  select
    coalesce(sum(s.weight_kg * s.reps), 0)::numeric(12, 2),
    count(*)::integer
  into v_volume, v_count
  from workout_sets s
    join workouts w on w.id = s.workout_id
    join exercises e on e.id = s.exercise_id
  where w.user_id = p_user_id
    and e.muscle_group = p_muscle_group
    and date_trunc('week', w.started_at)::date = p_week_start
    and s.completed = true
    and w.user_id is not null;

  if v_count = 0 then
    delete from user_volume_stats
      where user_id = p_user_id
        and muscle_group = p_muscle_group
        and week_start = p_week_start;
    return;
  end if;

  insert into user_volume_stats (
    user_id, muscle_group, week_start, total_volume_kg, set_count, updated_at
  ) values (
    p_user_id, p_muscle_group, p_week_start, v_volume, v_count, now()
  )
  on conflict (user_id, muscle_group, week_start) do update set
    total_volume_kg = excluded.total_volume_kg,
    set_count       = excluded.set_count,
    updated_at      = now();
end;
$$;

-- ── 4. Per-row trigger on workout_sets ─────────────────────────────────────
-- Per-row (not statement-level) so we can read OLD/NEW for each affected set
-- and target the precise (user, exercise) and (user, muscle, week) rows.
-- For a bulk INSERT of N sets the trigger fires N times, but each fire is
-- O(sets-for-this-user-and-exercise) — typically a few rows. Total cost:
-- O(N × per-exercise-history), all scoped to the authoring user. No global
-- refresh.
create or replace function update_user_stats_on_set_change()
returns trigger
language plpgsql
as $$
declare
  v_user_id        text;
  v_started_at     timestamptz;
  v_muscle_group   text;
  v_old_muscle     text;
begin
  -- INSERT or UPDATE → recompute around NEW
  if tg_op in ('INSERT', 'UPDATE') then
    select w.user_id, w.started_at, e.muscle_group
      into v_user_id, v_started_at, v_muscle_group
    from workouts w
      join exercises e on e.id = new.exercise_id
    where w.id = new.workout_id;

    if v_user_id is not null then
      perform recompute_user_lift_stat(v_user_id, new.exercise_id);
      perform recompute_user_volume_stat(
        v_user_id, v_muscle_group, date_trunc('week', v_started_at)::date
      );
    end if;
  end if;

  -- UPDATE that moved exercise_id → also recompute the OLD exercise's row
  if tg_op = 'UPDATE' and old.exercise_id is distinct from new.exercise_id then
    select e.muscle_group into v_old_muscle
      from exercises e where e.id = old.exercise_id;
    if v_user_id is not null then
      perform recompute_user_lift_stat(v_user_id, old.exercise_id);
      if v_old_muscle is not null then
        perform recompute_user_volume_stat(
          v_user_id, v_old_muscle, date_trunc('week', v_started_at)::date
        );
      end if;
    end if;
  end if;

  -- DELETE → recompute around OLD
  if tg_op = 'DELETE' then
    select w.user_id, w.started_at, e.muscle_group
      into v_user_id, v_started_at, v_muscle_group
    from workouts w
      join exercises e on e.id = old.exercise_id
    where w.id = old.workout_id;

    if v_user_id is not null then
      perform recompute_user_lift_stat(v_user_id, old.exercise_id);
      perform recompute_user_volume_stat(
        v_user_id, v_muscle_group, date_trunc('week', v_started_at)::date
      );
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_user_stats_on_set_change on workout_sets;
create trigger trg_user_stats_on_set_change
  after insert or update or delete on workout_sets
  for each row execute function update_user_stats_on_set_change();

-- ── 5. Backfill from existing workout_sets ─────────────────────────────────
-- One-time pass: for every distinct (user, exercise) and (user, muscle, week)
-- with at least one completed set, recompute the row. Idempotent — safe to
-- re-run.
do $$
declare r record;
begin
  for r in
    select distinct w.user_id, s.exercise_id
    from workout_sets s
      join workouts w on w.id = s.workout_id
    where s.completed = true
      and s.weight_kg > 0
      and w.user_id is not null
  loop
    perform recompute_user_lift_stat(r.user_id, r.exercise_id);
  end loop;

  for r in
    select distinct w.user_id, e.muscle_group,
      date_trunc('week', w.started_at)::date as week_start
    from workout_sets s
      join workouts w on w.id = s.workout_id
      join exercises e on e.id = s.exercise_id
    where s.completed = true
      and w.user_id is not null
  loop
    perform recompute_user_volume_stat(r.user_id, r.muscle_group, r.week_start);
  end loop;
end $$;
