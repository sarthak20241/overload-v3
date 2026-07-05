# SPEC — Unilateral "L+R" set type

Status: BUILT + REVIEWED 2026-06-27 (type-clean, not yet committed). Branch `feat/exercise-set-types`
(PR #43). Migrations 0056 (cols + recompute) / 0057 (coach RPCs) / 0058 (last-set tiebreak) applied
live + mirrored + schema.sql synced; ai-coach redeployed. 7-lens adversarial review done; all 7
confirmed findings fixed. Supersedes the brief's two-row direction after a 7-area touchpoint map.

## 1. What it is

One working set = a LEFT effort + a RIGHT effort, logged back-to-back, counting as **one** set.
Weight is shared (same dumbbell); reps and RPE may differ per side (the asymmetry signal).
Optional, off-by-default short rest between the two sides.

## 2. Decision & rationale (the data-model fork)

Chosen: **one `workout_sets` row + an orthogonal `is_unilateral boolean` flag + `reps_right` +
`rpe_right`; `weight_kg` shared.** Unilateral is NOT a `set_type` value — it is a second,
independent dimension, so a set can be `failure` AND unilateral, `warmup` AND unilateral, etc.

Why one-row (vs two-row side+group_id):
- The app rests on the invariant **1 row = 1 set = 1 ordinal**: set counts (`completedSets`,
  finish-gate, XP `setCount`, guest synthetic ids), working-number walk (`countsAsWorkingSet`/
  `_workN`), history (1 row → 1 pill), coach (`workingSets`/`nextSetNumber`/review totals),
  prefill (index-by-`doneCount`), delete (1 row → 1 logical set). One-row keeps ALL of these
  correct with no change. Two-row breaks every one of them and needs pair-collapsing (~8 surfaces
  per area).
- The two-row rationale was "a grouping primitive shared with Phase D supersets," but supersets
  group EXERCISES (different `exercise_id`s, interleaved) — a routine/exercise-level grouping, not
  a per-set `set_group_id`. So the shared-primitive benefit is illusory; one-row does not foreclose
  a proper superset grouping later.

Why an orthogonal flag (vs `set_type='unilateral'`):
- User wants unilateral combinable with warmup/failure ("better"), which a mutually-exclusive
  `set_type` value cannot do.

Why the toggle lives in the existing SetTypeSheet (vs a new row control):
- User: "a control in the logging screen is a very big price." The SET badge on every row already
  opens SetTypeSheet; housing an orthogonal switch there adds the dimension with no new row-level UI.

Known v1 limitations (acceptable, documented):
- Weight is shared per side (no `weight_kg_right`). Matches the locked "same dumbbell" design;
  trivial future column if asymmetric loading is ever needed.
- Historical per-side prefill is not added in v1: the right side prefills from the just-logged
  LEFT side in-session (weight shared, reps seeded from left), not from a prior session's right.
  `previousSets` stays `{weight_kg, reps}[]`.

## 3. Migration 0056 (Supabase MCP `apply_migration`, then mirror to supabase/migrations/ + schema.sql)

```sql
-- 0056_workout_sets_unilateral.sql
alter table public.workout_sets
  add column if not exists is_unilateral boolean not null default false,
  add column if not exists reps_right numeric,
  add column if not exists rpe_right numeric;

alter table public.workout_sets
  add constraint workout_sets_rpe_right_check
  check (rpe_right is null or (rpe_right >= 1.0 and rpe_right <= 10.0));
```

`recompute_user_volume_stat` — volume sum adds the right side; `count(*)` UNCHANGED (still 1/set):
```sql
select coalesce(sum(
  s.weight_kg * s.reps
  + case when s.is_unilateral then s.weight_kg * coalesce(s.reps_right, 0) else 0 end
), 0)::numeric(12,2), count(*)::integer
into v_volume, v_count
from workout_sets s join workouts w on w.id=s.workout_id join exercises e on e.id=s.exercise_id
where ... (rest identical: muscle_group, week, completed, set_type distinct from 'warmup', user_id not null)
```

`recompute_user_lift_stat` — expand each unilateral set to two e1rm candidates (faithful copy
otherwise); existing data (is_unilateral=false) behaves identically:
```sql
with expanded as (
  select s.weight_kg, w.started_at, s."order" as set_order, sd.r as reps
  from workout_sets s join workouts w on w.id = s.workout_id
  cross join lateral (values
    (greatest(s.reps, 1)),
    (case when s.is_unilateral then greatest(coalesce(s.reps_right, s.reps), 1) end)
  ) as sd(r)
  where w.user_id = p_user_id and s.exercise_id = p_exercise_id
    and s.completed = true and s.weight_kg > 0
    and s.set_type is distinct from 'warmup' and w.user_id is not null
    and sd.r is not null
), cs as (
  select weight_kg, reps, started_at, set_order,
    least(weight_kg*(1.0+reps/30.0), weight_kg*36.0/(37.0-least(reps,36)))::numeric(10,2) as e1rm
  from expanded
)
select max(e1rm),
  (array_agg(weight_kg order by e1rm desc))[1], (array_agg(reps order by e1rm desc))[1],
  (array_agg(weight_kg order by started_at desc, set_order desc))[1],
  (array_agg(reps order by started_at desc, set_order desc))[1],
  max(started_at),
  count(distinct date_trunc('day', started_at)) filter (where started_at >= now() - interval '28 days')
  into v_e1rm, v_top_weight, v_top_reps, v_last_weight, v_last_reps, v_last_at, v_sessions_28d
from cs;
```
(The 1RM metric-type gate and all inserts/deletes stay byte-for-byte as today.)

`set_type` CHECK is untouched (left/right stay valid for old data). No coach RPC change needed for
counting, but `coach_get_*` payloads should surface the new columns — see §9.

## 4. Type changes (lib/types.ts + the sync/edit interfaces)

Add to the 5 set shapes (all fields OPTIONAL/forward-safe):
- `WorkoutSet` (lib/types.ts:68-86): `is_unilateral?: boolean; reps_right?: number | null; rpe_right?: number | null;`
- `ActiveSet` (lib/types.ts:118-130): same three.
- `PendingSet` (lib/syncQueue.ts:22-33): same three.
- `PendingEditSet` (lib/editQueue.ts:24-35): same three.
- `GuestWorkoutExercise.sets` (lib/guestStore.ts:50): same three (set_type typed `string` there).

SetType union (lib/types.ts:5): UNCHANGED. We do not add 'unilateral'.

## 5. Shared volume helper (kills the 3-places drift risk)

New `lib/sets.ts` (or add to lib/format.ts):
```ts
export function setVolumeKg(s: { weight_kg: number; reps: number; set_type?: string;
  is_unilateral?: boolean; reps_right?: number | null }): number {
  if (s.set_type === 'warmup') return 0;
  const right = s.is_unilateral ? s.weight_kg * (s.reps_right ?? 0) : 0;
  return s.weight_kg * s.reps + right;
}
```
Use it in ALL volume reduces:
- live memo app/workout/[id].tsx:1533-1535
- confirmFinish vol app/workout/[id].tsx:1368-1372
- per-exercise "Done" summary app/workout/[id].tsx:2032 (also fixes its pre-existing warmup bug)
- edit newVolume app/workout/edit/[id].tsx:367-374
- coach review volume lib/workoutCoach.ts:283-289 (uses weightKg/repsRight equivalents)
(Counting surfaces stay as-is — one row, one set.)

## 6. Logger UX & state machine (app/workout/[id].tsx)

Pending-set state additions (near 127-150):
- `sideEntering: 'left' | 'right'` (default 'left'; only meaningful when active set is unilateral).
- `pendingLeft: { reps: number; rpe: number | null } | null` — the half-committed left effort.
- `activeUnilateral: boolean` — mirrors the toggle for the active (not-yet-logged) set.

SetTypeSheet (opened by the SET badge, idx=-1 for active): add an orthogonal toggle
"One side at a time" / subtitle "Log left then right as one set (L+R)". For the active set it sets
`activeUnilateral`; for a done set idx>=0 it patches `is_unilateral` on that row. Independent of the
type list. (See §11 for removing left/right rows.)

Capture flow when `activeUnilateral` (handleLogSet, 671-746):
1. SET cell shows a small "L | R" phase indicator (which side you're entering). Weight cell shared.
2. `sideEntering==='left'`, tap ✓ → store `pendingLeft = { reps, rpe }`, flip `sideEntering='right'`,
   prefill the reps cell from left's reps (weight already shared), clear/copy rpe; do NOT write to
   sets yet. If `prefs.restBetweenSides` → `startRestTimer()` here (the optional inter-side rest).
3. `sideEntering==='right'`, tap ✓ → assemble ONE ActiveSet:
   `{ ...axes, weight_kg, reps: pendingLeft.reps, reps_right: rightReps, rpe: pendingLeft.rpe,
      rpe_right: rightRpe, is_unilateral: true, set_type: activeSetType, completed: true }`,
   write via updateExercises (the existing "replace first incomplete else append" path stays — still
   ONE slot), clear `pendingLeft`, reset `sideEntering='left'`, `startRestTimer()` (normal rest).
4. Toggling unilateral OFF mid-capture, deleting, switching exercise, or finishing → clear
   `pendingLeft` + reset `sideEntering` (add to the existing reset/cleanup points: 739-745,
   exercise-change effect 630-650, handleDeleteSet, discardAndSwitch).

Badge: the SET badge keeps showing the set_type (number / letter / num·letter) UNCHANGED. Unilateral
is conveyed by (a) the active-row "L|R" phase indicator while capturing, and (b) the value rendering
"60kg · L8/R7" on the done row — NOT by cluttering the badge. (Optional: a hairline "⇄"/"L+R" glyph
appended to the done-row value; keep subtle.)

countsAsWorkingSet / `_workN` / completedSets / finish-gate / delete: NO CHANGE (one row).

## 7. Active-row & "Last time" rendering

- Active row: when unilateral, the reps cell label/area shows the current side; after the left ✓ the
  value prefills from left. RPE cell binds to left then right (same RpePickerSheet, second invocation
  bound to the right value — no sheet change).
- "Last time" text (1992-2002): unchanged (uses previousSets weight/reps); the right side has no
  historical source in v1.

## 8. Persistence / sync (insert maps + overlays + guest)

Add `is_unilateral`, `reps_right`, `rpe_right` to EVERY per-set map (default false/null):
- Construction: app/workout/[id].tsx signed-in PendingSet 1464-1476; guest mirror 1413-1426.
- Inserts (server writes): lib/syncQueue.ts:287-302; lib/editQueue.ts:326-341.
- Read overlays: lib/pendingAdapters.ts:38-51 and :92-96; lib/editQueue.ts:211-220 and :252-261.
- Guest detailed expand: lib/guestStore.ts:189-218.
Set-count helpers (pendingSetCount, XP setCount reduce, exactly-once guard) UNCHANGED — one
PendingSet per logical set.

## 9. History + Coach

History (app/(app)/history.tsx):
- `.select(...)` at :683 add `is_unilateral, reps_right, rpe_right`.
- fetchWorkouts transform :693-699 carry them; HistorySet type :55 add them.
- `historySetLabel` :60-73: when `is_unilateral`, render the reps axis as `L{reps}/R{reps_right}`
  (weight/other axes shared). `@rpe` :559-561: when unilateral + rpe_right, show `@L8/R7` (or `@8/7`).
- `historyBest` :76-88: include `reps_right` in the reps-max case; weight/distance maxima already fine.

Coach (lib/workoutCoach.ts):
- WorkoutCoachSet :20-30 add `repsRight: number|null; rpeRight: number|null; isUnilateral: boolean`.
  Built at :140-150 from the row.
- `setCore` :94-106: when unilateral, render both sides, e.g. `60kg×8/7` (and per metric type).
- `setSuffix` :109-114: push `unilateral` tag; RPE tag becomes `RPE 8/7` when rpeRight present.
- `workingSets`/`nextSetNumber`/review `totalSets` :78-80,177,283 UNCHANGED (one set). Review
  `volume` :285 must add the right side (use setVolumeKg-equivalent on weightKg/reps/repsRight).
- Opener reading-guide :246,260: add one clause — "A unilateral set logs both sides as one set
  (L/R); its volume counts both."

prompt.ts (supabase/functions/ai-coach/prompt.ts) — REDEPLOY ai-coach after:
- DATA_SCHEMA :82 append `is_unilateral boolean, reps_right numeric, rpe_right numeric`.
- :91: rewrite the now-stale "left/right are the two sides of a single-limb set" line to:
  "workout_sets.is_unilateral=true means one set trained one side at a time; reps_right/rpe_right hold
  the right side, weight_kg is shared, and volume counts both sides. (Legacy left/right set_type values
  may exist on old rows.)"
- coach_get_* RPCs already `select *`/return row data; if they enumerate columns, add the three.
  Verify coach_get_exercise_history / coach_get_workout_detail return them (migration 0055 recreated
  them) — if column-enumerated, bump in 0056.

## 10. Preferences (hooks/usePreferences.tsx + WorkoutSettingsSheet.tsx)

- Add `restBetweenSides: boolean` (default `false`) to WorkoutPreferences (14-26) + DEFAULT (28-33).
  Forward-safe via the spread-merge at :66.
- Inter-side rest target: reuse `currentEx.restSeconds` is too long. Default a short fixed target.
  Add `restBetweenSidesSeconds: number` (default 20) OR derive `min(restSeconds, 20)`. Decision:
  fixed 20s default, no extra UI choice in v1 (keep the sheet lean). Feed THIS target into the
  rest-done haptic (561-565) and pulse (576-578) for the inter-side phase via a `restTargetOverride`.
- WorkoutSettingsSheet: a ToggleRow "Rest between sides" / "A short breather between L and R on
  unilateral sets" under the "During workout" section (after the stopwatch row ~:91), copying the
  84-91 pattern. No dependent ChoiceRow in v1.

## 11. Retire left/right from the picker

- Remove `left`/`right` from `SET_TYPE_ORDER` (SetTypeBadge.tsx:33) so they no longer appear in the
  SetTypeSheet for NEW logging. KEEP their `SET_TYPE_META` entries (28-29) + the SetType union values
  so old rows still render their L/R tile, and `setTypeOf` still resolves them.
- The unilateral toggle replaces them.

## 12. Edge cases

- Toggle unilateral on AFTER entering left but before logging: start capture at left (no half-state lost).
- Toggle off mid-capture: discard pendingLeft, revert to a normal single-effort set.
- Done unilateral set: badge tap shows type + unilateral state; editing reps not supported in-logger
  today (delete + re-log) — unchanged.
- Non-weight metric types (bodyweight_reps etc.): unilateral composes (reps_right holds the right
  side; weight 0). Duration/distance unilateral is out-of-scope rare; allow but only reps_right/rpe_right
  carry the asymmetry (duration_right etc. NOT added in v1).
- Edit screen: EditSet add `reps_right`, `rpe_right`, `is_unilateral`; mkSet (5 call sites) thread
  them; handleSave emit them; a unilateral row in the editor renders a second reps input + reuses the
  set_type/unilateral via... NOTE: the editor currently has NO set_type/rpe UI at all (silently
  round-tripped). v1: round-trip is_unilateral/reps_right/rpe_right silently too (preserve on edit),
  and DEFER an explicit unilateral editor control. The values persist; only in-logger creates them.

## 13. Build order (serial — shared files, do NOT parallelize edits)

1. Migration 0056 live (MCP) + mirror file + schema.sql.
2. recompute fns live (MCP) + mirror + schema.sql.
3. lib/types.ts + lib/sets.ts (setVolumeKg) + the 4 other interfaces.
4. SetTypeBadge.tsx (SET_TYPE_ORDER trim) + SetTypeSheet.tsx (orthogonal toggle).
5. usePreferences + WorkoutSettingsSheet (restBetweenSides).
6. Logger app/workout/[id].tsx (capture state machine, volume helper, inter-side rest, serialization).
7. Persistence: syncQueue, editQueue, pendingAdapters, guestStore.
8. Edit screen (silent round-trip).
9. History rendering.
10. Coach lib/workoutCoach.ts + prompt.ts; redeploy ai-coach.
11. `npx tsc --noEmit` clean.
12. Adversarial review Workflow (multi-lens skeptics over the diff) → fix real findings.
13. iOS sim smoke (LANG=en_US.UTF-8) — log a unilateral set, verify count=1, volume=both sides.

## 14. Verification

- One-row invariant: a unilateral set increments set count by 1, working ordinal by 1.
- Volume: live == persisted == server recompute == both sides. (Guard: shared setVolumeKg helper.)
- Warmup-unilateral excluded from volume/1RM (orthogonality + warmup gate).
- Old data unaffected (is_unilateral default false → identical recompute output).
- Coach recap reads a unilateral set as ONE set with both sides.
