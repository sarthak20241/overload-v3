-- 0147_coach_memory.sql (was 0127_coach_memory.sql on an unmerged branch)
--
-- ALREADY APPLIED LIVE on 2026-09-19 as schema_migrations 20260919023437
-- "coach_memory". It is committed now so the repo matches the database. The
-- number moved because main took 0127 (drona_card_later) and PR #218 holds
-- 0131-0138 and 0142-0146. Do not re-apply: the table and index are guarded,
-- but the policy is not. delete_user_data is left to 0146 (see the end).
--
--
-- Drona was stateless between conversations. A user who said "keep sessions
-- under 45 minutes" in a refine chat on Monday had to say it again in plain
-- chat on Thursday, and a decision made together ("cut to 2100 kcal because
-- weight stalled") lived only in a transcript on one phone. Plan:
-- .planning/coach-enhancement-plan.md, Problem 2 (locked 2026-06-15, built now).
--
--   coach_memory          one row per (user, category, key). Saving the same
--                         key again REPLACES the value, so a changed mind
--                         supersedes instead of piling up. A row the user asked
--                         to forget stays as status='dismissed' so the same
--                         sentence is not re-learned next session; a NEW value
--                         for that key re-activates it (the user just said it).
--   coach_remember_fact   the only write path. The edge function calls it from
--                         the model's remember_fact tool with the user's JWT.
--   coach_forget_fact     soft delete (status='dismissed').
--
-- Both RPCs are SECURITY DEFINER and self-filter on current_clerk_user_id():
-- the table grants authenticated SELECT only, so nothing but these two functions
-- can write it. The edge function reads the active rows with the user's client
-- (RLS) and folds them into user_context.memory.
--
-- Facts are read by every mode (chat, refine, discuss, program, plan fan-out)
-- because they ride user_context, so a saved constraint shapes the next plan
-- automatically.

create table if not exists public.coach_memory (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default current_clerk_user_id(),
  category    text not null check (category in (
                'preference', 'constraint', 'injury', 'equipment', 'schedule',
                'diet', 'goal_context', 'decision', 'other')),
  -- A short stable label, lower-cased and whitespace-collapsed by the RPC so
  -- "Session length" and "session  length" are one fact.
  key         text not null check (length(key) between 1 and 60),
  value       text not null check (length(value) between 1 and 300),
  -- Which conversation saved it. 'user' is reserved for a future edit screen.
  source      text not null default 'chat' check (source in (
                'chat', 'refine_workout', 'refine_plan', 'discuss_workout', 'discuss_plan',
                'discuss_program', 'refine_program', 'live_workout', 'user')),
  status      text not null default 'active' check (status in ('active', 'dismissed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, category, key)
);

create index if not exists coach_memory_user_recent_idx
  on public.coach_memory (user_id, status, updated_at desc);

alter table public.coach_memory enable row level security;

-- New public tables start FULLY granted to authenticated. A bare GRANT never
-- narrows, so revoke first, then give back reads only.
revoke all on public.coach_memory from anon, authenticated;
grant select on public.coach_memory to authenticated;

drop policy if exists "own coach memory select" on public.coach_memory;
create policy "own coach memory select" on public.coach_memory
  for select to authenticated using (user_id = current_clerk_user_id());

-- ── Remember ─────────────────────────────────────────────────────────────────
-- Upsert-and-supersede. Returns {saved, updated, id} or {saved:false, reason}.
-- Never raises for bad input: the model reads the reason and moves on.
create or replace function public.coach_remember_fact(
  p_category text, p_key text, p_value text, p_source text default 'chat'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  uid      text := current_clerk_user_id();
  v_key    text := lower(regexp_replace(btrim(coalesce(p_key, '')), '\s+', ' ', 'g'));
  v_value  text := regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g');
  v_source text := case when p_source in (
                     'chat', 'refine_workout', 'refine_plan', 'discuss_workout', 'discuss_plan',
                     'discuss_program', 'refine_program', 'live_workout', 'user')
                   then p_source else 'chat' end;
  v_cap    constant int := 60;
  v_row    public.coach_memory%rowtype;
  v_id     uuid;
  v_active int;
begin
  if uid is null then
    return jsonb_build_object('saved', false, 'reason', 'not signed in');
  end if;
  if p_category is null or p_category not in (
       'preference', 'constraint', 'injury', 'equipment', 'schedule',
       'diet', 'goal_context', 'decision', 'other') then
    return jsonb_build_object('saved', false, 'reason',
      'category must be one of preference, constraint, injury, equipment, schedule, diet, goal_context, decision, other');
  end if;
  if length(v_key) < 1 or length(v_key) > 60 then
    return jsonb_build_object('saved', false, 'reason', 'key must be 1 to 60 characters');
  end if;
  if length(v_value) < 1 or length(v_value) > 300 then
    return jsonb_build_object('saved', false, 'reason', 'value must be 1 to 300 characters');
  end if;

  select * into v_row from public.coach_memory
   where user_id = uid and category = p_category and key = v_key;

  if found then
    -- The user asked to forget exactly this sentence: do not re-learn it. A
    -- different value under the same key is new information and re-activates.
    if v_row.status = 'dismissed' and v_row.value = v_value then
      return jsonb_build_object('saved', false, 'reason',
        'the user asked you to forget this; it was not saved again');
    end if;
    update public.coach_memory
       set value = v_value, source = v_source, status = 'active', updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('saved', true, 'updated', true, 'id', v_row.id);
  end if;

  insert into public.coach_memory (user_id, category, key, value, source)
  values (uid, p_category, v_key, v_value, v_source)
  returning id into v_id;

  -- Cap the active set. The oldest-touched facts go first; a fact the coach
  -- keeps updating stays fresh and survives.
  select count(*) into v_active from public.coach_memory
   where user_id = uid and status = 'active';
  if v_active > v_cap then
    delete from public.coach_memory
     where id in (
       select id from public.coach_memory
        where user_id = uid and status = 'active'
        order by updated_at asc
        limit v_active - v_cap);
  end if;

  return jsonb_build_object('saved', true, 'updated', false, 'id', v_id);
end;
$function$;

-- ── Forget ───────────────────────────────────────────────────────────────────
-- p_category may be null: then every active fact under that key is dismissed.
create or replace function public.coach_forget_fact(p_key text, p_category text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  uid   text := current_clerk_user_id();
  v_key text := lower(regexp_replace(btrim(coalesce(p_key, '')), '\s+', ' ', 'g'));
  v_n   int;
begin
  if uid is null then
    return jsonb_build_object('forgotten', 0, 'reason', 'not signed in');
  end if;
  if length(v_key) < 1 then
    return jsonb_build_object('forgotten', 0, 'reason', 'key is required');
  end if;

  update public.coach_memory
     set status = 'dismissed', updated_at = now()
   where user_id = uid and key = v_key and status = 'active'
     and (p_category is null or category = p_category);
  get diagnostics v_n = row_count;

  return jsonb_build_object('forgotten', v_n);
end;
$function$;

revoke all on function public.coach_remember_fact(text, text, text, text) from public, anon;
grant execute on function public.coach_remember_fact(text, text, text, text) to authenticated;
revoke all on function public.coach_forget_fact(text, text) from public, anon;
grant execute on function public.coach_forget_fact(text, text) to authenticated;

-- ── Account deletion ─────────────────────────────────────────────────────────
-- The live apply on 2026-09-19 also redefined delete_user_data (0121's body plus
-- coach_memory). That body is left out of this file on purpose: 0146 (PR #218)
-- redefines delete_user_data later and already deletes coach_memory, so a stale
-- copy here, numbered after 0146, would drop the facts tables from deletion.
