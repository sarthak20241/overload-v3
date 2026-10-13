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
