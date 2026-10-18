# Drona behaviours

events -> facts -> signals -> **behaviours** -> cards. A signal says "this is
worth noticing". A behaviour joins signals into a reason: what is going on with
this person, how Drona should say it, and what Drona should keep quiet about.
Signals are in `.planning/drona-signals.md`.

Stored in `drona_behaviours`, one row per person, finished week and behaviour:

- `priority`: lower is more important (data trust, then trust in Drona, then the rest)
- `card_kind`: how Drona would raise it (`request`, `talk`, `notice`)
- `meta`: changes how Drona speaks, never the topic itself
- `mutes`: signals this behaviour silences that week
- `detail`: the numbers behind it, `rule_version`

`drona_behaviour_pick` (a view) chooses one behaviour per person-week: the first
non-meta row by priority. If a meta row exists that week, the pick is said as a
`notice`. `mutes` gathers every row's mutes for the week.

Notes for the cards layer (PR #253 review): a week whose only row is a meta
behaviour has no pick, which means "say nothing", not an error. `mutes` is
only recorded: the calorie check-in honours `topic:<x>` mutes, but nothing yet
filters `weight_wrong_way` or `protein_short` by the signal mutes; the cards
layer must. Behaviours are skipped (logged as `behaviours: skipped`) when the
signals rebuild failed, so `on_track` never stands on missing signals.

Rebuilt daily by the facts job, after signals (`drona_rebuild_behaviours`, its
own subtransaction, errors logged as `behaviours` in `drona_facts_runs`).
Migration `20261016133352_drona_behaviours`. Nothing reads them yet; the cards
layer will read the pick.

## The eight maths behaviours (rule_version 1, approved 2026-10-16)

Rules: words beat numbers, one card a week, plan changes start as a talk card,
wait for a pattern (2 weeks running) before acting.

| Pri | Behaviour | From | Card | Notes |
|---|---|---|---|---|
| 10 | `scale_untrusted` | `scale_untrusted` pattern | request | mutes `weight_wrong_way` |
| 11 | `logs_partial_days` | `logs_snack_not_day` pattern | request | mutes `protein_short` |
| 12 | `not_hearing_drona` | `cards_not_landing` fired | notice | meta: the pick is said as a notice |
| 20 | `goals_unclear` | `goals_disagree` pattern | talk | |
| 21 | `drifting_away` | `training_dropped` pattern, 0 chat messages this week and last | talk | if they wrote, words beat numbers: the word behaviours handle it |
| 22 | `own_way` | `follows_split_not_today` pattern | talk | carries the muscles left out this week and last |
| 23 | `lift_stall` | `lift_stuck` pattern | talk | only lifts stuck both weeks; a cause, below |
| 90 | `on_track` | sessions >= planned (> 0), no signal fired that week | notice | |

`lift_stall` cause, first match wins:

1. `cant_tell`: snack logging this week or last
2. `expected_on_cut`: program goal is fat loss, or program target more than 0.5 kg under this week's weight
3. `recovery`: average sleep under 6 h, or 2+ low-readiness days
4. `under_fuelled`: protein short this week or last
5. `real_plateau`: at least 3 in 4 planned sessions done
6. `inconsistent_training`: otherwise

## Proof

`npx tsx scripts/drona-facts/behaviours.mts`: 23 checks on a made-up person,
every line tested just inside and just outside. Mutation check: the plateau line
moved live from `>= 0.75` to `> 0.75` made 2 checks fail; restored, md5 checked.

## First run (2026-10-16, 26 weeks, 53 people, 105 rows)

| Behaviour | Weeks | People | Picked |
|---|---|---|---|
| `lift_stall` | 41 | 7 | 41 |
| `on_track` | 21 | 6 | 21 |
| `drifting_away` | 18 | 6 | 16 |
| `goals_unclear` | 17 | 3 | 16 (1 as a notice) |
| `scale_untrusted` | 4 | 1 | 4 |
| `logs_partial_days` | 2 | 1 | 2 |
| `not_hearing_drona` | 1 | 1 | meta |
| `own_way` | 1 | 1 | 0 (lost to `goals_unclear`) |

`lift_stall` causes: real_plateau 34, inconsistent_training 4, recovery 1,
cant_tell 1, expected_on_cut 1. After the full 26-week facts rebuild of 2026-10-16
(stale exercise facts for one person, see the ledger, step 8), `lift_stall` is
49 weeks. One person has 18 stall weeks; most "plateaus"
are on people who train steadily. Watch this before cards act on it: a stall
card every week would be noise.

## Steering behaviours (rule_version 1, built 2026-10-16)

The owner approved all nine, and asked for an ACTIVE maintenance finder:
someone trying to reach a weight needs Drona to work out their calories, and to
ask for exactly what is missing until it can.

Migrations `20261016160716_drona_steering_behaviours` +
`20261016160822_drona_steering_signals_history`. Ten new signals in
`drona_signals` (`drona_rebuild_steering_signals`, run after the other signals),
twelve new behaviours. A new card kind, `steer`: it feeds the next plan Drona
writes and is never a card, so `drona_behaviour_pick` skips it. `on_track` still
reads only the first ten signals.

| Signal | Judged when | Fires when |
|---|---|---|
| `off_pace` | trusted trend (8+ weigh-ins over 21+ days, no untrusted scale in 4 weeks), goal 0.5+ kg away, a date | date passed; trend not moving toward the goal; pace needed over 1% of body weight a week (loss) or 0.5% (gain); or arriving 2+ weeks late |
| `maintenance_unknown` | goal 0.5+ kg from the weight, and 1+ weigh-in or 3+ food days in the window | until the trend is trusted AND 14+ whole food days exist. Says what is missing and how much |
| `calories_off` | maintenance known (as above), a goal 0.5+ kg away, a kcal target | target 250+ kcal from maintenance + pace x 1100 (pace = the date's, kept inside the safe band, else 0.5% a week down or 0.25% up; rounded to 50) |
| `trains_any_day` | 6+ of 8 weeks trained | 3+ sessions a week and at most 1 weekday trained in 6+ of 8 weeks |
| `fixed_days` | same | 3+ such weekdays |
| `plan_too_big` | same, sessions planned | planned 1+ above the 8-week average |
| `favourite_exercises` | 6+ of 8 weeks trained | done in 6+ of 8 weeks, not in this week's phase (custom counts) |
| `exercise_skipped` | 4+ of 8 weeks trained | skipped in half or more of 4+ routine sessions, or in the phase 4+ trained weeks and never done while half the phase's others were. A pattern is the same exercise |
| `topic_not_landing` | any card history | a topic with 2+ cards, none followed, 2+ not followed, the last within 21 days |
| `change_backfired` | a change alone (1 other the same day at most, none after), 2+ sessions or 4+ food days before, its 14 days after closing this week | sessions or food days fell under 3 in 4 of before |

| Pri | Behaviour | From | Card |
|---|---|---|---|
| 13 | `topic_not_landing` | fired; mutes `topic:<topic>` | talk the first week, then steer |
| 14 | `finding_maintenance` | `maintenance_unknown` pattern | request |
| 15 | `off_pace` | pattern | talk |
| 16 | `calories_off` | pattern | talk |
| 24 | `plan_too_big` | pattern | talk |
| 25 | `exercise_skipped` | pattern, the exercises skipped both weeks | talk |
| 26 | `change_backfired` | fired, the backfired changes | talk |
| 80 | `maintenance_found` | any `calories_off` row: maintenance and the suggested target | steer |
| 81 | `trains_any_day` | fired | steer |
| 82 | `fixed_days` | fired | steer |
| 83 | `keep_favourites` | `favourite_exercises` fired | steer |
| 84 | `change_worked` | judged changes that did not backfire | steer |

Proof: `scripts/drona-facts/steering-behaviours.mts`, 38 checks, every line
from both sides. Moving the 250 kcal line live from `>=` to `>` made 3 fail;
restored. The other four suites still pass.

**First run (26 weeks).** `finding_maintenance` wins the pick 73 times for 10
people, 15 of the last 4 weeks' 25 picks: people with a goal who weigh in or log
a little, but not enough. `calories_off` judged twice (one person, Jul/Aug:
maintenance about 1,820, target 2,250, suggested 2,000-2,050). `off_pace` judged
never: nobody has a trusted trend and a date. `change_backfired` judged never
after the history fix (the first run called a change backfired on one food day).
`fixed_days` 8 people, `trains_any_day` 5, `keep_favourites` 8, `exercise_skipped`
3, `plan_too_big` 5, `topic_not_landing` 3.

## Next

- The word behaviours (with Jev): life got in the way, trains but does not log,
  hurting, already asked for a change.
- Cards read `drona_behaviour_pick`.
