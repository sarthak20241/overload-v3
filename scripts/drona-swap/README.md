# The permanent swap: live checks

One probe runs against the LIVE project with two made-up users, then removes
them with `delete_user_data`. It needs `.env.local` with `SUPABASE_JWT_SECRET`
and `SUPABASE_SERVICE_ROLE_KEY`.

```bash
npx tsx scripts/drona-swap/swap.mts   # facts, access, apply, log, undo (33 checks)
```

It builds a routine, four sessions that all replace the planned exercise with
the same other one, then checks the whole path: the facts function, who may
call what, the worker's auto-apply, the plan change log row, Undo, and the two
cases where nothing must move (the user edited the routine first; the run
broke). The rules themselves are unit-tested in
`supabase/functions/_shared/dronaSwap.test.ts`.
