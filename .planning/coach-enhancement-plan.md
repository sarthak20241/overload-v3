# Coach Drona Enhancement Plan

Status: approved 2026-06-15. Direction locked, building in phases.

Three gaps, one root cause: Coach Drona is stateless on both ends. The chat lives in a
React `useState` that dies when the sheet unmounts, the edge function persists nothing
user-facing, and the only thing the coach "knows" is structured training data. This plan
gives conversations a home, teaches the coach to remember the user, and lets the user
browse and continue past chats.

## Locked decisions

1. Memory: auto-learn from chat, plus an editable "What Coach knows about you" screen.
2. History: cloud, cross-device (local first, then synced to Supabase).
3. Memory mechanism: in-loop `remember_fact` tool (no second model call).
4. Memory storage: per-fact rows with `(category, key, value)` upsert-and-supersede.
5. State location: module-scope store keyed by Clerk user id (mirrors `useCoachAccess`).
6. Durable write path: edge-function server-side mirror (no client sync-queue; the
   sync-queue is workout-bespoke and chat is online-only, so a queue buys nothing).
7. Resume strategy: resend a sliding window of recent turns (no summarization). Bounded
   tokens with zero model calls; durable facts from early turns survive in memory anyway.

## Why this direction

`buildSystemPrompt` (supabase/functions/ai-coach/prompt.ts:487) already uses all three of
its cache breakpoints (static block, user-context block, last tool), with retrieved
research deliberately left uncached as headroom. So new memory cannot get its own cached
block; it has to ride the existing `get_user_coach_context()` payload. That single fact is
why the in-loop tool design wins over a separate memory block or a Haiku extraction pass.
The rate-limit row is also inserted unconditionally (index.ts:664) before any mode
parsing, so no extraction or titling work may route back through the chat handler.

---

## Problem 1: Persistence

Why it breaks: the conversation is local `useState` in `ChatScreen`
(components/ai/AICoachModal.tsx:743), and the sheet renders as `{visible && (...)}` inside
a Portal (AICoachModal.tsx:2659). Closing the sheet, or tapping back to the menu
(`setScreen('menu')`), unmounts the component and discards every message.

Fix: lift conversation state into a module-scope, AsyncStorage-backed store keyed by Clerk
user id, copying the discipline proven in hooks/useCoachAccess.ts:79 (including the
cross-user reset on sign-out so one account's chat never leaks into the next). The live and
review workout chats stay intentionally ephemeral (their recap is rebuilt on every open),
so when `workoutContext != null` the chat bypasses persistence.

New files:
- `lib/coachConversations.ts`: module-scope store, per-user keyed, AsyncStorage write-
  through with debounce, plus immediate persist on message-count change. Sanitizes out the
  empty streaming placeholder and the transient `thinkingPhase`. Caps stored conversations.
- `hooks/useCoachConversation.ts`: owns `messages`/`setMessages`, hydrates on mount,
  adopts the active conversation if the user has not started typing, and exposes
  `startNewChat`.

Edits:
- components/ai/AICoachModal.tsx: route `ChatScreen` message state through the hook
  (`enabled = !workoutContext`); add a "New chat" header action; pass `userId` to
  `ChatScreen`; cap the messages sent to the edge function to a sliding window.
- app/(app)/profile.tsx: call `clearCoachConversations(prevUserId)` in the sign-out flow,
  next to `clearUserCache`.

Stored messages keep their `citations` so reopened transcripts render footnotes, not
dangling `[1]` markers. Conversation ids are minted with `newClientId()`
(lib/syncQueue.ts:62) so they line up with the server rows in P1.

---

## Problem 2: Memory (auto-learn + editable)

Mechanism: a new non-terminal `remember_fact` tool added to `COACH_TOOLS` only. The model
already runs a tool loop (index.ts:466); `remember_fact` returns a tiny "saved" and the
loop continues. Zero extra round-trips on turns where nothing is learned, no second model
call. A one-line instruction in the cached static prompt tells the coach to silently save
durable preferences, constraints, diet rules, injuries, equipment limits, schedule, and
life-context goals, and never narrate it.

Storage (migration 0040_coach_memory.sql): per-fact rows, `(category, key, value)` with
`UNIQUE(user_id, category, key)` so a contradicting fact updates and supersedes rather than
piling up. A `status` column (active | dismissed) means a fact the user deletes is not
silently re-learned next session. Categories: diet, equipment, injury, schedule,
preference, goal_context, other. RLS owner-only via `current_clerk_user_id()`.

RPCs: `coach_remember_fact(...)` (SECURITY INVOKER, upsert-and-supersede, cap ~30 rows),
`coach_forget_fact(p_id)` (soft delete to status='dismissed').

Injection: extend `get_user_coach_context()` (migration 0004:196) with one `coach_memory`
key, hard-capped (about 30 facts by confidence and recency). Critical correctness note: the
RPC is SECURITY DEFINER, so the sub-select MUST self-filter by `current_clerk_user_id()` or
it bypasses RLS. Because chat, generate, refine, and discuss share this RPC, facts shape
generated workouts and plans automatically.

Editable surface: `components/ai/CoachMemoryScreen.tsx` ("What Coach knows about you"), a
peer screen in the same Portal, grouped by category, swipe-to-forget, manual add.

Privacy: add `coach_memory` to `delete_user_data()` (migration 0003). The delete-account
function needs no change since it calls that.

Default: extraction fires in chat only, not mid-refine, so generation stays a deterministic
function of already-known facts. Revisit if users report repeating constraints.

---

## Problem 3: History (cloud, cross-device)

Tables (migration 0042_coach_conversations.sql):
- `coach_conversations(id text pk, user_id, title, mode, message_count, created_at,
  updated_at, archived)`, id is the client uuid (pattern from 0038 workouts.client_id).
- `coach_conversation_messages(id, conversation_id fk cascade, user_id, client_msg_id,
  role, content, citations jsonb, created_at)` with a partial unique index on
  `client_msg_id` for idempotent replay.

Both RLS owner-only; both added to `delete_user_data()` (messages cascade).

Write path: the edge function mirrors each turn best-effort after the stream, using the
RLS-scoped user client already in scope (index.ts:674), wrapped in try/catch like the
retrieval code so a persistence failure never breaks the SSE response. A conversation
becomes a server row only after the first real user send.

UI: `components/ai/ConversationListScreen.tsx`, reachable from a header icon, newest-first,
instant from the local index then reconciled with the server (server wins by `updated_at`).
Tap to open and continue. A coach-voice "Pick up where we left off" card on the menu, and a
friendly empty state. Titles are first-user-message snippets (free, no model call); a Haiku
titling pass is deferred.

---

## Phased rollout

- P0 (S): client-only persistence. Chat survives close, back-to-menu, and navigation. No
  migration, no edge change, guests included. Includes the sliding-window send cap.
- P1 (M): cloud conversations + history list + continue. Migration 0042, edge mirror, two
  new screens, `delete_user_data` update. Run `get_advisors` after the migration.
- P2 (M): memory. Migrations 0040/0041, `remember_fact` tool + handler, `CoachMemoryScreen`,
  `delete_user_data` update.
- P3 (deferred, documented only): rolling-summary for very long threads, gated on real cost
  in coach_traces. Not built preemptively.

## Open follow-ups (scoped out, decide later)

1. Persisting structured workout/plan cards into history (currently they render in their
   own screens, so a half-finished plan will not restore on reopen).
2. In-chat "that's wrong, forget it" memory correction, on top of the memory screen.
3. Guest-to-signed-in migration of locally stored guest conversations on first sign-in.
4. Memory extraction during refine/discuss, if generation should learn in the moment.
5. New-chat transition polish: tapping + swaps the thread with no visual cue it
   started fresh. Add a subtle fade or a brief "Started a new chat" affordance.
   Feels more natural once the history list (P1) exists. (Noted 2026-06-15.)

## Migration numbering

Next migration number is 0040 (last applied is 0039). Migrations are applied to the live DB
via the Supabase MCP tool, never `db push`.
