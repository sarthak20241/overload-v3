# circle-rate → Overload migration

One-off tooling to migrate **workout history** for specific users from the
legacy `circle-rate` MongoDB Atlas cluster into the Overload Supabase database
(`workouts` / `workout_sets`, scoped per Clerk `user_id`).

> Secrets live in `.env.migration` (gitignored). Never commit the connection
> string or any export of user data.

## Why this exists / the constraint

The Claude Code cloud sandbox runs under a restrictive network policy:
`*.mongodb.net` does not resolve and outbound 27017 is blocked, so the
migration cannot connect to Atlas from inside a default web session. To run the
**direct-connect** path, two gates must both be open:

1. **This environment's egress** must allow `*.mongodb.net` over TCP 27017
   (+ SRV DNS). See https://code.claude.com/docs/en/claude-code-on-the-web
   (network access / environment configuration). Note: an egress policy change
   may only take effect in a **new** session/container.
2. **Atlas Network Access** (Atlas → Security → Network Access) must allow this
   host's outbound IP. If the egress IP is dynamic, temporarily allow
   `0.0.0.0/0`, then tighten afterward.

If direct connect proves impractical (HTTP-only proxy, no raw TCP), fall back
to: you run `discover.mjs` / a `mongodump` where both DBs are reachable and
share the JSON, and the transform + Supabase load happens from that export.

## Steps

```bash
cd scripts/migration
cp .env.migration.example .env.migration   # fill in MONGO_URI
npm install                                  # mongodb driver
node discover.mjs                            # read-only: maps DB + shows the 2 users' docs
```

`discover.mjs` writes nothing. It prints each collection's shape and any
documents matching the target users so we can design the field mapping into:

| Overload table  | Source (TBD after discovery)                          |
| --------------- | ----------------------------------------------------- |
| `user_profiles` | match existing by `email`; create if missing          |
| `workouts`      | one row per workout session (`started_at`, duration…) |
| `workout_sets`  | per-set weight/reps, linked to an `exercises` row      |

Existing Overload users are matched by email so we **upsert** rather than
duplicate. The transform/load script (`migrate.mjs`) is written once the source
document shape is known.

## Target users

- `rana.sankalp99@gmail.com` (rana_sankalp99)
- `tushar19212@iiitd.ac.in` (tushar19212)

After completion, **rotate the Atlas password** — it was shared in chat.
