# HANDOFF — Overload, branch feat/exercise-set-types (PR #43)

Last updated 2026-06-29. Read this + the memory files first. A fresh chat can pick up from here.

## Where we are

Worktree `/Users/sarthakkumar/Coding/overload-v3` is EXCLUSIVELY on `feat/exercise-set-types` (PR
#43 → main, OPEN, do NOT merge — all workstreams merge at once later). The holistic branch is parked
at ../overload-holistic; never switch this folder's branch.

Three features shipped this run, all on PR #43:
1. **Unilateral "L+R" set type** + per-side weight + swappable first side. COMMITTED + PUSHED (commits
   e1f1477..748ef26). One-row model: `is_unilateral` flag + `reps_right`/`rpe_right`/`weight_kg_right`.
2. **Routines fix** (Android IME lift + rep-range dual input). COMMITTED + PUSHED (bc6263c).
3. **Supersets (Phase D)**: BUILT + reviewed (5 findings fixed) + type-clean + coach redeployed, but
   **NOT COMMITTED** — lives on the working tree. Per-row `superset_group` column; interleaved logging
   (pager auto-advance UX); routine-editor grouping; coach recap awareness.

DB: migrations 0056-0060 ALL applied live (Supabase MCP) + mirrored to supabase/migrations/ + schema.sql
synced. ai-coach edge fn redeployed (prompt.ts current). Project ref: rjmmslierxhvwdjgjilb.

## Key artifacts (read these)
- Memory: project_exercise_set_types.md (L+R full state), project_supersets.md (supersets state).
- Specs: .planning/lr-unilateral-spec.md, .planning/supersets-spec.md.
- **Board: .planning/ux-bug-board.md** — 22 verified bugs + 32 UX improvements across the workout
  experience (the prioritized analysis below references it).

## Remaining tasks (prioritized)

A. **Commit supersets to PR #43** (scoped commits, like L+R: db / model+threading / logger interleave /
   editor grouping / coach). Working tree has the supersets diff (uncommitted). The 2 once-stray files
   (routines.tsx, useKeyboardAwareScroll.ts) are ALREADY committed; remaining untracked = unrelated junk
   (__pycache__, downloads/, flat_*.py, sketches/, store-assets/, .planning/p2-review.workflow.js) — do
   NOT commit those.

B. **Board fixes** (from .planning/ux-bug-board.md), highest-leverage first:
   1. THEME: non-weight metric types are second-class on read/stats surfaces (~5 bugs). Analytics PR
      card + progress chart show "PR: 0kg"/flat; dashboard expanded sets read "0 reps"; coach review
      volume = 0kg for non-weight; PR badges never fire for bodyweight/duration/distance. Fix once with a
      shared "primary metric value/volume" helper used across index.tsx, analytics.tsx, workoutCoach.ts.
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
