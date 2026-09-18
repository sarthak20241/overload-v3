# Plan change log: live checks

Two probes run against the LIVE project with a made-up user id, then remove
everything with `delete_user_data`. They need `.env.local` with
`SUPABASE_JWT_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`.

```bash
npx tsx scripts/plan-change-log/planlog.mts   # triggers, folding, routine diffs, access (26 checks)
npx tsx scripts/plan-change-log/wrapper.mts   # withChangeSource on the real client (7 checks)
```
