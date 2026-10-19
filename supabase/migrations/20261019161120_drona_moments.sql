-- Drona moments (.planning/drona-moments.md): a card about something that just
-- happened, made as soon as it is found, beside the weekly card.
--
--   drona_cards.slot          + 'moment'; a moment carries its local day
--                              (moment_day). One card per week per slot stays
--                              for weekly and calories; a moment is one per
--                              person, day and topic.
--   drona_cards.source        + 'reply' (made right after a chat or food-log reply)
--   drona_moment_asks         plan changes asked for in chat, waiting a day to
--                              see if the change happened (written by ai-coach)
--   get_drona_moment_candidates(p_now)
--                             every person with something worth a moment, in one
--                             read for the card worker's 15-minute run:
--                               missed_sessions  no session for 2 planned gaps
--                               food_off         3 whole days running 25% over
--                                                (or under, with 3 meals logged)
--                               asked_for_a_change  an ask from before today with
--                                                no matching plan change since
--                               pr               a workout in the last 2 days with
--                                                a weight PR (the app's own rule)
--                             with the person's recent cards (cooldown, caps),
--                             'topic:' mutes and the quiet-week flag. Rules that
--                             need judgment live in _shared/dronaMoments.ts.

alter table public.drona_cards add column if not exists moment_day date;

alter table public.drona_cards drop constraint if exists drona_cards_slot_check;
alter table public.drona_cards add constraint drona_cards_slot_check
  check (slot in ('weekly', 'calories', 'moment'));
alter table public.drona_cards drop constraint if exists drona_cards_moment_day_check;
alter table public.drona_cards add constraint drona_cards_moment_day_check
  check ((slot = 'moment') = (moment_day is not null));

alter table public.drona_cards drop constraint if exists drona_cards_source_check;
alter table public.drona_cards add constraint drona_cards_source_check
  check (source in ('cron', 'app', 'reply'));

alter table public.drona_cards drop constraint if exists drona_cards_user_week_slot_key;
create unique index if not exists drona_cards_user_week_slot_key
  on public.drona_cards (user_id, week_start, slot) where slot <> 'moment';
create unique index if not exists drona_cards_user_moment_key
  on public.drona_cards (user_id, moment_day, topic) where slot = 'moment';

create table if not exists public.drona_moment_asks (
  user_id    text        not null references public.user_profiles(clerk_user_id) on delete cascade,
  source_id  text        not null,
  day        date        not null,
  change     text        not null check (change in ('training_days', 'exercises', 'goal_or_weight', 'calories', 'other')),
  status     text        not null default 'open' check (status in ('open', 'done', 'carded')),
  created_at timestamptz not null default now(),
  primary key (user_id, source_id)
);
alter table public.drona_moment_asks enable row level security;
revoke all on table public.drona_moment_asks from public, anon, authenticated;
grant all on table public.drona_moment_asks to service_role;

create or replace function public.get_drona_moment_candidates(p_now timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with people as (
    select up.clerk_user_id as uid, up.timezone as tz,
           (p_now at time zone up.timezone)::date as today,
           extract(hour from (p_now at time zone up.timezone))::int as hour
      from user_profiles up
     where up.timezone is not null
       and exists (select 1 from pg_timezone_names z where z.name = up.timezone)
  ),
  -- missed sessions: no session for two planned gaps (2 x 7 / planned per week,
  -- at least 3 days), for someone who trained in the last 3 weeks.
  ms as (
    select p.uid, jsonb_build_object('type', 'missed_sessions', 'detail', jsonb_build_object(
             'gap_days', p.today - l.last_day, 'planned_per_week', w.planned, 'last_session_day', l.last_day)) as c
      from people p
      cross join lateral (
        select max((wo.started_at at time zone p.tz)::date) as last_day
          from workouts wo where wo.user_id = p.uid and wo.finished_at is not null
      ) l
      cross join lateral (
        select f.t_planned_sessions as planned from drona_week_facts f
         where f.user_id = p.uid and f.t_planned_sessions > 0 and f.week_start <= p.today
         order by f.week_start desc limit 1
      ) w
     where p.hour >= 7 and l.last_day is not null
       and p.today - l.last_day >= greatest(3, ceil(14.0 / w.planned))::int
       and p.today - l.last_day <= 21
  ),
  -- food far off: the last 3 days, each logged with a target, all 25% or more
  -- over, or all 25% or more under with at least 3 meals logged (a whole day).
  fo as (
    select p.uid, jsonb_build_object('type', 'food_off', 'detail', jsonb_build_object(
             'direction', case when d.over_days = 3 then 'over' else 'under' end,
             'avg_pct', d.avg_pct, 'days', d.days)) as c
      from people p
      cross join lateral (
        select count(*) filter (where df.kcal >= 1.25 * df.target_kcal) as over_days,
               count(*) filter (where df.kcal <= 0.75 * df.target_kcal
                                  and (df.has_breakfast::int + df.has_lunch::int + df.has_dinner::int) >= 3) as under_days,
               count(*) as logged,
               round(avg(100.0 * df.kcal / df.target_kcal))::int as avg_pct,
               jsonb_agg(jsonb_build_object('day', df.day, 'kcal', round(df.kcal), 'target', df.target_kcal) order by df.day) as days
          from drona_day_facts df
         where df.user_id = p.uid and df.day between p.today - 3 and p.today - 1
           and df.entries > 0 and df.target_kcal > 0
      ) d
     where p.hour >= 7 and d.logged = 3 and (d.over_days = 3 or d.under_days = 3)
  ),
  -- asked for a change: an open ask from before today, no matching change since.
  ak as (
    select p.uid, jsonb_build_object('type', 'asked_for_a_change', 'detail', jsonb_build_object(
             'change', a.change, 'day', a.day, 'source', a.source_id)) as c
      from people p
      join lateral (
        select * from drona_moment_asks a
         where a.user_id = p.uid and a.status = 'open' and a.day < p.today and a.day >= p.today - 7
           and not exists (
             select 1 from plan_changes pc
              where pc.user_id = a.user_id and (pc.occurred_at at time zone p.tz)::date >= a.day
                and (a.change = 'other'
                     or (a.change = 'training_days' and pc.entity in ('routine', 'program', 'phase'))
                     or (a.change = 'exercises' and pc.entity in ('routine_exercises', 'routine'))
                     or (a.change = 'goal_or_weight' and pc.entity in ('goal', 'program', 'phase'))
                     or (a.change = 'calories' and pc.entity in ('targets', 'phase'))))
         order by a.day desc limit 1
      ) a on true
     where p.hour >= 7
  ),
  -- a PR: a workout finished in the last 2 days whose heaviest working set of
  -- an exercise beats every earlier set of it (the app's own rule: weight PR,
  -- working sets only, earlier data required). Not already carded.
  pr as (
    select p.uid, jsonb_build_object('type', 'pr', 'detail', jsonb_build_object(
             'workout_id', w.id, 'day', (w.started_at at time zone p.tz)::date, 'prs', x.prs)) as c
      from people p
      join workouts w on w.user_id = p.uid and w.finished_at is not null and w.finished_at >= p_now - interval '2 days'
      cross join lateral (
        select jsonb_agg(jsonb_build_object('exercise', e.name, 'weight_kg', b.best, 'reps', b.reps, 'prev_best_kg', b.prev)
                         order by b.best - b.prev desc) as prs
          from (
            select s.exercise_id,
                   max(s.weight_kg) as best,
                   (array_agg(s.reps order by s.weight_kg desc, s.reps desc))[1] as reps,
                   (select max(s2.weight_kg) from workout_sets s2 join workouts w2 on w2.id = s2.workout_id
                     where w2.user_id = p.uid and w2.finished_at is not null and w2.started_at < w.started_at
                       and s2.exercise_id = s.exercise_id and s2.completed
                       and coalesce(s2.set_type, 'normal') <> 'warmup') as prev
              from workout_sets s
             where s.workout_id = w.id and s.completed and s.weight_kg > 0
               and coalesce(s.set_type, 'normal') <> 'warmup'
             group by s.exercise_id
          ) b
          join exercises e on e.id = b.exercise_id
         where b.prev is not null and b.prev > 0 and b.best > b.prev
      ) x
     where x.prs is not null
       and not exists (select 1 from drona_cards d where d.user_id = p.uid and d.slot = 'moment'
                         and d.payload ->> 'workout_id' = w.id::text)
  ),
  cands as (
    select uid, jsonb_agg(c) as cands from (
      select * from ms union all select * from fo union all select * from ak union all select * from pr
    ) u group by uid
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', p.uid, 'today', p.today, 'hour', p.hour,
           'candidates', c.cands,
           'cards', coalesce((
             select jsonb_agg(jsonb_build_object('slot', d.slot, 'topic', d.topic, 'status', d.status,
                      'week_start', d.week_start, 'moment_day', d.moment_day,
                      'deferred', d.deferred_at is not null,
                      'created_day', (d.created_at at time zone p.tz)::date))
               from drona_cards d where d.user_id = p.uid and d.created_at >= p_now - interval '60 days'), '[]'::jsonb),
           'mutes', coalesce((
             select jsonb_agg(distinct m) from drona_behaviours b, unnest(b.mutes) m
              where b.user_id = p.uid and b.week_start = date_trunc('week', p.today)::date - 7), '[]'::jsonb),
           'hushed', exists (select 1 from drona_behaviours b where b.user_id = p.uid and b.meta
                              and b.week_start = date_trunc('week', p.today)::date - 7)
         )), '[]'::jsonb)
    from cands c join people p on p.uid = c.uid;
$function$;

revoke all on function public.get_drona_moment_candidates(timestamptz) from public, anon, authenticated;
grant execute on function public.get_drona_moment_candidates(timestamptz) to service_role;
