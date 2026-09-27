# Coach memory checks

Three checks, from cheapest to the one that proves production.

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

1. In Drona chat, send: `I tore my ACL two years ago, I still avoid deep squats.`
2. Check the trace and the row:

```sql
select created_at, mode, tool_calls, spans->'tool_errors' as tool_errors
from coach_traces
where created_at > now() - interval '15 minutes'
order by created_at desc limit 5;

select user_id, category, key, value, status, updated_at
from coach_memory
order by updated_at desc limit 5;
```

Pass: `tool_calls` contains `remember_fact`, and a `coach_memory` row exists
with category `injury`. `remember_fact__rejected` or `remember_fact__error`
means the call ran and the database refused it; the reason is in
`spans.tool_errors`.

3. Start a NEW chat and ask for a leg day. Drona should work around the knee
   without being told again (the fact rides `user_context.memory`).
