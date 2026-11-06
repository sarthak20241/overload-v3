-- Food box threads: the server's durable copy of a food box conversation.
-- Plan: .planning/precise-food-logger-plan.md, section 3 (step 1b).
--
-- Why. Live 2026-11-05 a lunch card was lost, and three "bring back that card"
-- messages went to a step that could not see it. The app holds the hot copy
-- (the open card and recent turns) and sends it with every message, as today.
-- These tables are the safe copy: they survive an app restart, and they keep
-- every earlier version of every card, so a card can be brought back.
--
--   food_threads       one conversation. Closes when its card is added, or
--                      after 30 minutes with no message (owner decision).
--   food_thread_turns  every turn, in order.
--   food_cards         a card in a thread: the meal card, or a save card
--                      beside it. `version` goes up by one per change.
--   food_card_lines    the lines of each card VERSION, kept for every version.
--                      `line_id` is stable across versions ("L2" stays L2), so
--                      a removal never renumbers what another change points at.
--
-- One write per change, and only on top of the version it started from:
-- food_card_write() writes version p_base_version + 1, in one statement, and
-- adds the new version's lines in the same transaction. It writes only when
-- the server is AT that base, or behind it (a write it missed: the app sent
-- its whole card, so the app's copy is the newer one and its count wins).
-- A base older than the server's (two devices, a retry racing the first try)
-- writes nothing and returns the current version. A retry of the same message
-- (same client_id) does not make a second version.
--
-- Written by the ai-coach edge function only (service role), behind the
-- FOOD_THREADS switch (off | shadow | on). No client reads or writes them.
-- Apply to live via Supabase MCP apply_migration only (project rule), and only
-- with the owner's yes. Not applied by this PR.

create table if not exists public.food_threads (
  id          uuid        primary key default gen_random_uuid(),
  user_id     text        not null,
  started_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  status      text        not null default 'open' check (status in ('open', 'closed')),
  -- Why it closed: its card was added, it sat idle 30 minutes, or the app
  -- started a new one.
  closed_why  text        check (closed_why in ('added', 'idle', 'replaced')),
  -- Up to 2 lines, for the hot context. Filled by a later step; null today.
  summary     text
);

create table if not exists public.food_thread_turns (
  thread_id   uuid        not null references public.food_threads (id) on delete cascade,
  seq         integer     not null check (seq >= 1),
  role        text        not null check (role in ('user', 'drona')),
  text        text        not null,
  -- The app's id for the message, so a retried send adds its turns once.
  client_id   text,
  created_at  timestamptz not null default now(),
  primary key (thread_id, seq)
);

create table if not exists public.food_cards (
  id              uuid        primary key default gen_random_uuid(),
  thread_id       uuid        not null references public.food_threads (id) on delete cascade,
  -- 'meal': the card being logged. 'save': a save card beside it.
  kind            text        not null default 'meal' check (kind in ('meal', 'save')),
  -- Below 1 only inside food_card_create, between its insert and first write.
  version         integer     not null default 0 check (version >= 0),
  status          text        not null default 'open' check (status in ('open', 'added', 'discarded', 'replaced')),
  meal_type       text        check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  day             date,
  -- The message that made the current version (idempotency key).
  last_client_id  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.food_card_lines (
  card_id     uuid     not null references public.food_cards (id) on delete cascade,
  version     integer  not null,
  line_id     text     not null,
  line_no     integer  not null,
  name        text     not null,
  said_name   text,
  grams       numeric,
  quantity    numeric,
  unit        text,
  kcal        numeric  not null,
  protein_g   numeric,
  carb_g      numeric,
  fat_g       numeric,
  fiber_g     numeric,
  source      text,
  source_ref  text,
  confidence  text,
  note        text,
  meal_type   text,
  primary key (card_id, version, line_id)
);

create index if not exists idx_food_threads_user_open on public.food_threads (user_id, last_at desc) where status = 'open';
-- Every thread of a user, for the account-delete trigger.
create index if not exists idx_food_threads_user on public.food_threads (user_id);
create index if not exists idx_food_cards_thread on public.food_cards (thread_id, created_at);
-- A retried send adds its turns once: one user turn and one Drona turn per
-- client id (the code checks first; this makes it hold under a race too).
create unique index if not exists uq_food_thread_turns_client on public.food_thread_turns (thread_id, client_id, role) where client_id is not null;

-- New public tables start fully granted to anon and authenticated
-- (project_supabase_default_grants). Revoke everything: only the edge
-- function, as service_role, reads or writes these. RLS on with no policy, so
-- even a stray grant shows nothing.
alter table public.food_threads      enable row level security;
alter table public.food_thread_turns enable row level security;
alter table public.food_cards        enable row level security;
alter table public.food_card_lines   enable row level security;
revoke all on public.food_threads      from anon, authenticated;
revoke all on public.food_thread_turns from anon, authenticated;
revoke all on public.food_cards        from anon, authenticated;
revoke all on public.food_card_lines   from anon, authenticated;

-- The one conditional write. Returns the card's version after the call and
-- whether this call wrote it:
--   out_written = true   out_version is base + 1, with p_lines as its lines
--   out_written = false  nothing changed: the base was older than the server's, or this client_id
--                    already made the current version (a retry). `out_version`
--                    is the current one, so the caller can reload.
-- p_lines: [{line_id, name, kcal, ...}] in card order.
create or replace function public.food_card_write(
  p_card_id uuid,
  p_base_version integer,
  p_lines jsonb,
  p_client_id text default null,
  p_status text default null,
  p_meal_type text default null
)
returns table (out_version integer, out_written boolean)
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
         updated_at = now()
   where c.id = p_card_id
     and c.version <= p_base_version
     and (p_client_id is null or c.last_client_id is distinct from p_client_id)
  returning c.version into v_new;

  if v_new is null then
    select c.version, c.last_client_id into v_cur, v_last from public.food_cards c where c.id = p_card_id;
    return query select v_cur, false;
    return;
  end if;

  insert into public.food_card_lines (
    card_id, version, line_id, line_no, name, said_name, grams, quantity, unit,
    kcal, protein_g, carb_g, fat_g, fiber_g, source, source_ref, confidence, note, meal_type
  )
  select p_card_id, v_new, e.j->>'line_id', e.ord::integer, e.j->>'name', e.j->>'said_name',
         (e.j->>'grams')::numeric, (e.j->>'quantity')::numeric, e.j->>'unit',
         (e.j->>'kcal')::numeric, (e.j->>'protein_g')::numeric, (e.j->>'carb_g')::numeric,
         (e.j->>'fat_g')::numeric, (e.j->>'fiber_g')::numeric,
         e.j->>'source', e.j->>'source_ref', e.j->>'confidence', e.j->>'note', e.j->>'meal_type'
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as e(j, ord);

  return query select v_new, true;
end;
$$;

revoke all on function public.food_card_write(uuid, integer, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.food_card_write(uuid, integer, jsonb, text, text, text) to service_role;

-- A new card with its first lines, in one transaction. The id is the app's
-- (it makes one when a card starts), and so is the starting version: 1 for a
-- card that starts now, or the app's own version for a card the server has
-- not seen yet (the switch went on mid-thread, or an earlier write failed).
create or replace function public.food_card_create(
  p_card_id uuid,
  p_thread_id uuid,
  p_kind text,
  p_lines jsonb,
  p_client_id text default null,
  p_meal_type text default null,
  p_version integer default 1
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v integer;
begin
  insert into public.food_cards (id, thread_id, kind, meal_type, version)
  values (p_card_id, p_thread_id, p_kind, p_meal_type, greatest(p_version, 1) - 1);
  select w.out_version into v from public.food_card_write(p_card_id, greatest(p_version, 1) - 1, p_lines, p_client_id) w;
  return v;
end;
$$;

revoke all on function public.food_card_create(uuid, uuid, text, jsonb, text, text, integer) from public, anon, authenticated;
grant execute on function public.food_card_create(uuid, uuid, text, jsonb, text, text, integer) to service_role;

-- Account deletion removes the threads (and, by cascade, their turns, cards
-- and lines). A trigger on user_profiles, the same pattern as 20261105120100,
-- so it holds whatever body delete_user_data has.
create or replace function public.delete_food_threads_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.food_threads where user_id = old.clerk_user_id;
  return old;
end;
$$;

revoke all on function public.delete_food_threads_on_profile_delete() from public, anon, authenticated;

drop trigger if exists trg_delete_food_threads_on_profile_delete on public.user_profiles;
create trigger trg_delete_food_threads_on_profile_delete
  after delete on public.user_profiles
  for each row execute function public.delete_food_threads_on_profile_delete();

notify pgrst, 'reload schema';
