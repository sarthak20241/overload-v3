# Phase metrics: Drona picks what to measure

Decided with the user on 2026-10-21 from the App Store card demos. The demo
screens are the design target; the build must match them.

Demo images (final), all in this folder:
- Goal card: `shots/01-goal.png`
- Phase view: `shots/01b-phase-view-demo.png`
- Both side by side: `shots/01-goal-and-phase.png`
- Older variants worth reading: `shots/01-goal-three-goals.png`
  (fitness goal with weekly bars, and a custom metric the user logs).

Demo source (HTML + CSS, exact sizes, colors, spacing): `src/goal9.tmpl.html`
and `src/goal9.py` in this folder. `src/goal8.py` holds the fitness (weekly
bars) and custom ("You log it") variants. The originals were made on one
machine outside the repo; these copies are the ones to read.

## 1. The idea

- Every phase gets ONE hero metric: the number the phase is judged on.
- Every phase gets 2 to 4 supporting targets, each with a status word that
  Drona updates weekly.
- Every phase gets its own slice of the goal (Summer Cut 72.5 → 68 kg over 12
  weeks; phase 3's job is 70.4 → 69.6 by week 7).
- Metrics come from what the app already tracks. When nothing fits, Drona
  makes a CUSTOM metric (name, unit, direction) that the user logs by hand.
- The chart reflects the hero metric: a line for a number, weekly bars for a
  habit (sessions a week). No metric, no chart.
- Custom and hero metrics also get a chart in Analytics ("Goal metrics").
- Drona adjusts metrics, targets and status at the weekly rewrite.

## 2. Data model (ADDITIVE ONLY)

New table `coach_program_phase_metrics`:
- id uuid pk, program_id, phase_id (fk coach_program_phases, cascade),
  user_id text default current_clerk_user_id() (same RLS pattern as 0096)
- seq int, is_hero bool
- kind text check in ('bodyweight','lift_e1rm','sets_per_muscle','steps',
  'sessions_per_week','cardio_sessions','sleep_hours','protein_days',
  'distance','duration','custom')
- ref jsonb (exercise_id for lift_e1rm, muscle for sets_per_muscle, name +
  unit + direction for custom)
- unit text, direction text check in ('up','down','hold')
- start_value numeric, target_value numeric, current_value numeric
- status text check in ('set','on_track','close','slipping','behind','due',
  'done'), status_note text, checked_at timestamptz
- created_at, updated_at

New table `coach_program_phase_metric_logs` (values the user logs for custom
metrics): id, metric_id (fk cascade), user_id, value numeric, logged_on date,
note text, created_at. Unique (metric_id, logged_on).

`coach_program_phases` gains two nullable columns: `job_text` text (the job
line, e.g. "Bring weight 71.0 → 69.6 kg") and `coach_line` text (Drona's one
sentence for this week).

Rules:
- No column is renamed, dropped or made NOT NULL. 1.0.0 and 1.0.1 on the
  store read `coach_programs` / `coach_program_phases` with the columns they
  know; those columns keep being written exactly as today.
- Revoke the default grants on the new tables and grant only what RLS needs
  (see memory: new public tables start fully granted to authenticated).
- After `apply_migration` of a NEW table: `notify pgrst, 'reload schema'`.
- The migration is applied by the user, not the session.

## 3. Generator (supabase/functions/ai-coach, program build)

- The plan JSON schema gains optional `metrics` per phase and optional
  `job_text`. Old fields (diet_*, training_*, readiness_directive,
  training_block, diet_fuel_days, activity_steps_target,
  cardio_sessions_per_week) are STILL produced and STILL written. The edge
  function response to an old client is a superset of today's.
- Drona must pick a hero metric per phase from the allowed kinds, with a
  per-phase target that slices the program goal. `custom` only when no
  app-measured kind fits, and then with name + unit + direction.
- Do not write eval inputs or observed failure numbers into the prompt
  (memory: no eval-overfit prompts). Prompt claims must be true of the code.

## 4. Weekly status

- A server job (reuse the existing weekly rewrite / drona-cards cron path,
  do not add a new cron without telling the user) computes `current_value`
  for app-measured kinds from existing data (bodyweight from daily_metrics,
  e1RM from workout_sets, sets per muscle and sessions from the stats tables,
  steps and sleep from daily_metrics, protein days from nutrition stats) and
  sets `status` with rules IN CODE (arithmetic in code, judgment in Jev).
  `coach_line` comes from the model, grounded in those numbers.
- Custom metrics take `current_value` from the latest log.
- A check runs once per local week per user (the drona-cards cron, every 15
  minutes, for users with an active program). A metric whose source read
  fails is left unstamped and retried on the next run; the readable ones are
  written. The coach line is written only on a run where every read
  succeeded, so a partial failure delays the line, never writes it from half
  the numbers.

## 5. App

- Rebuild `app/goal-plan.tsx` to the demo: goal card (name + pill, week and
  end date, PHASE METRIC label, hero number, line chart with phase target
  dot and goal flag OR weekly bars, phase bar, caption), then the phase
  header card (stepper: past = lime ticks, current = named lime pill, future
  = numbers; tap any to view that phase), name + weeks, job bar, coach line,
  then Train / Eat / Recover as three cards with the same shape and tracked
  rows on one shared 3-column grid (name / value / status). No progress bars
  on rows; the job bar is the only one. Flat, no glow. Colors from
  `constants/theme.ts`.
- Custom hero metric: "You log it" tag by the number and a lime "+ Log"
  button that opens a sheet (Portal, not Modal, per project memory) to log
  today's value.
- Analytics: a "Goal metrics" section charting the hero metric and any custom
  metric of the active program.
- A program with no metrics (built before this ships) must still render: fall
  back to today's layout for that program, never a blank screen.
- The new app must survive the migration not being applied yet: use the
  `lib/missingColumn` fallback pattern for the new columns and tables.
- Check whether the chart needs a native library. Memory says the Drona orb
  and its charts need a 1.0.2 STORE build (no OTA to 1.0.1). If this screen
  reuses that, say so in the PR: it ships in 1.0.2, not as an OTA.

## 6. Tests and evals

- Deno tests for the status rules (`lib/phaseMetrics.test.ts` or similar):
  write the test, delete the rule, prove it fails, restore.
- A small eval like `scripts/program-goal-eval`: does Drona pick a sensible
  hero metric per goal type, never `custom` when an app kind fits, never a
  line chart for a habit-only phase. Run with `EVAL_VIA_CLI=1`, concurrency
  6-8, and report which mode was used.
- The existing suites in CLAUDE.md must still pass.

## 7. Done means

- One PR against `main` with the migration, the generator change, the weekly
  status job, the screen, the log sheet, the analytics section and the tests.
- No `deploy:yes` label. No migration applied. No build submitted. The PR
  description lists the exact deploy order: migration first, then functions,
  then the app build, and says whether an OTA is possible or 1.0.2 is needed.
- The claude[bot] review is read and answered before asking the user to merge.


## 8. v2 layout (approved 2026-10-22)

The user found the first build "too boxy and complicated". Reference:
`shots/goal-screen-v2-reference.webp` (the title there is a placeholder; the
app shows the PROGRAM NAME).

Main screen (`app/goal-plan.tsx`), top to bottom, page background, flat, no
boxes except the phase card:
1. Header: back, "Goal & Plan", a `•••` menu (End this program, From Drona).
2. Title = the program name. Under it, muted: "Week 4 of 12 · Ends Dec 23".
3. Hero row: small caps label from the hero kind (CURRENT WEIGHT, SQUAT E1RM,
   SESSIONS LAST WEEK, a custom name with the "You log it" tag and "+ Log"),
   the big number and unit; right: GOAL and the goal value. No metrics: today's
   bodyweight against target_weight_kg, else no hero.
4. The hero chart: plain stroke, no fill; weekly kinds keep the bars.
5. One status sentence from the hero's status (`heroStatusLine`, in code).
6. The phase card (the only card): CURRENT PHASE, name, chevron, "Week 4 of 5
   · Target 63.7 kg", the job bar, "23% of phase target". Tapping opens the
   phase screen.
7. "Your plan": three list rows with hairline dividers (Train / Eat / Recover),
   subtitle = plan text plus the pillar's supporting-metric status, coloured.
   Each opens the phase screen scrolled to that pillar.
8. "This week's focus": one sentence, the phase's coach_line, else derived in
   code from the worst supporting metric (`focusLine`).
9. One full-width lime button: "Build this phase's workouts" when the current
   phase has no routines, else "Adjust with Drona".

Phase screen (`app/goal-plan-phase.tsx`, route `/goal-plan-phase?seq=N&pillar=train`):
everything the first build showed for a phase, moved: the numbers-only stepper,
job line, Drona's line, Train / Eat / Recover with the week strip, fuel marks,
macro bar, tracked rows with status, routines, the rules and the build call
to action (`components/program/PhaseDetail.tsx`).


## 9. Pillar screens and the finish pass (approved 2026-10-22)

Train, Eat and Recover are three individual, flat screens. Design target:
`shots/pillars-v1.png` (all three), `shots/pillar-train.png`, `shots/pillar-eat.png`,
`shots/pillar-recover.png`; exact sizes, colours and spacing in `src/pillars.py`.

- One route, `app/goal-plan-pillar.tsx`: `/goal-plan-pillar?pillar=train|eat|recover&seq=<phase>`.
  The main screen's plan rows open it for the current phase; the phase
  screen's rows open it for the phase being viewed. The phase screen keeps
  the numbers-only stepper, name and weeks, job bar and coach line, then the
  same three plan rows; its boxed pillar cards are gone.
- Every pillar screen, same shape, no boxes: eyebrow "<PHASE> · WEEK 4 OF 5"
  (a phase to come: "STARTS WEEK 7"), the title, one hero number with its
  unit, one status line, one weekly visual, a short section of rows, and the
  coach's tip as a quote with a 3px lime bar.
- Train: sessions this week of the target; the seven days from the week
  pattern (done = lime with a check, from finished workouts this week; today
  ringed; rest a dash; to come the session's initial); TARGETS rows for the
  other metrics; WORKOUTS rows per routine with the exercise count, opening
  the routine sheet; no routines = the lime build button and one coach line.
  The training directive is the tip.
- Eat: kcal a day; protein metric with status; DAILY TARGETS as three big
  numbers with a macro-coloured line; FUEL DAYS circles with a lime ring on
  the fuel days (hidden when there are none). The diet directive is the tip.
- Recover: average sleep over the last seven nights; nights at the target
  with status; TODAY rows (readiness and its verdict, resting heart rate
  low/normal/high, HRV up/flat/down, each only when it exists); LAST 7 NIGHTS
  bars (lime at target, grey under, a dashed baseline). With no Health data:
  one calm line and the connect action. The readiness directive is the tip.

The finish pass (`components/program/finish.tsx`), applied to the main, phase
and pillar screens: skeleton blocks instead of spinners; one spacing scale
(4/8/12/16/24/32) and one type scale (title 34/700, hero 56/700 tabular,
unit 18/500 muted, section 12/600 uppercase, row title 16/500, row value
15/500, status 13/600, meta 14/500); rows 52pt with hairline dividers, a
pressed state, a chevron only when they navigate; a short staggered fade on
first render that respects reduce motion; a light haptic on stepper and row
taps (expo-haptics is in the shipped 1.0.1 binary); tabular numbers with
separators and one decimal for kg and hours; empty states in the coach's
voice; bottom safe-area padding and pull-to-refresh. No new native
dependency and no Skia: react-native-svg and Reanimated only, so the whole
thing stays OTA-able to 1.0.1.

One number per metric (device check 2026-10-22). A plan row on the Goal or
phase screen and the hero on the pillar screen show the SAME value and
status, read through one helper (`lib/phaseMetricHeadline.ts`):

- With a job reading: the last whole week, labelled so. "3 of 4 sessions
  last week · On track", "7.3 h a night last week · On track", "8,200 steps
  a day last week", "5 of 7 protein days last week", "2 of 3 cardio last week".
- Without one: the same live number everywhere and no status word, since the
  job has not judged it. Sessions: "1 of 4 sessions so far this week" (the
  Goal and phase screens load the same live readings the pillar does).
  Sleep: the average over the nights that exist, "8.0 h a night from 2
  nights" under four nights, else "h a night, last 7 nights". A source with
  nothing yet says what feeds it ("Needs Health sync", "Not logged yet");
  "Due" only where a reading is owed and nothing live stands in.
- Live this-week progress beyond that lives only in the week visual: the
  day circles and the sleep bars.

The Eat screen's TODAY section (current phase only), above the tip:
"Calories 528 of 1,800" and "Protein 36 of 115g" as two rows, from the same
hooks as the dashboard's Fuel card (today's diary and the nutrition targets,
fuel day included). Fuel days stay hidden when the phase has none.

Speed (2026-10-23). The program loads in one round: the program with its
phases and their routines embedded (`routines!program_phase_id`, since phases
and routines point at each other twice), and the active program's metrics
read side by side through an inner join. The old step-by-step read stays as
the fallback for a relationship error; missing-column fallbacks run only on
an actual error, and the widest column set that worked is remembered.
`lib/screenCache.ts` keeps the program and the pillar reads in memory: the
phase and pillar screens paint at once from it and refresh on focus, the
Goal screen warms Train/Eat/Recover for the current phase, and every write
to the program or a phase's routines invalidates it.

The program's objective sits under "Week N of M · Ends …": one muted
paragraph (15/21), two lines with an inline lime "More", "Less" to close.
Hidden when empty.
