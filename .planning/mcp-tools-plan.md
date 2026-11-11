# MCP tools plan: log food and workouts from ChatGPT or Claude

Status: PLAN, nothing built. Written 2026-11-10.

## The idea in one line

The user adds Overload as a connector in their own ChatGPT or Claude. Their
assistant then reads their Overload data and writes food and workouts into it.
Their subscription does the thinking. We only store and serve data.

## How it works

```
ChatGPT / Claude  --(MCP over HTTPS + OAuth token)-->  edge function `mcp`
                                                          |  checks the token, finds the Clerk user id
                                                          |  checks Pro, checks the rate limit
                                                          v
                                                       Postgres (same tables the app uses)
```

- New edge function: `supabase/functions/mcp/`. One HTTP endpoint, no sessions
  (each call stands alone). No model calls, so the cost per call is near zero.
- It needs a `[functions.mcp]` block with `verify_jwt = false` in
  `supabase/config.toml`, the same as every other function.
- Sign-in: Clerk is the OAuth server. The user signs in with the same Overload
  account. ChatGPT and Claude both need OAuth with "dynamic client
  registration" (the assistant registers itself, no manual key). Clerk has
  this as a setting.
- Database access: the OAuth token is not a Clerk session token, so the
  database row rules (RLS) cannot read it. The function uses the service key
  and one data module where EVERY query takes `userId`. No query is written
  outside that module. This is the main safety rule of the build.

## Tools, first version

Read (9):

| Tool | Gives |
|---|---|
| `get_profile` | goal, units, time zone, calorie and macro targets |
| `get_day_nutrition` | one day: meals, lines, totals against target |
| `get_nutrition_history` | daily totals for a date range (max 90 days) |
| `list_workouts` | workouts in a date range, one line each |
| `get_workout` | one workout with every set |
| `get_exercise_history` | one exercise over time, plus best lifts (`user_lift_stats`) |
| `get_weekly_volume` | sets per muscle group per week (`user_volume_stats`) |
| `get_body_weight` | weigh-ins for a date range |
| `search_exercises` | exercise names to ids, so a workout log uses real exercises |

Write (6):

| Tool | Does |
|---|---|
| `log_food` | saves lines to a meal on a day |
| `update_food_entry` | changes one line: amount, macros, name, meal, or day |
| `delete_food_entries` | removes lines this connector wrote (the undo) |
| `log_workout` | saves one finished workout with its sets |
| `update_workout` | changes name, notes, time, or replaces the sets of one exercise |
| `delete_workout` | removes a workout this connector wrote (the undo) |

Updates work on any row the user owns, also rows logged in the app ("make my
lunch rice 200 g"). Each update returns the old values, so the assistant can
put the numbers back. A put-back restores the numbers, not the grade: new
numbers from an assistant are always origin `guess`, so a catalog or label line
whose macros were edited stays `guess` after a put-back. That is on purpose: an
assistant cannot raise a line's grade. To get a catalog line back, log it again
from the app. Deletes only touch rows the connector wrote. A wrong tool call
can then never remove what the user logged in the app.

`update_food_entry` rules: a new amount with no new macros scales the macros
by the same factor. A move to another meal or day uses the same find-or-create
meal step, and an empty meal left behind is removed (`lib/mealCleanup.ts`).
The line keeps its `origin`, unless the caller sends new macros: then it is
`guess`.

`update_workout` rules: sets are replaced per exercise (delete that
exercise's sets, insert the new ones, in one database function so the stats
triggers never see half a change). `total_volume_kg` is computed again.

### `log_food` input

```
date        "2026-11-10", optional, default = today in the user's time zone
meal_type   breakfast | lunch | dinner | snack
items[]     name, quantity, unit, grams (optional),
            kcal, protein_g, carb_g, fat_g, fiber_g (optional)
request_id  a unique id from the caller, so a retry never logs twice
```

Server rules:

- Same row shape as `logSection` in `lib/dietData.ts`. Same meal find-or-create.
- `logged_via = 'mcp'`. Needs a migration: the check allows only
  `manual`, `ai`, `ai_auto` today.
- `origin = 'guess'`, `source = 'estimate'`. The numbers come from the user's
  assistant, not from our catalog. So they must never replace a label or
  catalog row in food memory. Check the memory triggers treat `mcp` rows this
  way before shipping.
- Sanity checks in code: kcal against macros (4/4/9), max 50 lines, quantity
  above 0, date not more than 30 days ahead (the app's rule).
- Returns the saved lines and the new day totals against target.

### `log_workout` input

```
name, started_at, duration_minutes, notes (optional)
exercises[]  exercise_id (from search_exercises),
             sets[]: weight_kg, reps, duration_seconds, distance_m, rpe, set_type
request_id   becomes workouts.client_id, which is already unique
```

Server rules:

- Same rows as `flushPendingWorkout` in `lib/syncQueue.ts`.
- `workouts.source = 'mcp'`. Needs a migration: `workouts_source_check`.
- An unknown exercise is refused with the nearest names. No new exercises are
  made in v1.
- The stats triggers on `workout_sets` already update PRs and volume.
- XP: `award_xp` reads the user from a session token. Add a service-only
  variant that takes the user id.

## Rules for every call

- Pro only. A free account gets a clear "this needs Pro" answer.
- Rate limit per user (start: 60 calls per minute, 500 writes per day).
- One row per call in a new `mcp_traces` table (tool, status, ms, user). This
  is how we see use. Add it to account delete.
- Days are the user's local days, from `user_profiles.timezone`.

## Steps (one PR each)

0. **Spike, half a day.** Clerk OAuth + one `ping` tool. Connect it from Claude
   AND ChatGPT. This is the biggest risk, so it goes first. If Clerk does not
   work with both, stop and rethink sign-in before anything else.
1. **Read tools.** The 9 read tools + Pro check + rate limit + `mcp_traces`.
2. **Food writes.** `log_food`, `update_food_entry`, `delete_food_entries`, the
   `logged_via` migration.
3. **Workout writes.** `log_workout`, `update_workout`, `delete_workout`, the
   `source` migration. Connector workouts earn no XP (shipped instead of an XP
   variant).
4. **App + site.** A Profile row "Use with ChatGPT or Claude" with the URL to
   copy and 3 setup steps. A page on the website. Privacy policy line: the
   user's data goes to the assistant they connect.
5. **Directories.** Ask for a listing in the ChatGPT and Claude connector
   directories. Until then, users paste the URL as a custom connector.

Steps 2 and 3 do not depend on each other.

## Tests

- Deno unit tests beside the function, like `ai-coach/`. Add the command to
  CLAUDE.md.
- Write paths on PGlite (real Postgres), like `supabase/migrations/checks/`.
- A test that fails if any query in the data module has no `userId` filter.
- A test that user A's token cannot read or delete user B's rows.
- By hand: MCP Inspector, then real Claude and real ChatGPT.

## Things to check in the spike (not known yet)

1. Clerk OAuth tokens: which format, and how the function verifies them.
2. The Supabase function URL is `…supabase.co/functions/v1/mcp`. OAuth discovery
   wants a metadata file. Check both assistants accept it at that path. If not,
   put a small proxy on `mcp.tryoverload.app`.
3. Which ChatGPT plans can add a custom connector, and if write tools need
   "developer mode". This decides how many users can use it before step 5.
4. The app shows connector writes without a restart (cache refresh on open).

## Later, not v1

Routines and program read tools. Create custom exercises.
Use our own food catalog for the numbers (a `search_foods` tool), so a log is
`catalog` grade and not a guess.
