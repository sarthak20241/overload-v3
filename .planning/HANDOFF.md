# HANDOFF — Overload, branch feat/exercise-set-types (PR #43)

Last updated 2026-06-29. Read this + the memory files first. A fresh chat can pick up from here.

## Where we are

Worktree `/Users/sarthakkumar/Coding/overload-v3` is EXCLUSIVELY on `feat/exercise-set-types` (PR
#43 → main, OPEN, do NOT merge — all workstreams merge at once later). The holistic branch is parked
at ../overload-holistic; never switch this folder's branch.

Features shipped this run, all on PR #43 (all COMMITTED + PUSHED):
1. **Unilateral "L+R" set type** + per-side weight + swappable first side (e1f1477..748ef26). One-row
   model: `is_unilateral` flag + `reps_right`/`rpe_right`/`weight_kg_right`.
2. **Routines fix** (Android IME lift + rep-range dual input) (bc6263c).
3. **Supersets (Phase D)** (6 scoped commits 750ac68..653d45e): per-row `superset_group` column;
   interleaved logging (pager auto-advance UX); routine-editor grouping; coach recap awareness.
   Reviewed (5 findings fixed), coach redeployed.
4. **Metric-type read surfaces (board theme B.1)** (8a19f78..238c93f): new shared `lib/setDisplay.ts`
   makes bodyweight/duration/distance work first-class on the dashboard, analytics (chart + PR card),
   coach, and the offline adapter. Adversarially reviewed (15 agents, parity-verified); 3 confirmed
   edge-fixes applied (volume-chart k-abbreviation, pending-adapter `metric_type`, per-series unit
   pinning so a shadowed duplicate name can't mix kg with seconds/metres).

DB: migrations 0056-0060 ALL applied live (Supabase MCP) + mirrored to supabase/migrations/ + schema.sql
synced. ai-coach edge fn redeployed (prompt.ts current). Project ref: rjmmslierxhvwdjgjilb.

## Key artifacts (read these)
- Memory: project_exercise_set_types.md (L+R full state), project_supersets.md (supersets state).
- Specs: .planning/lr-unilateral-spec.md, .planning/supersets-spec.md.
- **Board: .planning/ux-bug-board.md** — 22 verified bugs + 32 UX improvements across the workout
  experience (the prioritized analysis below references it).

## Remaining tasks (prioritized)

A. ~~Commit supersets to PR #43~~ DONE 2026-06-29 (6 scoped commits 750ac68..653d45e, pushed). Remaining
   untracked = unrelated junk (__pycache__, downloads/, flat_*.py, sketches/, store-assets/,
   .planning/p2-review.workflow.js) — do NOT commit those.

B. **Board fixes** (from .planning/ux-bug-board.md), highest-leverage first:
   1. ~~THEME: non-weight metric types second-class on read/stats surfaces~~ DONE 2026-06-29
      (commits 8a19f78..238c93f, lib/setDisplay.ts). Reviewed; one known LOW left as pre-existing/out of
      scope: guest workouts never flag PRs because getGuestWorkoutsDetailed assigns a per-workout
      synthetic exercise_id (`${w.id}-ex-${ei}`) so best[exId] never accumulates across guest sessions —
      fix by deriving a stable id from the exercise name/library id (lib/guestStore.ts).
   2. Data-integrity HIGHs: (a) editing a unilateral set in app/workout/edit/[id].tsx corrupts the right
      side (edits left, keeps stale right, no badge) → render L/R inputs OR keep sides in sync + show a
      badge; (b) superset "tap to split" on a 3+ giant set EJECTS a member instead of splitting (routines
      toggleSupersetLink — cut the contiguous run at i, don't null one row); (c) per-exercise notes typed
      mid-workout are discarded on save (confirmFinish + PendingExercise has no notes field).
   3. Supersets invisible on read-back/preview: RoutineDetailSheet + card drop grouping; history bracket
      deferred (data flows via superset_group now). Render the grouping.
   4. Resume drops mid-unilateral/mid-superset capture (cross-cutting) + duration stopwatch lost on
      background. 5. Core-loop UX: log toast/undo, set-type discoverability, superset auto-hop "next: X"
      cue, rest-over sound/notification, unsaved-changes guard on routine editor + coach output.

C. NOTE: "steppers hidden until you tap the number" is INTENTIONAL — do not re-flag / do not change.

## Guardrails (verify, don't assume)
- `git branch --show-current` must be feat/exercise-set-types. Don't switch this worktree's branch.
- Supabase changes via MCP only (apply_migration / execute_sql), never `db push`. Next migration = 0061.
- Edge deploy: `supabase functions deploy ai-coach` (verify_jwt stays false via config.toml).
- iOS sim build: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx expo run:ios` (RN 0.81.5 + CocoaPods/Ruby4
  locale bug). Dev server already running on 192.168.29.237:8081 (Metro, serves this worktree).
- Type check: `npx tsc --noEmit 2>&1 | grep -v -E "^admin/|^supabase/functions/"` (admin/ + Deno
  functions have pre-existing unrelated errors; ignore them).
- Edit hook requires reading a file before editing it.
- Big multi-agent reviews can hit transient API rate-limits/401s — wait ~2min and re-run if so.

## On-device status
User is testing L+R + supersets on an Android dev build (same wifi, http://192.168.29.237:8081). No
device results reported back yet.
