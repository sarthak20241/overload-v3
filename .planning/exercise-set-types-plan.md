# Exercise Types & Set Types — Plan

Tester-requested features: (1) per-exercise measurement type (not everything is weight+reps),
(2) per-set type (warmup, drop, failure, etc.) + optional RPE/RIR. Design principle (from Hevy/Lyfta):
**complexity stays hidden until the user opts into it.** The default logging table must look exactly
like it does today.

## Locked decisions (2026-06-17)

- **Metric-type breadth:** all 8 Hevy types in v1.
- **Supersets:** deferred to their own milestone (needs an exercise-grouping concept we don't have).
- **Coach (Drona) awareness:** ship logging + schema first; serialize the new fields into the coach
  in a follow-up phase.
- RPE stored as a single `rpe` column; RIR is a display transform (`rir = 10 - rpe`).
- **Preferences foundation:** build a thin local-first `usePreferences` store + Settings screen
  shell NOW (the workout screen already has a "Settings" button). RPE/RIR becomes a **global**
  setting (not a per-exercise menu). Every other workout-setting toggle is architected as a cheap
  drop-in, not built now.
- **Save Workout screen:** scoped (title, notes, editable date/time, summary), **social-ready** —
  leave clean component hooks for photo + visibility but don't build upload/sharing or migrate the
  schema for it now.
- **Icons:** use `@expo/vector-icons` (already a dep) — `MaterialCommunityIcons` for fitness glyphs
  (dumbbell, run, timer-sand, walk, arm-flex), Feather for generic, FontAwesome5 brands for music.
  Custom branded set is a later polish pass (Figma MCP available). Set types stay W/D/F letter badges.

---

## Feature spec

### A. Exercise measurement type (property of the exercise, set once)

`exercises.metric_type` enum — default `weight_reps` so normal lifters never see it.

| value                  | label (UI)            | log columns      | volume / 1RM                          | library examples                  |
|------------------------|-----------------------|------------------|---------------------------------------|-----------------------------------|
| `weight_reps`          | Weight & Reps         | Kg · Reps        | vol = wt×reps; 1RM yes                 | Bench, Curls                      |
| `bodyweight_reps`      | Bodyweight Reps       | Reps             | vol = bodyweight×reps; no rep-1RM      | Pull-ups, Push-ups, Sit-ups       |
| `weighted_bodyweight`  | Weighted Bodyweight   | +Kg · Reps       | vol = (bw+added)×reps; 1RM optional    | Weighted Pull-up/Dip              |
| `assisted_bodyweight`  | Assisted Bodyweight   | −Kg · Reps       | vol = (bw−assist)×reps; 1RM optional   | Assisted Pull-up/Dip             |
| `duration`             | Duration              | Time             | track best/total time                 | Plank, Yoga, Stretching           |
| `duration_weight`      | Duration & Weight     | Kg · Time        | track wt×time; no rep-1RM              | Weighted Plank, Wall Sit          |
| `distance_duration`    | Distance & Duration   | Time · Km        | track distance, time, pace            | Running, Cycling, Rowing          |
| `weight_distance`      | Weight & Distance     | Kg · Km          | track load-carry; no rep-1RM          | Farmers Walk, Suitcase Carry      |

- **Where it surfaces:** only in *Create custom exercise* (a "Type" row → "Select Exercise Type"
  screen) and *Edit custom exercise*. The 47 library exercises ship pre-typed in `lib/exercises.ts`.
- **At log time:** the set row reads `exercise.metric_type` and renders the right inputs. No extra taps.
- Inputs: Time = compact `mm:ss` stepper; Km = decimal-pad numeric; +Kg/−Kg reuse the weight field
  with a sign label; sign is interpreted by `metric_type`, value stored as magnitude.

### B. Set type (property of a single set) + RPE

`workout_sets.set_type` enum — default `normal`. Tapping the SET-number cell opens the **Set Type**
bottom sheet (Portal pattern).

- **Common tier:** Normal (number), Warm up (W, amber), Drop set (D, blue), Failure (F, red).
- **More:** Negative (N), Left (L, green), Right (R, purple), [Rest-pause, Partial, AMRAP — optional].
- **Remove set** (destructive) lives in the same sheet.
- Each option has a `?` → one-line, coach-voiced explainer.
- Picking a type swaps the number for a colored letter badge; "Normal" restores the number.

**RPE/RIR:** hidden by default. Exercise `⋮` menu → "Track RPE" reveals the RPE column; per-set cell
opens a 1–10 (.5 step) quick picker. Display preference RPE vs RIR (`10 − rpe`).

**Stats semantics (required even in logging-first):**
- `warmup` sets excluded from working volume, 1RM, and PR detection.
- 1RM estimation gated to `metric_type IN (weight_reps, weighted_bodyweight, assisted_bodyweight)`
  so wall-sits / carries / planks never generate a phantom 1RM.
- Other set types counted in volume; `left`/`right` count each side as logged.

---

## Data model

`supabase/migrations/0043_exercise_metric_type.sql`
- `alter table exercises add column if not exists metric_type text not null default 'weight_reps';`
- `check (metric_type in (...8 values...))`
- Backfill any existing duration/cardio/bodyweight rows by name.

`supabase/migrations/0044_set_metadata.sql`
- `alter table workout_sets add column if not exists set_type text not null default 'normal';`
  + `check` over the set-type values.
- `add column if not exists rpe numeric;`            -- 1–10, .5 steps, nullable
- `add column if not exists duration_seconds integer;` -- nullable, time-based types
- `add column if not exists distance_m numeric;`       -- nullable, meters (avoid km/mi ambiguity)

`supabase/migrations/0045_stats_set_type_gating.sql`
- Update the per-user stats recompute (from 0008/0013) to exclude `set_type='warmup'` and gate 1RM
  by `metric_type`. Volume for bodyweight types uses `user_profiles.weight_kg` (see refinements).

Apply live via Supabase MCP (per project convention), never `db push`.

---

## Phase A — Exercise types (no coach)

1. `metric_type` migration 0043 + check constraint.
2. `lib/exercises.ts`: add `metric_type` to `ExerciseDef`; tag all 47 library entries.
3. `lib/types.ts`: add `metric_type` to `Exercise`; extend `ActiveSet` with
   `duration_seconds?`, `distance_m?` (keep weight_kg/reps for the kg/rep axes).
4. `lib/exerciseResolve.ts`: persist `metric_type` when materializing a library/custom row.
5. `components/routines/ExercisePickerSheet.tsx`: "Type" row in the custom form → "Select Exercise
   Type" screen (8 cards, like Hevy). Default `weight_reps`.
6. `app/workout/[id].tsx`: set-row renderer + `handleLogSet` become `metric_type`-aware
   (column headers, input fields, validation). Add `mm:ss` and km inputs.
7. `lib/syncQueue.ts`: `PendingSet` carries `duration_seconds`/`distance_m`; insert into `workout_sets`.
8. Stats gating migration 0045 (1RM by metric_type).
9. History/detail rendering: show the right unit per set.

## Phase B — Set types + RPE (no coach)

1. `set_type` + `rpe` migration 0044.
2. `lib/types.ts`: `ActiveSet.set_type`, `ActiveSet.rpe`.
3. New `SetTypeSheet` (Portal) with common tier + More + Remove + `?` explainers.
4. `app/workout/[id].tsx`: tap SET cell → sheet; render colored letter badges; "Track RPE" in the
   exercise `⋮` menu reveals the RPE column + per-set picker.
5. `lib/syncQueue.ts`: `PendingSet` carries `set_type`/`rpe`.
6. Stats: exclude `warmup` from volume/PR (folds into 0045).
7. Reusable bits: extract a small `SetTypeBadge` and a shared chip helper (currently inline).

## Phase C — Coach awareness (follow-up)

- `lib/workoutCoach.ts`: include `metric_type`, `set_type`, `rpe`, duration/distance in the recap.
- Coach tools (migration 0014 RPCs): add the fields to `coach_get_workout_detail` /
  `coach_get_exercise_history`; exclude warmups from progression reads.
- `supabase/functions/ai-coach/prompt.ts`: update the data-schema reference block.

## Phase D — Supersets (separate milestone)

- Introduce an exercise-grouping id shared across grouped exercises' sets (e.g. `superset_group` on
  `workout_sets`, or a real `workout_exercises` table). Exercise `⋮` → "Add to superset" → pick
  partner → shared badge + rest behavior.

---

---

## Revised architecture & phasing (2026-06-17) — SUPERSEDES the Phase A–D list above

The earlier Phase A–D ordering stands, but is now fronted by a preferences foundation and a save
screen. Authoritative order:

### Phase 0 — Preferences foundation (NEW, build first) — IMPLEMENTED 2026-06-17

Status: built + type-clean. `hooks/usePreferences.tsx` (Provider + AsyncStorage, forward-safe
defaults incl. Phase A/B keys), registered in `app/_layout.tsx` between BasicInfo and Workout
providers. `components/workout/WorkoutSettingsSheet.tsx` (Portal sheet). Entry points (after a placement
revision — the first attempt put a gear in the workout top bar, rejected as unintuitive):
(1) a "Workout Settings" row in Profile's new TRAINING section (canonical set-and-forget home,
beside Appearance / Weight unit), and (2) a quiet "Workout settings" link at the foot of the
workout screen (active-session footer + empty state) for mid-session tweaks. Top-bar gear removed.
Live toggle: Keep screen awake (`expo-keep-awake ~15.0.8`, gated on pref, tied to the workout
screen lifetime). Intensity + inline-timer keys exist in the store; their rows land with
Phase B / Phase A. Pending: on-device check.

Placement rationale (locked): persistent preferences belong in the settings hub (matches the
existing model), not in the top bar's cancel/timer/finish triad; labeled entries beat icon-only;
visual weight encodes priority (lime "Add exercise" CTA dominates, settings link recedes).

- `lib/preferences.ts`: typed `WorkoutPreferences` + `usePreferences()` hook, persisted to
  AsyncStorage (local-first, matches syncQueue/guestStore pattern). Defaults merged on read so new
  keys are forward-safe. Initial shape:
  - `intensityTrackingEnabled: boolean` (default false) — shows the intensity column
  - `intensityScale: 'rpe' | 'rir'` (default 'rir')
  - `inlineTimerForDuration: boolean` (default true)
  - `keepAwake: boolean` (default false)
  - (reserved drop-ins: `defaultRestSeconds`, `restTimerSound`, `restTimerVibration`,
    `previousValuesSource: 'any' | 'same_routine'`, `plateCalculator`, `musicShortcut`,
    `prAlerts`, `aiSuggestions`, `detailedView`, `autoScrollSupersets`)
- Settings screen shell: reuse the existing "Settings" button on `app/workout/[id].tsx`. Grouped
  rows with icons. Only the 3 v1 toggles are live; the rest are added later as one-row changes.
- `keepAwake` wired via `expo-keep-awake` (gated on the pref).

### Phase A — Exercise types

As specified above. Duration input uses an inline stopwatch when `inlineTimerForDuration` is on,
otherwise a manual `mm:ss` field. Stores `duration_seconds` / `distance_m`.

### Phase B — Set types + intensity (REVISED)

- Set Type sheet as specified.
- **RPE/RIR is driven by the global preference**, not a per-exercise `⋮` toggle: the intensity
  column appears when `intensityTrackingEnabled` is on, labeled and entered per `intensityScale`
  (RIR shown as `10 − rpe`; data always stored in `workout_sets.rpe`).

### Phase B.5 — Save Workout screen (NEW, social-ready)

- New screen shown on Finish, before `enqueueWorkout`. Fields: title (defaults to routine name),
  editable date/time (drives `workouts.started_at` — backdating fits the edit-past-workouts branch),
  notes (`workouts.notes`), computed summary (duration / volume / sets).
- These already flow through `PendingWorkout` (name, notes, startedAtIso) — minimal backend change.
- **Social-ready hooks only:** component accommodates an optional media slot + visibility row, but
  no upload/sharing logic and NO schema migration for it now. A later `workouts.visibility` + media
  table would light it up.

### Phase C — Coach awareness (deferred). Phase D — Supersets + auto-scroll (deferred).

### Backlog — drop-in setting toggles (each ~1 row once Phase 0 lands)

Plate calculator, music shortcut (Spotify / YouTube Music deep links), live PR alerts,
rest-timer sound/vibration + default rest time, previous-values source, AI-suggestions toggle,
detailed-view toggle, warm-up calculator/sets.

### Icon map (RN, @expo/vector-icons)

- Exercise types: weight+reps `dumbbell`, bodyweight `arm-flex`, weighted `dumbbell`+`+`,
  assisted `dumbbell`+`−`, duration `timer-sand`, duration+weight `timer`+`weight`,
  distance+duration `run`, weight+distance `walk`.
- Settings: keep-awake `sun`, intensity `pulse`/`activity`, rest timer `timer`, sound `volume-high`,
  vibration `vibrate`, previous values `history`, plate calc `calculator-variant`, PR `trophy`,
  music `spotify`/`youtube` (FontAwesome5 brands), AI `lightning-bolt`, auto-scroll `chevron-down`.
- Set types: keep W/D/F/N/L/R colored letter badges (most scannable in a dense table).

### Icon sourcing (verified 2026-06-17)

- Confirmed installed: `@expo/vector-icons ^15.0.2` (bundles MaterialCommunityIcons + Feather +
  FontAwesome5/6) and `react-native-svg 15.12.1`. All proposed MCI fitness glyph names exist
  (dumbbell, weight-lifter, arm-flex, run, walk, timer-sand, kettlebell, yoga, etc.). → v1 uses
  these, no new deps.
- Heads-up: `@expo/vector-icons` may eventually migrate to `react-native-vector-icons`; fine on
  SDK 53, revisit on upgrade.
- Cohesive-redesign options (later, all SVG via react-native-svg): Lucide (`lucide-react-native`),
  Tabler, Phosphor. Custom SVG downloads: UXWing / SVG Repo (commercial-friendly). Branded set:
  Figma MCP.

### Phase E — Exercise library enrichment (free-exercise-db) — DECIDED 2026-06-23

Folded INTO this plan (was "parked") because it's synergistic with Phase A typing: tag `metric_type`
during the same ingest. Expand the global library from ~50 hardcoded entries (no thumbnails) to ~800
with demo images so the routine builder + workout "Add Exercise" picker offer a real catalog.

LOCKED DECISIONS:
1. Dataset = HYBRID. Base on `yuhonas/free-exercise-db` (public domain, ~800, JSON + static start/end
   images, redistributable). ExerciseDB animated GIFs are a LATER additive enrichment only (keyed
   freemium API, redistribution limits), never the foundation.
2. Images = host in Supabase Storage (own bucket, our URLs), NOT hot-linked.
3. Sequencing = start AFTER the design-polish PR #41 merges to main; fresh branch. Run alongside / just
   before Phase A so `metric_type` tagging happens in the same pass.

SOURCE SHAPE (free-exercise-db): `{ name, force, level, mechanic, equipment, primaryMuscles[],
secondaryMuscles[], instructions[], category, images[] }` (images are 2 static photos per entry).

APPROACH:
- Migration (apply via Supabase MCP, never `db push`): add `instructions` + `image_url(s)` to
  `exercises` (and `metric_type` from Phase A); create a public `exercise-images` Storage bucket + RLS.
- `tools/exercise-ingest/` script: fetch dataset; MAP their fine taxonomy -> our `MUSCLE_GROUPS`
  (primaryMuscles[0]; e.g. lower/middle back + lats -> Back) and equipment/category -> `CATEGORIES`;
  DEDUP by normalized name vs the existing ~50; upload + resize images to Storage; emit batched upserts.
- Make the DB the catalog SOURCE; remove the DUPLICATE local arrays (`lib/exercises.ts` EXERCISE_LIBRARY
  + the separate 19-item one in `app/workout/[id].tsx` — see codebase CONCERNS.md). Pickers read DB (cached).
- Tag `metric_type` per exercise during ingest: most = weight+reps; cardio/duration entries get
  duration/distance.

OPEN ITEMS: exact muscle-group mapping table (finalize at build); offline starter set vs fully remote
catalog; verify picker + dedup + offline cache on sim.

TRIGGER: PR #41 merged to main.

## Open refinements (decide during build, not blocking)

- **Bodyweight volume source:** `(bodyweight ± added) × reps` needs `user_profiles.weight_kg`. Option
  to snapshot effective load at set-time vs recompute from current bodyweight. If weight not set,
  fall back to reps-only and prompt once.
- **Units:** store SI internally (kg, meters, seconds); presentation honors a future mi/lb setting.
- **Set-type tier copy:** confirm which advanced types go under "More" (Rest-pause/Partial/AMRAP).
- **RPE vs RIR default:** likely a per-user display preference; data stays `rpe`.
