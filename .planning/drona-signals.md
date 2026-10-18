# Drona signals

events -> facts -> **signals** -> behaviours -> cards. A fact counts. A signal
draws a line across facts and says "this is worth noticing". The lines are the
owner's, approved 2026-10-13. Facts are in `.planning/drona-facts-ledger.md`.

Stored in `drona_signals`, one row per person, finished week and signal:
`fired`, `pattern` (fired the week before too; for a muscle, the same muscle),
`detail` (the numbers it was judged on), `rule_version`. A row with
`fired = false` means "looked, nothing to see"; no row means "could not look".
Rebuilt daily by the facts job, after the facts (`drona_rebuild_signals`).
Migration `20261013161335_drona_signals`. Nothing reads them yet.

## The first five (rule_version 1)

| Signal | Judged when | Fires when |
|---|---|---|
| `follows_split_not_today` | >= 2 training days on a TODAY pick | under 40% of TODAY's sets done, while >= 50% of the program's week was |
| `muscle_left_out` | a full program week with >= half the planned sessions done | a muscle the plan gives >= 4 sets got under half of them |
| `scale_untrusted` | >= 2 weigh-ins, or any impossible reading | typical jump between readings over 1.5 kg, or any impossible reading |
| `logs_snack_not_day` | >= 3 days logged and a target to judge by | at least 3 in 4 of those days under half the calorie target |
| `cards_not_landing` | a week with a card, and 2 finished cards so far | the last 2 were each ignored (expired) or tapped without the thing done; "no thanks" is an answer |

Finished weeks only: the running week is never judged.

## Signals 6-10 (rule_version 1, approved 2026-10-16)

Migration `20261016021746_drona_signals_2`.

| Signal | Judged when | Fires when |
|---|---|---|
| `weight_wrong_way` | 4 weeks of weigh-ins in a row, no untrusted scale, the goal (program target, else profile) >= 0.5 kg away | the last 2 weeks' average moved >= 0.3 kg away from the goal |
| `protein_short` | >= 3 whole days logged (not a snack week) | most of them under 70% of the protein target |
| `training_dropped` | planned sessions this week and last, >= 4 sessions in the 4 weeks before | under half the planned sessions both weeks |
| `lift_stuck` | any lift trained 3 finished weeks running, custom lifts included | its best estimated max this week is no higher than at the start of those 3 weeks (2 weeks earlier); a pattern is the same lift again |
| `goals_disagree` | a program with a goal | profile and program goal differ, or goal weights more than 2 kg apart |

Owner's reasons: 70% because there are few users yet; every lift counts because
"if he is putting effort into an exercise, even a custom one, he cares about it,
so we should care about its growth, or advise a change based on science"; a goal
weight gap is something Drona should ask about.

First run, 26 weeks: weight_wrong_way 0 fired (few people weigh in 4 weeks
running); protein_short 2 weeks, 1 person (the owner, July); training_dropped 34
weeks, 8 people (most stopped in mid-August); lift_stuck 69 weeks, 8 people;
goals_disagree 23 weeks, 3 people (the owner 66 vs 59 kg; the demo account and
one tester hypertrophy vs fat_loss).

Noticed: lift_stuck fires most weeks for anyone tracking many lifts (one of 14 is
always flat), so the PATTERN (the same lift two weeks running, 41 weeks) is the
stronger line for a card. Two accounts carry identical lift histories
(3EGT2QEE, 3EowGWx5): imported or copied data. Programs titled "Cut" but tagged
hypertrophy (task spawned) make goals_disagree miss a real disagreement.

Proof: `signals.mts` now 25 checks, every new line from both sides; with protein
moved to 60% on purpose, 1 fails.

## First run (2026-10-13, 26 weeks, 52 people)

57 rows judged, 15 fired:
- follows_split_not_today: the owner, 14 and 21 Sep (a pattern): TODAY 13% / 26%, program 67% / 59%
- muscle_left_out: the owner, Hamstrings and Calves, 14 and 21 Sep (a pattern)
- scale_untrusted: one tester, 5 weeks running, jumps 4.5 to 21.8 kg, 2 impossible readings
- logs_snack_not_day: the owner 4 weeks (about 300-420 kcal a day against 1800), the demo account 1
- cards_not_landing: the demo account, week of 28 Sep (2 cards in a row expired)

## Proof

`scripts/drona-facts/signals.mts`: 16 checks on a made-up person whose facts
sit just inside and just outside every line, all pass. With one line moved on
purpose (1.5 kg became "1.5 kg or more") 2 fail.

Before the food signal, the food facts were moved to the app's own day targets
(`20261013161042_drona_targets_from_history`): 6,768 of 6,768 day targets equal
`targetsForDay`, where the old lookup got 52 wrong (fuel days, one-day goals).
`scripts/drona-facts/targets-compare.mts`.

## Steering signals (rule_version 1, 2026-10-16)

Ten more, read from the steering facts by `drona_rebuild_steering_signals`
(after the first ten, which it never touches). The lines and their behaviours
are in `.planning/drona-behaviours.md`.

