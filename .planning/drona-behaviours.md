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
cant_tell 1, expected_on_cut 1. One person has 18 stall weeks; most "plateaus"
are on people who train steadily. Watch this before cards act on it: a stall
card every week would be noise.

## Next

- Steering facts: pace to goal, estimated maintenance, real training weekdays,
  per-exercise skip and add habits, change outcomes, card answers by topic.
- The word behaviours (with Jev): life got in the way, trains but does not log,
  hurting, already asked for a change.
- Cards read `drona_behaviour_pick`.
