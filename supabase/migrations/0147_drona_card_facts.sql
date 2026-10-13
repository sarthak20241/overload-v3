-- 0147_drona_card_facts.sql — cards facts: what Drona said, what the person answered,
-- and what they did after
--
-- Source: drona_cards (one row per user per local week), plan_changes.card_id,
-- and the logs a request card asks for. `c_*` columns on the week of the card.
--
-- What the data looked like on 2026-09-27: 6 cards in all, for 5 people, since
-- 18 Sep. Small, but every one of the questions below already has an answer in
-- it, and the facts must be right before there are hundreds.
--
--   * The answer as stored: applied (tapped the action, or made the change),
--     dismissed, undone (a change put back), done, held.
--   * The answer as it ENDED: a card still 'pending' after its expiry (a Later
--     runs out at the end of its week, 0127) or after its week is over was
--     never answered. c_outcome says 'expired' then, 'waiting' while it can
--     still be answered. The stored status is kept beside it.
--   * Did they DO it: a request card is a question with a test. log_weight is
--     answered by a weigh-in, start_session by a finished workout, log_food by
--     a meal, each after the card was made and inside its week. Tapping the
--     button is not the same as doing it: both are kept.
--   * A hold (kind 'hold', status 'held') is a week the model or the validator
--     decided to say nothing. The person never saw it; it is counted apart.
--   * Running totals up to each week: cards shown, answered, Later, ignored.
--     A person who stops answering is a fact before it is a signal.
--
-- Not possible yet: whether a card was SEEN. The popup opening is only in
-- PostHog (ledger section 8). A talk card's answer has no column yet (no talk
-- card has shipped).

alter table public.drona_week_facts
  add column if not exists c_card_id            uuid,
  add column if not exists c_kind               text,      -- act / request / talk / notice / hold
  add column if not exists c_topic              text,
  add column if not exists c_title              text,
  add column if not exists c_signals            text[],    -- the signals the card was made from
  add column if not exists c_action             text,      -- payload action: log_weight, start_session, apply_targets...
  add column if not exists c_status             text,      -- as stored
  add column if not exists c_outcome            text,      -- as it ended: status, or expired / waiting for a pending card
  add column if not exists c_seen_possible      boolean,   -- false for a hold: never shown
  add column if not exists c_deferred           boolean,   -- the person tapped Later
  add column if not exists c_hours_to_later     numeric(7,1),
  add column if not exists c_hours_to_answer    numeric(7,1),
  add column if not exists c_plan_changes       int,       -- diary rows made by this card
  add column if not exists c_followed_through   boolean,   -- a request card's test: did they do it (null = no test)
  add column if not exists c_hours_to_follow    numeric(7,1),
  add column if not exists c_cards_to_date      int,       -- shown so far, this week included (holds left out)
  add column if not exists c_answered_to_date   int,
  add column if not exists c_later_to_date      int,
  add column if not exists c_ignored_to_date    int,       -- ended pending: expired
  add column if not exists c_holds_to_date      int,
  add column if not exists c_computed_at        timestamptz;

create or replace function public.drona_rebuild_card_facts(
  p_user_id text, p_from date, p_to date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_from  date := date_trunc('week', p_from)::date;
  v_to    date := date_trunc('week', p_to)::date;
  v_tz    text := private.drona_user_tz(p_user_id);
  v_now   timestamptz := now();
  v_today date;
  v_rows  int;
begin
  if p_user_id is null or v_from is null or v_to is null then return 0; end if;
  v_today := (v_now at time zone v_tz)::date;

  with c as (
    select d.*,
           d.payload ->> 'action' as action,
           (d.created_at at time zone v_tz)::date as made_on,
           -- the end of the card's week, in the person's zone
           ((d.week_start + 7)::timestamp at time zone v_tz) as week_end_at
      from drona_cards d
     where d.user_id = p_user_id
  ),
  cf as (
    select c.*,
           case when c.status <> 'pending' then c.status
                when v_now >= coalesce(c.expires_at, c.week_end_at) then 'expired'
                else 'waiting' end as outcome,
           case c.action
             when 'log_weight' then (
               select min(m.updated_at) from daily_metrics m
                where m.user_id = p_user_id and m.metric_type = 'bodyweight_kg'
                  and m.metric_date >= c.made_on and m.updated_at >= c.created_at
                  and m.updated_at < c.week_end_at)
             when 'start_session' then (
               select min(w.started_at) from workouts w
                where w.user_id = p_user_id and w.finished_at is not null
                  and w.started_at >= c.created_at and w.started_at < c.week_end_at)
             when 'log_food' then (
               select min(ml.logged_at) from meals ml
                where ml.user_id = p_user_id
                  and ml.logged_at >= c.created_at and ml.logged_at < c.week_end_at)
           end as followed_at,
           c.action in ('log_weight', 'start_session', 'log_food') as has_test,
           (select count(*) from plan_changes pc where pc.card_id = c.id)::int as changes
      from c
  ),
  wk as (
    select g::date as week_start from generate_series(v_from, v_to, interval '7 days') g
     where g::date <= v_today
  ),
  totals as (
    select wk.week_start,
           count(cf.*) filter (where cf.kind <> 'hold')::int as shown,
           count(cf.*) filter (where cf.kind <> 'hold' and cf.outcome not in ('expired', 'waiting'))::int as answered,
           count(cf.*) filter (where cf.kind <> 'hold' and cf.deferred_at is not null)::int as later,
           count(cf.*) filter (where cf.kind <> 'hold' and cf.outcome = 'expired')::int as ignored,
           count(cf.*) filter (where cf.kind = 'hold')::int as holds
      from wk left join cf on cf.week_start <= wk.week_start
     group by wk.week_start
  )
  insert into drona_week_facts as t (
    user_id, week_start, c_card_id, c_kind, c_topic, c_title, c_signals, c_action, c_status, c_outcome,
    c_seen_possible, c_deferred, c_hours_to_later, c_hours_to_answer, c_plan_changes,
    c_followed_through, c_hours_to_follow,
    c_cards_to_date, c_answered_to_date, c_later_to_date, c_ignored_to_date, c_holds_to_date, c_computed_at
  )
  select p_user_id, wk.week_start, cf.id, cf.kind, cf.topic, nullif(cf.title, ''), cf.signals, cf.action,
         cf.status, cf.outcome,
         case when cf.id is not null then cf.kind <> 'hold' end,
         case when cf.id is not null then cf.deferred_at is not null end,
         round((extract(epoch from cf.deferred_at - cf.created_at) / 3600)::numeric, 1),
         round((extract(epoch from cf.decided_at - cf.created_at) / 3600)::numeric, 1),
         cf.changes,
         case when cf.has_test then cf.followed_at is not null end,
         round((extract(epoch from cf.followed_at - cf.created_at) / 3600)::numeric, 1),
         tt.shown, tt.answered, tt.later, tt.ignored, tt.holds, now()
    from wk
    left join cf on cf.week_start = wk.week_start
    join totals tt on tt.week_start = wk.week_start
  on conflict (user_id, week_start) do update set
    c_card_id = excluded.c_card_id, c_kind = excluded.c_kind, c_topic = excluded.c_topic,
    c_title = excluded.c_title, c_signals = excluded.c_signals, c_action = excluded.c_action,
    c_status = excluded.c_status, c_outcome = excluded.c_outcome, c_seen_possible = excluded.c_seen_possible,
    c_deferred = excluded.c_deferred, c_hours_to_later = excluded.c_hours_to_later,
    c_hours_to_answer = excluded.c_hours_to_answer, c_plan_changes = excluded.c_plan_changes,
    c_followed_through = excluded.c_followed_through, c_hours_to_follow = excluded.c_hours_to_follow,
    c_cards_to_date = excluded.c_cards_to_date, c_answered_to_date = excluded.c_answered_to_date,
    c_later_to_date = excluded.c_later_to_date, c_ignored_to_date = excluded.c_ignored_to_date,
    c_holds_to_date = excluded.c_holds_to_date, c_computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke all on function public.drona_rebuild_card_facts(text, date, date) from public, anon, authenticated;
grant execute on function public.drona_rebuild_card_facts(text, date, date) to service_role;
