# Coach memory checks

Run the local regression checks first, then check model choice, the write path,
and the deployed service.

## Migration regression checks (local, no credentials or deploy)

```bash
deno test --no-lock --node-modules-dir=none --allow-read scripts/coach-memory-eval/migration.test.ts
```

Runs the actual SQL in an in-memory PostgreSQL instance: deletion with and
without the optional facts tables, account isolation and RPC permissions,
the 60-active-fact cap after reactivation, and shared remember/forget locking. The historical migration uses
its verified live version, `20260919023437`; do not apply it again on live.
The later `coach_memory_cleanup_and_cap` migration is a new forward repair
and must be applied before deploying the memory tools. It does not require #218.

## 1. Does the model choose remember_fact? (no deploy needed)

```bash
EVAL_VIA_CLI=1 REPEAT=3 npx tsx scripts/coach-memory-eval/run.mts
```

Four "save" cases (injury, equipment, constraint, in chat / discuss_program /
live_workout) and two "skip" cases (a history question, today's soreness).
2026-09-27, via CLI: 18/18.

## 2. Does the write path work? (live DB, rolled back)

Run in the Supabase SQL editor or the MCP `execute_sql`. Nothing is kept.

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_probe_memory_rollback","role":"authenticated"}';
select public.coach_remember_fact('injury','acl history','Tore ACL two years ago.','chat');
select category, key, value, status from public.coach_memory where user_id = 'user_probe_memory_rollback';
rollback;
```

## 3. End to end, after ai-coach is deployed

ai-coach checks a real Clerk token (JWKS), so a minted HS256 token will not
get through. Use a TEST account in the app.

1. Record the test account's Clerk user ID and the UTC time before sending.
   In Drona chat, send `I tore my ACL two years ago, I still avoid deep squats.`
   with a unique probe label appended, for example `Memory probe: <UUID>`.
   Record the UTC time when the reply completes.
2. Replace the placeholders below with that account, the full message and the
   two timestamps. Locate the exact request, then use its trace ID in the
   second query. Require exactly one matching successful trace; recent traces
   from other accounts are not evidence for this test.

```sql
select id, request_at, status, mode, tool_calls, spans->'tool_errors' as tool_errors
from coach_traces
where user_id = '<TEST_CLERK_USER_ID>'
  and last_user_message_preview = '<EXACT_MESSAGE_WITH_UNIQUE_PROBE_LABEL>'
  and request_at between '<SEND_TIME_UTC>'::timestamptz and '<REPLY_TIME_UTC>'::timestamptz;

select m.user_id, m.category, m.key, m.value, m.status, m.updated_at
from coach_memory m
join coach_traces t on t.user_id = m.user_id
where t.id = '<EXACT_TRACE_UUID>'::uuid
  and t.user_id = '<TEST_CLERK_USER_ID>'
  and t.status = 'success'
  and 'remember_fact' = any(t.tool_calls)
  and m.category = 'injury'
  and m.status = 'active'
  and m.value ilike '%ACL%'
  and m.updated_at between t.request_at and '<REPLY_TIME_UTC>'::timestamptz;
```

Pass: the exact test request succeeded with `remember_fact`, and its account
has an active injury memory updated during that request. Read the value to
confirm it describes the ACL history and squat avoidance from the message.
`remember_fact__rejected` or `remember_fact__error`
means the call ran and the database refused it; the reason is in
`spans.tool_errors`.

3. Start a NEW chat and ask for a leg day. Drona should work around the knee
   without being told again (the fact rides `user_context.memory`).
