# The Jev eval

Does each question we ask Jev separate weeks where the answer is known?
Plan and findings: `.planning/drona-jev-plan.md`. Questions:
`supabase/functions/_shared/dronaJev.ts` (the worker will read the same file).

```bash
npx tsx scripts/drona-jev/eval.mts                  # all 68 weeks, under one cent
GROUP=fresh npx tsx scripts/drona-jev/eval.mts      # the 18 held-out weeks
ONLY=jumpy-scale,stall-plain npx tsx scripts/drona-jev/eval.mts
WEEK=travel-note npx tsx scripts/drona-jev/example.mts   # one week as Jev sees it, and its raw answer
```

Needs `JEV_API_KEY` in `.env.local`.

## The data: one fortnight per test

Each week is one JSON object, the same shape production will send:

| Field | What it holds |
|---|---|
| `goal` | fat_loss / muscle_gain / maintain, current and goal weight |
| `daily_targets` | kcal and protein |
| `food_log_last_14_days` | one row per LOGGED day: kcal, protein |
| `food_summary` | days logged, average kcal and **% of target**, days within 10% of target, highest day and **% of target**, average protein and **% of target** |
| `weigh_ins_last_14_days` | one row per weigh-in |
| `weigh_in_summary` | count, average, least-squares trend in kg and in **% of body weight per week**, typical change between neighbouring weigh-ins |
| `calorie_target_changes` | date, days ago, from, to, and WHO changed it (coach_chat / coach_card / user_by_hand) |
| `training_by_week` | four weeks: planned, done, **done % of planned** |
| `coach_notes` | free text the person told Drona ("travelling until 30 September") |

Every number Jev needs is worked out in code. It is not a calculator: asked
whether 3054 is far above 2000, it flipped a coin.

Weeks are built from a SPEC (weight speed, scale noise, days logged, protein
share, change history, sessions done...) with seeded random noise, and each
week RESEEDS until its realised numbers show what its label claims.

## The questions

**13 signals**, each a yes/no (`noul`). Each has `instructions` (the question,
naming the field to read) and `criteria` (what counts as yes, what counts as
no, with the line stated: "about 140 or higher", "three weigh-ins or fewer").

flat weight, falling fast, rising fast, jumpy scale, few weigh-ins, sparse
food log, intake near target, a far-over day, protein adequate, the user undid
a coach change, training short this week, training short for weeks, an absence
explained by a note.

**1 choice**, `which_card`, over 12 cards. Its `instructions` are an ordered
list of cases ("work down this list and stop at the first that clearly
applies"), and each card's `criteria` entry says when to choose it with a
worked example. The examples use people and numbers that appear in no test
week.

## The answers

A yes/no comes back as one number, the probability of yes:
`{"type":"noul","noul":0.98}`

The choice comes back with the pick, a probability for every card, and a
confidence: `{"choice":"talk_about_high_days","confidence":0.82,"probabilities":{...}}`

## The weeks: 68, in four groups

| Group | Count | What it proves |
|---|---|---|
| clean | 35 | every card, on different bodies, targets and training plans |
| near-miss | 9 | just on the SAFE side of a line: exactly 6 weigh-ins, exactly 9 food days, 0.35 kg wobble, one day at 125%, protein at 88%, a hand edit with no coach change before it |
| mixed | 6 | two things true at once; the priority order decides (an undone change beats high days; high days beat low protein; training drift beats a food stall) |
| fresh | 18 | written AFTER tuning, never used to tune. Boundaries (exactly three weigh-ins, six days logged), a reversed RAISE, a flu note, a note about a trip that already ended |

**The lines are the SHIPPED ones.** `dronaCalories.ts` lets calories move only on
6+ weigh-ins and 9+ food days; under that the card asks for more data. The first
version of this set invented looser lines (3 and 6) and labelled "lower calories
on 5 weigh-ins" as right. The owner caught it. A label that contradicts the
product is worse than no test: check new lines against the shipped rules.

## The scoring

- **Signals: the gap.** For each signal, the lowest probability given to a TRUE
  week minus the highest given to a FALSE week. Wide and positive means any
  line drawn in the gap separates right from wrong. Accuracy at 50% hides a
  narrow gap, so it is reported but not trusted.
- **Cards:** the pick against the curated card, by group, with confidence when
  right and when wrong.

## Findings so far

- Tuned set 50/50, 13/13 signals with gaps of 77+. FRESH 17/18, and 16/18 on an
  identical rerun: near 50% confidence Jev is a coin flip and lands differently
  run to run. Every wrong answer seen had confidence 49% or lower, so a floor
  near 55% catches them all.
- **Jev does not know what "jumpy" or "far above" means unless told**
  (`probe4.mts`). With the lines removed from the criteria, gaps collapsed:
  falling-fast +86 to +3, sparse food log +85 to +13, and a 125% day was called
  a blowout at 72%. The definitions live in OUR criteria, in plain English.
  Jev applies them; it does not supply them.
