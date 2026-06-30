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
      (commits 8a19f78..238c93f, lib/setDisplay.ts). Reviewed. The follow-up guest-PR LOW (guests never
      flagged PRs because of a per-workout synthetic exercise_id) is now ALSO fixed (commit 63e5d2f,
      stable synthetic id in lib/guestStore.ts).
   2. ~~Data-integrity HIGHs~~ DONE 2026-06-29 (commits b94ac85, 9a60e46, 1c01e53; reviewed, 2 edge-fixes
      applied). (a) unilateral edit now renders editable L/R inputs + "L+R" badge (right side no longer
      silently desyncs); (b) superset split cuts the contiguous run instead of ejecting a member;
      (c) per-exercise notes folded into the workout note on finish (no data loss).
      DEFERRED follow-up: a dedicated per-exercise notes column (workout_sets.notes) so notes read back
      under each exercise in history/edit instead of mashed into the workout note — a migration-scale
      mini-feature, not a bug.
   3. ~~Supersets invisible on read-back/preview~~ DONE 2026-06-29 (commit a062098). RoutineDetailSheet
      "SUPERSET" caption + lime left-accent bracket; RoutineCard "· N superset(s)" hint; history expanded
      card same caption + accent (group read exercise-level for guest, per-set for signed-in). Reviewed.
   4. ~~Resume drops mid-unilateral capture + duration stopwatch lost on kill~~ DONE 2026-06-29
      (commit 4444b3c). Snapshot gained an optional `capture` field (pendingFirst + stopwatch); the screen
      mirrors it into a captureRef (read by buildSnapshot + a debounced safety save) and restores it on
      both resume paths via resumePendingRef + a dedicated effect that wins over the index-reset.
      Reviewed twice (the 2nd re-review hit a session limit; verified by manual trace instead). Mid-
      SUPERSET resume needs no extra state — the round is derived from per-set completion counts.
      Known narrow edge (pre-existing, accepted): committing a 2nd side then minimizing within ~800ms and
      re-entering could transiently re-show the half-set; fresh saves + the savedAt one-shot make it rare.
   5. Core-loop UX (LAST board theme, mostly subjective polish — get the user's prioritization): log
      toast/undo, set-type discoverability, superset auto-hop "next: X" cue, rest-over sound/notification,
      unsaved-changes guard on routine editor + coach output.

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
