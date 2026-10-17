# Drona adaptive maintenance

Owner's ask (2026-10-17): do what good calorie apps do. Start from a guess,
let weigh-ins and food logs move it to the person's real number, adapt the
calorie goal to it, and ask for a weigh-in when the number needs one.

## How good apps do it (and what we copied)

1. A number on day 1 from a formula, then corrected by data.
2. A smoothed trend weight, never a single weigh-in.
3. Energy maths: maintenance = average intake + what the trend lost (7,700 kcal/kg).
4. Careful with bad data: unlogged days left out, slow change, judged on what
   was eaten (not the target), wearable calories ignored.
5. A weekly check-in that sets calories from maintenance and a safe pace.

## The engine (facts, domain `energy`, `m_*` on the week row)

Migrations `20261017115750_drona_energy_facts`, `..115842_no_formula_start`,
`..120446_trend_restart`, `..120549_safeupdate`.

| Piece | Rule |
|---|---|
| guess | the app's own formula (`lib/onboarding.ts maintenanceKcal`): Mifflin-St Jeor x 1.4 / 1.5 / 1.6 by planned sessions, on 25. No birth date: no guess, start from data once a week's data weight reaches 0.5 |
| trend weight | each kept reading moves it by 1 - 0.9^(days since the last kept one) |
| outlier | further than 2.5 kg + 0.1 kg per day of gap: moves nothing, unless the next reading agrees within 1 kg. Then the trend restarts at the new level, and the rate is read only from the restart (a new scale is not weight gain) |
| rate | trend change over the 28-day window, kg a week; needs 14+ days and 2+ kept readings |
| observed | average kcal on whole days in the window (logged, not under half the target) - rate x 1100 |
| data weight | min(1, kept/8) x min(1, span/21) x min(1, whole days/14); 0 when outliers outnumber kept readings |
| estimate | previous + half the gap x data weight, at most 150 kcal a week |
| source | guess (no data used), learning (under 3 full weeks of data), measured |

## Signals and behaviours (rule_version 2)

| Signal | Judged when | Fires when |
|---|---|---|
| `maintenance_unknown` | a goal 0.5+ kg from the trend weight, and 1+ weigh-in or 3+ food days | data weight under 1, or no weigh-in in the last 10 days of the window. Says what is missing: weigh-ins, stale, scale (2+ outliers outnumbering kept), whole days |
| `calories_off` | source learning or measured with 1+ data week; a goal 0.5+ kg away; a kcal target; 14+ days since the last target change; a weigh-in in the last 10 days | the target is 100+ kcal from: estimate + pace x 1100 on 25, never under resting energy (rounded up to 25). Pace = the program date's, kept inside 1% a week down / 0.5% up, else 0.5% down / 0.25% up (the app's own pace defaults) |

| Behaviour | Card |
|---|---|
| `finding_maintenance` (14) | request, the first week it fires (asking for data changes nothing) |
| `calories_off` (16) | act: the app's existing "Set X kcal" card with Undo, after 2 weeks |
| `maintenance_found` (80) | steer: the number, for the next plan |

## The cards (`_shared/dronaEnergy.ts`, wired into `drona-cards`)

Runs after the swap and before B1. Reads `get_drona_energy_facts`, which
rebuilds the facts first when the daily job has not reached the person yet
(Monday's card must read the week that just ended).

- calories_off: Pro only (like B1). Step at most 200 kcal toward the
  suggestion, on 25, never under the floor, only when 100+ kcal apart. Uses
  the live target, so Undo's four numbers match the profile.
- finding_maintenance: weigh-in card when weigh-ins are missing or stale (or
  the scale looks off), else a whole-days food card.
- A topic on cooldown, or muted by `topic_not_landing`, is skipped.

No app build: both cards are kinds the app already shows. **Not deployed**:
the SQL is live, the edge function needs `deploy:yes` or a manual run.

## Proof

- `scripts/drona-facts/energy.mts`, 14 checks: from a 2500 guess to a true
  2000 in capped steps, an outlier ignored, a scale jump read as a level, the
  card read rebuilding stale facts. Moving the 150 cap to 200 live made 6 fail.
  It also found a real bug: through the API a bare DELETE is refused, so the
  card worker's rebuild would have failed silently (fixed: `where true`).
- `scripts/drona-facts/steering-behaviours.mts`, 40 checks, now on the v2 lines.
- `supabase/functions/_shared/dronaEnergy.test.ts`, 14 tests. Breaking the
  200 step cap failed 2; the floor rounding 1; the food card's words 1.
- `scripts/drona-facts/energy-cards-dryrun.mts`: what each person would get, read only.

## First run (2026-10-17)

- Last week: 40 people on the guess, 10 with no body numbers, 2 learning, 1 measured.
- One person shows the whole idea: the formula said 2,550; their food and
  weigh-ins said about 1,900; the estimate walked down to 2,087 in four weeks.
- The owner's 81.65 kg weigh-in (15 Sep, 8.6 kg over August) is an outlier; the
  trend stays 72.6.
- Dry run this week: 3 cards. The owner gets "log whole days" (weigh-in cards
  are muted after two went unanswered); two others get "three mornings on the scale".
- `calories_off` fired once in 26 weeks (fresh data is rare): the owner, 17
  Aug, 1,800 to 1,700.

## Open

- B1 (the model's cut card) still runs when this one holds; they share the
  `calories` cooldown. Retire B1 once this one has run a few weeks?
- Macros on a calorie change scale with the old split (`macros_for_kcal`), so
  protein drops on a cut. A protein-first split would be better.
- A "day complete" tap in the food log (needs an app build).
