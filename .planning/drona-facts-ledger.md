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

## 3. Training  [step 3]

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

## Build order

1. **Weight** (this step): table, weight columns, compute function, backfill 8
   weeks for every user, a probe that prints one person's weeks side by side.
2. Food. 3. Training and recovery. 4. Plan, words, cards.

Nothing reads this table yet. Cards keep deciding exactly as they do today.
