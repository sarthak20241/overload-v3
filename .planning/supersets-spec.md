# SPEC — Supersets (Phase D)

Status: BUILT + REVIEWED 2026-06-29 (UX = A, pager auto-advance; type-clean, not committed). Branch
`feat/exercise-set-types` (PR #43). Migration 0060 applied live + mirrored + schema.sql. ai-coach redeployed.
5-lens review done; 5 confirmed findings fixed (history bracket deferred). Based on a 6-area touchpoint map.

## 1. What it is

A superset groups 2+ exercises performed back-to-back with NO rest between members, resting only
after completing one ROUND of every member. E.g. {Bench, Row}: Bench s1 → Row s1 → REST → Bench s2
→ Row s2 → REST. Pairs and giant sets (3+) supported. A set is still ONE row in ONE exercise; only
logging ORDER and REST timing change.

## 2. Decision: data model = per-row COLUMN (locked — unanimous across all 6 areas)

- `routine_exercises.superset_group int NULL` (NULL = solo). Members of a routine superset share a value.
- `workout_sets.superset_group int NULL` — per-set, so the grouping persists into history (mirrors the
  is_unilateral per-set decision; there is no workout_exercises table, exercises are derived from sets).
- `ActiveWorkoutExercise.supersetGroup: number | null` (in-memory) — rides routine→active→snapshot for free.
- A new `supersets` table is rejected: grouping is per-row + contiguous, no group-level attributes exist
  (label / group rest / rounds) to justify an entity. A column threads through the existing 1:1 shapes.
- Group KEY, not positional refs. Members must stay CONTIGUOUS in the exercises array (order = index);
  normalize after any reorder so a group's rows form one run.

## 3. Round-detection algorithm (the heart of the interleave)

For a group G with ordered members m1..mk (array order), `done(m)` = completed sets of m, `target(m)` =
its targetSets. A member with `done(m) >= target(m)` is OUT of the rotation.
- **Next member to log** = the in-rotation member with the FEWEST done sets, ties broken by group order.
- **After committing member M's set** (M now has `done(M)`):
  - If some in-rotation member has `done < done(M)` (behind in this round) → `setCurrentIdx(thatMember)`,
    NO rest (advance only). Between-member transition.
  - Else (round complete / all level) → `startRestTimer()` (normal rest, round-end). The next set the user
    logs is the next round's first member (a pager advance happens then).
  - If ALL members are now OUT → the group is done; behave like finishing (advance to next non-group exercise).
- Round-end rest target = the just-logged member's `restSeconds` (what restTarget already reads). No pinning
  needed because round-end rest is a NORMAL rest fired while we STAY on the last member (no index change).
- Unequal target sets handled for free (a finished member is skipped; the round just has fewer members).

## 4. Logger changes (app/workout/[id].tsx) — the crux

- handleLogSet tail (the unconditional `startRestTimer()` ~L796): replace with the round-detection branch
  above, computed from the freshly-`updated` array (avoid stale state, like handleFinishExercise L827-828).
  Skip the "advance input to next set's prev" block when advancing to a different member — the
  index-change effect (~L630-650) already prefills the new exercise.
- The unilateral early-return (L744-751) is the existing template for "commit, advance, optional rest, return."
  The superset branch is orthogonal to unilateral (a unilateral set inside a superset = one row, then the
  superset advance fires after the WHOLE unilateral set commits — i.e. only on the second-side commit).
- handleStartExercise (~L685-694): starting any member starts ALL members of the group together (you can't
  start one side of a back-to-back superset).
- handleFinishExercise auto-advance (~L824-831): make the `i>currentIdx && !f` scan group-aware so it never
  leaves a group mid-round and advances by group-member order.
- The index-change reset effect (~L560-582): it resets set-type/rpe/unilateral + tears down OVERRIDE rest on
  every index change. Between-member advance is fine to reset set-type/rpe (different exercise) and starts NO
  override rest, so no special guard needed — BUT do not let it stop the round-end normal rest (it only stops
  override rests, so safe). Verify in review.
- Snapshot: supersetGroup rides on ActiveWorkoutExercise (serialized free). The per-group "round" is DERIVED
  from per-set completion counts (no new snapshot field, no SCHEMA_VERSION bump). Keep it derived.
- Pager + pill strip (~L1695-1732, L2245-2313): keep members CONTIGUOUS so adjacent-index swipe still lands on
  a member; add a visual group bracket/label + a "next: <member>" cue. (UX shape = §7 decision.)

## 5. Routine editor (app/(app)/routines.tsx + lib/routineQueue.ts + guestStore + types)

- Add `supersetGroup?: number | null` to EditorExercise, RoutineExercise, PendingRoutineExercise,
  GuestRoutineExercise, and the duplicated *Raw interfaces (routines.tsx + RoutineDetailSheet). (Same
  "duplicated-shapes" risk that bit `note`.)
- "Group as superset" affordance: a control on/between ExerciseEditorCard(s) to link a row with the one
  above into a group (or a "link" toggle between adjacent cards). Assign a new group id to the contiguous run.
- After any reorder (onReorder splice ~L941-943): NORMALIZE — collapse each group's rows to be contiguous
  (or drop a row out of its group if a non-member is dragged into the run). Keep it simple: a row dragged out
  of its run leaves the group (group=null) rather than fragmenting it.
- Save (routines.tsx:781-801 signed-in + 722-743 guest): emit `superset_group: ex.supersetGroup ?? null`.
- Persist: routineQueue.ts insert (255-264) + optimistic cache row (127-160); load mapRow (663-677). select is
  `*` so no select change. Secondary writers (AICoachModal, workout/[id].tsx) pass null (AI emit = DEFERRED).
- Render a bracket in RoutineDetailSheet + a "superset" hint on the collapsed RoutineCard (so a superset
  routine doesn't look identical to a flat one).

## 6. Persistence + presentation

- workout_sets.superset_group threaded like is_unilateral: confirmFinish (signed-in PendingSet + guest mirror),
  syncQueue + editQueue inserts, the 6 overlay/expand maps, edit screen (EditSet + mkSet + toQueueExercises +
  cleaned + select), history select + transform. Guest: per-exercise on GuestWorkoutExercise.
- History SessionCard: wrap members sharing a non-null group in a bracket/"Superset" chip (additive). Group
  key carried on ExerciseDetail; the existing first-seen exercise_id order keeps members adjacent for v1.
- Coach (lib/workoutCoach.ts): REQUIRED fix — the per-exercise "rest Xs" recap line is misleading for superset
  members; tag grouped exercises (e.g. "[Superset A]") and adjust the rest wording (rest after the round).
  Add a one-line reading-guide clause. prompt.ts DATA_SCHEMA: document workout_sets.superset_group +
  routine_exercises.superset_group so coach_query_sql isn't blind.
- Analytics: NO change — every aggregate is grouping/order-independent (confirmed).

## 7. OPEN DECISION — active-workout UX shape (the one genuine fork)

How does the logger present a superset round? (Behavior — interleave + rest-after-round — is the same in all.)
- (A) Pager auto-advance: keep one-exercise-per-page; after a set, auto-hop to the next member; rest after the
  round. A "Superset A · next: Row" cue + a colored bracket on the pill strip. Lowest risk (reuses the pager).
- (B) Stacked round view: render the group's members together on one page (see the whole round at once). Best
  mental model; a significant pager rewrite (higher risk/effort).
- (C) Visual grouping, free order: show members bracketed, let the user log in any order, rest auto-fires when
  a round completes. Least guided; closest to Hevy/Strong; lowest logic risk but least "coached."

Recommendation: (A) for v1 — delivers the guided interleave + round rest with the least structural risk;
(B) is a strong future polish once (A) ships. Locked once the user picks.

## 8. Scope

v1 MUST: DB cols; routine-editor grouping + bracket; active-workout interleave + round rest (the §7 shape);
persistence of workout_sets.superset_group; coach rest-wording fix. v1 SHOULD (if cheap): history bracket;
ad-hoc supersets (group exercises in a blank workout / mid-session — needs the group key mutable in-session).
DEFER: AI emitting supersets (generate_workout/plan tool schema — "coach-later"); analytics superset metrics;
true round-by-round per-set storage order (per-exercise order + group key is enough for v1).

## 9. Build order (serial)

1. Migration 0060 (cols) + mirror + schema.sql. 2. types + the 5 routine shapes + the active-set/persistence
shapes. 3. Routine editor grouping UI + save/load. 4. Active-workout: supersetGroup carry + interleave +
round rest (§7 shape). 5. Persistence threading (workout_sets.superset_group). 6. History bracket + coach
fix + prompt.ts; redeploy ai-coach. 7. tsc. 8. Adversarial review (logger-state + persistence + regression).
9. iOS smoke.
