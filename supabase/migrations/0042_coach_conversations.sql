-- 0042_coach_conversations.sql
--
-- Phase 1 of the coach enhancement: durable, cross-device chat history.
--
-- The coach chat is persisted locally first (lib/coachConversations.ts) so it
-- survives the sheet closing. This migration adds the server-side mirror so a
-- conversation also survives a reinstall and follows the user to a new device.
-- The ai-coach edge function writes here best-effort after each successful turn
-- (try/catch, never blocking the reply), keyed by a client-minted conversation
-- id (newClientId), mirroring the workouts.client_id idempotency pattern (0038).
--
-- Two tables:
--   coach_conversations          one row per chat thread (owner = Clerk sub)
--   coach_conversation_messages  the turns, scoped via the parent conversation
--                                exactly like workout_sets is scoped via workouts
--
-- RLS follows the inline `auth.jwt()->>'sub'` idiom from 0001. The messages
-- table carries no user_id of its own; ownership is enforced through the parent
-- conversation, so a message can only be written into a conversation the caller
-- owns.

-- ─── coach_conversations ─────────────────────────────────────────────────────
create table if not exists coach_conversations (
  id                   uuid primary key,                       -- client-minted (newClientId)
  user_id              text not null default (auth.jwt()->>'sub'),
  title                text,                                   -- first-user-message snippet, set once
  mode                 text not null default 'chat',
  last_message_preview text,                                   -- updated each turn for the list UI
  archived             boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists ix_coach_conversations_user
  on coach_conversations (user_id, updated_at desc)
  where archived = false;

alter table coach_conversations enable row level security;

create policy "own coach_conversations select" on coach_conversations
  for select to authenticated
  using (user_id = auth.jwt()->>'sub');

create policy "own coach_conversations insert" on coach_conversations
  for insert to authenticated
  with check (user_id = auth.jwt()->>'sub');

create policy "own coach_conversations update" on coach_conversations
  for update to authenticated
  using (user_id = auth.jwt()->>'sub')
  with check (user_id = auth.jwt()->>'sub');

create policy "own coach_conversations delete" on coach_conversations
  for delete to authenticated
  using (user_id = auth.jwt()->>'sub');

grant select, insert, update, delete on coach_conversations to authenticated;

-- ─── coach_conversation_messages ─────────────────────────────────────────────
create table if not exists coach_conversation_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references coach_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  citations       jsonb,                                       -- preserve [N] footnotes on replay
  client_msg_id   text,                                        -- idempotency key (per conversation)
  created_at      timestamptz not null default now()
);

create index if not exists ix_ccm_conversation
  on coach_conversation_messages (conversation_id, created_at);

-- Idempotent replay: a retried mirror write can't duplicate a turn. Partial so
-- legacy / null-keyed rows are unconstrained (mirrors uq_workouts_client_id).
create unique index if not exists uq_ccm_client_msg
  on coach_conversation_messages (conversation_id, client_msg_id)
  where client_msg_id is not null;

alter table coach_conversation_messages enable row level security;

-- Scoped via the parent conversation (same idiom as workout_sets via workouts):
-- a message is visible / writable only when its conversation is owned by the
-- caller. This also blocks writing a message into someone else's conversation.
create policy "own ccm select" on coach_conversation_messages
  for select to authenticated
  using (exists (
    select 1 from coach_conversations c
    where c.id = coach_conversation_messages.conversation_id
      and c.user_id = auth.jwt()->>'sub'
  ));

create policy "own ccm insert" on coach_conversation_messages
  for insert to authenticated
  with check (exists (
    select 1 from coach_conversations c
    where c.id = coach_conversation_messages.conversation_id
      and c.user_id = auth.jwt()->>'sub'
  ));

create policy "own ccm update" on coach_conversation_messages
  for update to authenticated
  using (exists (
    select 1 from coach_conversations c
    where c.id = coach_conversation_messages.conversation_id
      and c.user_id = auth.jwt()->>'sub'
  ))
  with check (exists (
    select 1 from coach_conversations c
    where c.id = coach_conversation_messages.conversation_id
      and c.user_id = auth.jwt()->>'sub'
  ));

create policy "own ccm delete" on coach_conversation_messages
  for delete to authenticated
  using (exists (
    select 1 from coach_conversations c
    where c.id = coach_conversation_messages.conversation_id
      and c.user_id = auth.jwt()->>'sub'
  ));

grant select, insert, update, delete on coach_conversation_messages to authenticated;

-- ─── Account deletion ────────────────────────────────────────────────────────
-- Extend delete_user_data() to wipe coach history. Reproduces the existing body
-- (create or replace) and adds the two new deletes. Messages are removed via the
-- parent join (same shape as the workout_sets delete) before the conversations.
create or replace function delete_user_data(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from workout_sets ws
    using workouts w
    where ws.workout_id = w.id
      and w.user_id = p_user_id;

  delete from workouts where user_id = p_user_id;

  delete from routine_exercises re
    using routines r
    where re.routine_id = r.id
      and r.user_id = p_user_id;

  delete from routines where user_id = p_user_id;

  delete from coach_conversation_messages m
    using coach_conversations c
    where m.conversation_id = c.id
      and c.user_id = p_user_id;

  delete from coach_conversations where user_id = p_user_id;

  delete from user_profiles where clerk_user_id = p_user_id;

  delete from ai_coach_rate_limit where user_id = p_user_id;
end;
$$;

revoke all on function delete_user_data(text) from public, anon, authenticated;
grant execute on function delete_user_data(text) to service_role;
