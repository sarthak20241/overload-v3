# The facts ledger

The layer under signals. Agreed with the owner 2026-09-23.

```
  events            a weigh-in, a meal, a finished set, a target change, a note
    -> FACTS        one row per person per LOCAL week. Counting only, no opinion. <- this file
    -> signals      a statement about a RUN of facts, with a line drawn
    -> behaviours   signals together, with a probable cause
    -> cards        what Drona says
```

**Why facts first.** Facts never change: week 37 is week 37 forever. Signals and
behaviours are opinions about facts, and we WILL change our minds about them (a
line moves from 6 days to 9). With facts stored, every past signal recomputes in
seconds. Without them, every change of mind restarts the clock. Today the worker
builds one 14-day blob, decides, and throws it away, so "did the scale move more
in week 2 than week 1" cannot even be asked.

**Rules for this layer.**
1. Arithmetic only. No thresholds, no judgment, no model. Jev and the LLM never
   touch it.
2. A week is the user's LOCAL Monday-to-Sunday week.
3. Judge a week by the targets IT had, not today's. Old targets are rebuilt from
   `plan_changes`.
4. **Record the dirt, do not hide it.** Every count of dropped or missing data is
   itself a fact. Only physically impossible values are dropped, and the count of
   drops is stored.
5. Recomputable from source at any time. A week may be rebuilt; it must come out
   the same.

---

## 1. Weight and body  [STEP 1]

Source: `daily_metrics` (`bodyweight_kg`, `body_fat_percent`), `body_measurements`.
`metric_date` is already the user's local day, so no timezone conversion.

| Fact | Notes |
|---|---|
| readings | kept readings in the week |
| dropped_impossible | readings outside 25-400 kg, dropped and counted |
| avg_kg, min_kg, max_kg | of kept readings |
| first_kg / first_on, last_kg / last_on | the ends of the week |
| delta_prev_week_kg | this week's average minus last week's average |
| typical_swing_kg | mean absolute difference between neighbouring readings |
| sources | manual / healthkit / health_connect, so a bad scale is traceable |
| bodyfat_readings, bodyfat_avg | |
| tape_days, tape_sites | measurements taken this week |

No trend and no "is it flat" here: a single week holds 3-7 readings, far too few.
Trend across weeks is a SIGNAL.

**Real dirt found before building (2026-09-23):** one live user's synced scale
reads 94, 81, 73, 31.8, 71, 89, 5.0, 6.0, 69 kg on consecutive days. A household
scale or a test rig. 25-400 kg drops the 5 and 6; the rest stay, and
`typical_swing_kg` of about 15 tells the signal layer this scale is unusable.
10 users have any weigh-in at all; 6 in the last 8 weeks.

## 2. Food  [STEP 2, LIVE 2026-09-23, migration 0132]

Source: `user_nutrition_stats` (one row per day), `meals`, targets from
`user_profiles` rebuilt per week via `plan_changes`.

| Fact | Notes |
|---|---|
| days_logged (of 7), entries | |
| avg_kcal, avg_protein_g, avg_carb_g, avg_fat_g | on logged days |
| target_kcal, target_protein_g | **as they were that week** |
| days_within_10pct, days_over_10pct, days_under_10pct | |
| highest_day_kcal / on, lowest_day_kcal / on | |
| single_entry_days | a day with one entry is a half-logged day |

## 3. Training  [STEP 3, LIVE 2026-09-24, migrations 0136 + 0137]

Source: `workouts`, `workout_sets`, `routines`, `routine_exercises`,
`coach_program_phases`. `started_at` is timestamptz, so convert with the profile
timezone (the 0126 lesson).

| Fact | Notes |
|---|---|
| planned_sessions | the phase's week pattern, else `weekly_target_sessions` |
| done_sessions, done_on_phase_routines, off_plan_sessions | |
| total_minutes, avg_session_minutes, total_volume_kg | |
| sets_planned, sets_completed | a session cut short shows here |
| exercises_skipped, exercises_swapped | planned but not done; another for the same muscle |
| sets_with_rpe, warmup_sets | who uses RIR |
| days_since_last_session | at week's end |
| longest_gap_days | inside the week |

## 4. Recovery  [step 3]

Source: `daily_metrics`. Available: `readiness_score` (16 users), `sleep_minutes`
(18), `steps` (17), `hrv_sdnn_ms` (4), `resting_hr_bpm` (3), `sleep_quality` (13).

| Fact |
|---|
| readiness_days, readiness_avg |
| sleep_days, sleep_avg_hours |
| steps_days, steps_avg |

## 5. Plan  [step 4]

Source: `plan_changes`, `coach_programs`, `coach_program_phases`.

| Fact | Notes |
|---|---|
| changes | every change that week: entity, from, to, **who** (manual/chat/card/auto/onboarding) |
| days_since_target_change | at week's end |
| phase_seq, week_of_phase, weeks_left | where they are on the road |

## 6. Words  [step 4, the only domain Jev reads]

Source: `workouts.notes`, `workout_exercise_notes`, `user_exercise_notes`,
`meals.note`, `coach_memory`, `user_profiles.injury_notes`.

| Fact | Notes |
|---|---|
| workout_notes, exercise_notes, meal_notes | counts AND the text |
| memory_added, memory_changed | counts AND the text |
| injury_notes | the profile text as it stood |

Text is stored so Jev can read it later. The facts layer does not interpret it.

## 7. Cards and answers  [step 4]

Source: `drona_cards`.

| Fact |
|---|
| card shown: kind, topic, status, what was tapped, when |
| talk answer given |

## 8. Not possible yet  [blocked]

| Fact | Why | Fix |
|---|---|---|
| days the app was opened | only in PostHog | a small server-side events table |
| features opened (did they look at RIR?) | same | same |

---

## Storage

`drona_week_facts`, primary key (user_id, week_start). One column group per
domain, added by its own migration. Wide is correct for a facts table.
`computed_at` and `source_version` on every row, so a rebuild is visible.

## Step 1 is live (2026-09-23)

`0131_drona_week_facts_weight` applied. 270 week rows backfilled over 6 months
for the 10 users who have ever weighed in. Read them with
`npx tsx scripts/drona-facts/weeks.mts` (add `USER_ID=` for one person,
`REBUILD=1` to recompute first).

What the real data shows, before any signal exists:

| user | weeks | readings | dropped | worst swing | source |
|---|---|---|---|---|---|
| user_3Gt86sdnx | 16 | 92 | 0 | 0.50 | manual |
| user_3EGT2QEEg | 4 | 21 | 0 | 0.13 | health_connect |
| user_3HKAcd0GK | 10 | 22 | 0 | 0.20 | manual |
| **user_3J3WElv7R** | 5 | 21 | **2** | **21.82** | health_connect |

One number separates a person from a broken scale: **typical swing**. Every real
user is at or under 0.65 kg; the household scale is at 21.8, and its week
averages jump 70 to 81 to 72 to 87. `w_dropped_impossible` caught the 5 kg and
6 kg readings; the 31.8 and 35 kg ones are physically possible, so they stay in
the facts and the swing exposes them. That is the layer doing its job: record
the dirt, let the signal layer judge it.

The first candidate signal writes itself, from data rather than from a guess:
**scale trustworthy** = typical swing under some line between 0.65 and 21.8.
Choosing that line is the signal step, not this one.

## Step 2 is live (2026-09-23): food

`0132_drona_week_facts_food` applied; 297 week rows for the 11 users who have
logged a meal. Reconciled against a hand count over the raw meals: 81 local
days and 465 entries, both exact. (The raw total is 82 and 466: the extra day
belongs to a meal whose owner has no profile, an orphan the ledger rightly
skips.) One week hand-checked line by line: 5 days, 16 entries, average 2139.2,
1 within / 3 over / 1 under, highest 2824 on 2 July, 2 single-entry days. Exact.

**Days are dated from meals in the user's zone.** `user_nutrition_stats` dates
by `logged_at::date` in UTC, which put 16 of 195 meals (8%, 3 users in India)
on the wrong day. The facts do not use it. The table itself feeds Drona's card
facts, the coach and readiness, so its fix is a separate task.

**Each day is judged against the target it had**, rebuilt from `plan_changes`,
and every week says where its target came from. On the 31 weeks with food
logged: 19 `assumed_current`, 8 `inferred`, 2 `recorded`, 2 `none`. The diary
only started on 2026-09-17, so history is mostly assumed. That is exactly why
the source is stored: a signal can refuse to judge an assumed target.

What the food facts already show that a "days logged" count hides:
- One user logged 7 of 7 days in a week at an average of **418 kcal** against
  1800, and 27 of their 32 logged days are under target. Logging every day,
  but logging a snack, not a day. "Days logged" says perfect; the average says
  the log cannot be read.
- One single-entry day holds 2824 kcal. A single entry is not always a
  half-logged day: some people log a whole day in one line. The fact is
  recorded as a count; a signal must read it together with the kcal.
- Some accounts carry seeded demo data (see memory: demo account seed). Their
  weeks look like a textbook. Signals must be checked on real users too.

## Step 2b is live (2026-09-24): the day is the atom

`0134_drona_day_facts` applied. `drona_day_facts` holds one row per person per
local day (97 days, 557 entries for 11 people). The week's food facts are now a
ROLLUP of those days, and windows are read, not stored:
`drona_food_windows(user)` gives the last 3 / 5 / 7 COMPLETE days and this week
against last. Today is left out of the windows because it is still being logged:
one person's week read 1045 kcal while their last three complete days averaged
1288, because today was half done.

**Proved the rewrite changed nothing it should not.** Snapshotted all 297 week
rows first, rebuilt from days, compared field by field: 268 identical. Of the
29 that differ, 5 gained meals logged since the snapshot, and 24 (one account)
kept the same 2250 target while its label moved from `assumed_current` to
`inferred`, because that account changed its target today and the diary now
knows the earlier value. No count moved without new data behind it.

New weekly facts: days missed, longest dark run, streak at week's end, weekday
vs weekend days logged, days with breakfast / lunch / dinner / snack, days under
half the target, days logged on the day itself, median and spread of kcal,
weekday vs weekend average, the week's total against the sum of its days'
targets, each macro's days met (90%+) and days under half, fiber, and how the
entries were made (AI-parsed, catalog, estimate, typed, unknown).

**Macros below a safe level (owner's question, 2026-09-24).** The fact is only a
count against that day's own target: days each macro was under half of it.
Whether that is unsafe is a signal, and needs body weight (fat under about
0.5 g per kg is a real floor; a gram target alone is not). Whether it is a
CHOICE is a behaviour: `user_profiles.diet_preference` and `coach_memory` say
keto or a medical diet, and the behaviour layer lets that override the count.
The fact never knows why a number is low.

What the new facts already show:
- The demo account's seeded weeks give themselves away: 7 of 7 days, every
  meal, a spread of only 39 kcal, and **0 days logged on the day itself**.
  "Logged same day" separates a real log from a backfill.
- The 418 kcal person: 7 of 7 days under half the target, every macro under
  half every day. The earlier "logs a snack, not a day" read, now one column.
- The average hides what the median shows: one week averaged 1678 with a
  median of 2088, because one very light day pulled the mean down.
- The current week's row includes today, which is still being logged. Signals
  should read complete weeks, or the windows, never the open week's averages.

## Step 3 is live (2026-09-24): training

`0136_drona_training_facts` + `0137_..._active_program`. Built around the
owner's three questions:

1. **Rest and train at the right times; the program or their own way.** Per day
   (`drona_training_day_facts`) and per week: sessions, minutes, sets, volume;
   sessions from the ACTIVE program's routines vs another routine vs freestyle;
   early sessions (before the pattern's rest had passed) and overdue days (a
   session due, none done); what TODAY picked, whether it was done, and how much
   of the picked routine's exercises and muscles were trained anyway; longest
   run of training days and of rest days; days the same parent muscle was
   trained two days running; planned sessions from the phase pattern or the
   weekly target; inside routine sessions, exercises planned / done / added and
   sets planned / done.
2. **Growing, stuck, or slipping.** One row per exercise per week
   (`drona_exercise_week_facts`): best estimated 1RM (Epley, 1-12 reps, working
   sets), top weight and its reps, best reps for bodyweight moves, longest hold
   for timed ones, sets, volume, and whether it is in the active program.
3. **Most trained and ignored muscles.** One row per raw muscle per week
   (`drona_muscle_week_facts`), with its parent, and a parent view
   (`drona_parent_muscle_week_facts`). Both levels are kept for the coach.

Rest days follow the PERSON, not the calendar (`_shared/todayPick.ts`): after
each session the pattern's rest days must pass. Early and overdue are computed
from the session sequence, only for a phase of the ACTIVE program with a built
split, and a phase whose routines were never opened is due from its first day.

**Primary muscle only.** Each exercise has one muscle today, so a bench press
counts for chest alone and triceps look under-trained for anyone who presses.
Rows carry `role = 'primary'`; secondary muscles are a later step (owner's call:
the coach gets told this in the meantime).

**Checked.** Reconciled for all 23 people with workouts: 581 sessions and 9,014
working sets, identical in the week, exercise and muscle tables
(`scripts/drona-facts/reconcile-training.mts`). No tester has ever done a session
from their active program's routines, so early and overdue were proved on a
made-up person with a hand-worked schedule, 19 checks, all pass
(`scripts/drona-facts/training-schedule.mts`). Read one person with
`USER_ID=... npx tsx scripts/drona-facts/training.mts`.

**What 0136 got wrong, found on the owner's own account the same day.** Six
programs (five archived, three starting the same day), so "the program" meant
any of six; and because the active program's routines were never opened, 0136
computed no schedule at all and called nothing overdue. 0137 reads the active
program only and treats an unopened built phase as due from its first day.

What the training facts show, before any signal exists:
- **Nobody follows the program through its routines.** Among all testers, zero
  sessions from an active program's routine, zero TODAY picks done as picked.
- **The owner goes their own way, and TODAY does not notice.** TODAY said
  "Legs" for 12 days running; the owner trained 8 times, freestyle and their own
  routines, and on 21 Sep a Full Body session covered 100% of the Legs routine's
  muscles with 0% of its exercises. Overdue by the plan, not skipping: exactly
  the distinction the pick-overlap facts exist for.
- **Lifts mostly flat over 8 weeks** (lat pulldown 52-57, leg extension
  118-123), and one slipping (ab crunch machine 120 to 96).
- **Upper body dominates.** 8 weeks: Back 134 working sets, Hamstrings 19,
  Calves 10, Glutes 0. And 42 sets are on exercises tagged "Other", which no
  muscle count can see.

## Build order

1. **Weight** (this step): table, weight columns, compute function, backfill 8
   weeks for every user, a probe that prints one person's weeks side by side.
2. Food. 3. Training and recovery. 4. Plan, words, cards.

Nothing reads this table yet. Cards keep deciding exactly as they do today.
