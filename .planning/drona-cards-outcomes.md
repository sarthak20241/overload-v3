# Drona Cards: Outcomes, Signals, Behaviours

Status: BRAINSTORM, 2026-09-16. Companion to `.planning/drona-cards-plan.md`.
Nothing here is built unless marked **P0 (built)**.

The method: start from the RESULT a card should produce for the user, then
list the signals that say the result is at risk, then the raw behaviours
(counts) those signals need. Build facts only for results we want. A count
nobody reads is cost with no card.

Card kinds used below:
- **request**: do this one thing, it is worth it.
- **notice**: I saw this. No change, no ask. Includes the new-user "watching".
- **celebrate**: a win worth naming (a notice with a warmer tone).
- **act**: I propose a change. Apply or not (P1, model).
- **talk**: I have a question before I change anything (P2, model).

Data status tags:
- **[F]** already in `get_drona_facts`.
- **[D]** in the database, not yet in facts.
- **[N]** not collected anywhere yet.

---

## 1. The end results

Six results, in priority order. The first two are why people pay.

| # | End result the user wants | Why it matters to the card system |
|---|---|---|
| R1 | My body moves toward my goal (fat loss, gain, recomp) | The main reason for a plan; most act cards live here |
| R2 | I get stronger | The second reason; progress is the proof the plan works |
| R3 | I stay consistent with the plan | Without it R1 and R2 cannot be judged at all |
| R4 | I recover well enough to train | Protects R2 and keeps people from quitting hurt or tired |
| R5 | My plan stays right for me | Plans go stale: dates drift, goals are reached, life changes |
| R6 | My data is honest enough to judge | Every other result is only as good as the logs under it |

Two cross-cutting results sit on top of all six:
- **Trust:** every card is true, checkable, and rare.
- **Momentum:** people come back after a break instead of quitting.

---

## 2. Each result: cards, signals, behaviours

### R1. Body moves toward the goal

**Cards**
| Kind | Example | Phase |
|---|---|---|
| request | "Step on the scale three mornings this week." | **P0 (built)** |
| request | "Log food five days this week." | **P0 (built)** |
| act | "Weight held for 2 weeks with intake on target. Drop to 2000 kcal." | P1 |
| act | "Losing 1.2 kg a week is faster than muscle likes. Add 150 kcal." | P1 |
| act | "Protein has been 60% of target. Here is a 150 g plan." | P1 |
| talk | "Weight is flat but food logs are thin. Eating off-log, or a real stall?" | P2 |
| celebrate | "Down 2.1 kg in 4 weeks, right on pace." | P1 |
| notice | "The trend flattened this week. Watching, not moving yet." | P1 |

**Signals**
| Signal | Rule idea | Built |
|---|---|---|
| weight_goal | goal is loss/gain/recomp, or a goal weight is set | **P0** |
| weight_none / weight_sparse | 0 in 28 d / under 6 in 14 d | **P0** |
| food_none / food_sparse | 0 / under 9 of 14 d, targets set | **P0** |
| weight_stalled | cut: 14 d slope > -0.15 kg/wk; bulk: < +0.10; needs 6+ weigh-ins | P1 |
| weight_too_fast | cut: < -1.0 kg/wk or > 1% of bodyweight/wk; bulk: > +0.5 | P1 |
| weight_wrong_way | slope sign opposite to the goal for 3+ weeks | P1 |
| kcal_on_target | 70%+ of logged days within 10% of target | P1 |
| kcal_over / kcal_under | 50%+ of logged days outside the 10% band | P1 |
| protein_low | mean protein under 80% of target on logged days | P1 |
| logging_partial | logged days with very low kcal (e.g. under 50% of target): likely one meal only | P1 |
| on_pace_to_goal | projected date from slope vs program target date | P1 |
| recent_target_change | targets changed under 14 d ago (suppresses act) | P1 |

**Behaviours**
| Behaviour | Source | Status |
|---|---|---|
| Weigh-ins in 14 / 28 d | daily_metrics bodyweight_kg | [F] |
| Weight slope 14 / 28 d | daily_metrics | [F] |
| Latest weight, goal weight, program target, target date | user_profiles, coach_programs | [F] (target date [D]) |
| Food days logged 14 / 28 d | user_nutrition_stats | [F] |
| Mean kcal, mean protein | user_nutrition_stats | [F] |
| Days within 10% of kcal target | user_nutrition_stats | [F] |
| Days under 50% of kcal target (partial logs) | user_nutrition_stats | [D] |
| Meals per logged day | meals | [D] |
| Days since the last target change | not tracked; derive from applied act cards | [N] |
| Body fat trend | daily_metrics body_fat_percent | [D] |
| Waist trend | body_measurements waist | [D] |

### R2. Get stronger

**Cards**
| Kind | Example | Phase |
|---|---|---|
| celebrate | "3 PRs this week. Bench is up 7.5 kg in a month." | P1 |
| notice | "Squat has held at 100 kg for 4 sessions. Watching one more week." | P1 |
| act | "Squat stalled 5 sessions. Swap to 3x5 at 92.5 kg for 2 weeks." | P3 |
| act | "Back got 4 sets this week, chest got 16. Add a pull day." | P3 |
| talk | "Your bench dropped 10% in two weeks. Sleep, food, or something hurting?" | P3 |

**Signals**
| Signal | Rule idea | Built |
|---|---|---|
| prs_this_week | top e1RM beat previous best | P1 |
| lift_stalled(exercise) | same top e1RM (within 2%) for 4+ sessions | P3 |
| lift_regressed(exercise) | e1RM down 7%+ across 3 sessions | P3 |
| muscle_neglected | a trained muscle group under 6 sets/wk for 2 weeks | P3 |
| push_pull_imbalance | chest:back or quads:hamstrings ratio over 2 | P3 |
| volume_trend | weekly working sets up or down 25%+ | P3 |

**Behaviours**
| Behaviour | Source | Status |
|---|---|---|
| Per-exercise e1RM history, top sets | workout_sets, user_lift_stats | [D] |
| PRs in the week | same math as weekly report 0090 | [D] |
| Sets per muscle per week | user_volume_stats | [D] |
| RPE per set | workout_sets.rpe | [D] |
| Exercises marked "Other" muscle | exercises | [D] (a data-quality gap) |

### R3. Stay consistent with the plan

**Cards**
| Kind | Example | Phase |
|---|---|---|
| request | "Your plan is waiting. One session puts it back in motion." | **P0 (built)** |
| request | "The week is running ahead of you. Take what is due." | **P0 (built)** |
| celebrate | "Every planned session for 4 weeks straight." | P1 |
| notice | "Back after 12 days. Go 10% lighter today." | P1 |
| talk | "You trained 3 weeks to plan, then stopped. Is the plan not fitting?" | P2 |
| act | "You finish 3 of 5 planned days most weeks. Move to a 3-day split?" | P3 |

**Signals**
| Signal | Rule idea | Built |
|---|---|---|
| new_user | under 14 d or under 6 sessions | **P0** |
| no_training | 7+ days since the last session | **P0** |
| sessions_missed | trained, but under 60% of planned | **P0** |
| streak_on_plan | 100% of planned for 4+ weeks | P1 |
| returning_after_break | first session after 10+ days | P1 |
| dropped_off | was on plan 3+ weeks, then under 30% for 2 weeks | P2 |
| plan_too_big | under 70% of planned for 4+ weeks, never above | P3 |
| off_plan | 2+ sessions in 14 d outside the phase split | P2 |
| short_sessions | done sets under 60% of routine sets, 3+ times | P2 |

**Behaviours**
| Behaviour | Source | Status |
|---|---|---|
| Sessions 14 / 28 d, total, first, last | workouts | [F] |
| Planned sessions (week pattern or weekly target) | coach_program_phases, user_profiles | [F] |
| Off-plan sessions 14 d | workouts, routines | [F] |
| Week-by-week planned vs done, 8 weeks | workouts | [D] |
| Sets done vs routine sets per session | workout_sets, routine_exercises | [D] |
| Session duration | workouts.duration_seconds | [D] |
| Which weekdays get skipped | workouts | [D] |

### R4. Recover well enough to train

**Cards**
| Kind | Example | Phase |
|---|---|---|
| notice | "Sleep averaged 5.4 h this week. Heavy days will feel heavier." | P1 |
| request | "Log sleep 3 nights so readiness can read you." | P1 |
| act | "Readiness low 5 days and volume up 30%. Take a lighter week." | P3 |
| talk | "Stalls plus low readiness plus short sleep. Is life extra busy right now?" | P3 |

**Signals**
| Signal | Rule idea | Built |
|---|---|---|
| recovery_unknown | under 3 readiness days in 14 (never "low") | P1 |
| sleep_short | mean sleep under 6.5 h over 5+ nights | P1 |
| readiness_low_streak | score under 40 on 5 of 7 days | P3 |
| load_spike | this week's sets 30%+ above the 4-week mean | P3 |
| overreaching | load_spike and readiness_low_streak and a stall | P3 |
| too_many_days_in_a_row | 6+ consecutive training days | P1 |

**Behaviours**
| Behaviour | Source | Status |
|---|---|---|
| Readiness days, mean | daily_metrics readiness_score | [F] |
| Sleep days, mean hours | daily_metrics sleep_minutes | [F] |
| Low readiness days | daily_metrics | [D] |
| Resting HR, HRV trend | daily_metrics | [D] |
| Weekly working sets, 4-week mean | workout_sets | [D] |
| Consecutive training days | workouts | [D] |
| Steps | daily_metrics steps | [D] |

### R5. The plan stays right

**Cards**
| Kind | Example | Phase |
|---|---|---|
| notice | "Phase 2 ends Sunday. Phase 3 starts leaner." | P1 |
| celebrate | "You hit 70 kg, 3 weeks early." | P1 |
| act | "You missed most of phase 1. Extend it 2 weeks?" | P2 |
| act | "Program done. Build the next block?" | P2 |
| talk | "Goal is 68 kg by December. At this pace it is February. Move the date, or the plan?" | P2 |

**Signals**
| Signal | Rule idea | Built |
|---|---|---|
| phase_ending_soon | 7 d or less left in the phase | P1 |
| goal_reached | latest weight at or past target | P1 |
| behind_schedule | projected date 4+ weeks past target date | P2 |
| phase_mostly_missed | under 50% of planned sessions across the phase | P2 |
| program_ended | past the last phase's end | P2 |
| no_program | no active program and 4+ weeks of training | P2 |

**Behaviours**
| Behaviour | Source | Status |
|---|---|---|
| Program, phase, week in phase | coach_programs, phases | [F] partly (week in phase [D]) |
| Phase end date, program end date | coach_program_phases | [D] |
| Target weight, target date | coach_programs | [F] / [D] |
| Phase-level planned vs done | workouts | [D] |

### R6. Data honest enough to judge

**Cards**
| Kind | Example | Phase |
|---|---|---|
| request | "Weigh in / log food" | **P0 (built)** |
| talk | "Yesterday has no food. Skipped a day, or skipped the log?" | P2 |
| request | "Your scale has not synced in 9 days. Open Health once." | P2 |
| request | "12 exercises have no muscle group. Tag them so balance reads right." | P3 |

**Signals**
| Signal | Rule idea | Built |
|---|---|---|
| hub_stale | HealthKit source rows stopped 7+ d after regular syncing | P2 |
| logging_partial | see R1 | P1 |
| untagged_exercises | 5+ custom exercises with muscle "Other" | P3 |

**Behaviours**
| Behaviour | Source | Status |
|---|---|---|
| Last hub sync per metric | daily_metrics source + date | [D] |
| Partial food days | user_nutrition_stats | [D] |
| Untagged custom exercises | exercises | [D] |

### Cross-cutting: Trust and Momentum

These are guardrails, not cards. Most are built in P0.
| Behaviour or rule | Status |
|---|---|
| Last 8 cards and their status | [F], cooldowns **P0 (built)** |
| Topic cooldown 2 weeks, 4 after a dismissal | **P0 (built)** |
| Thin data is unknown, never fires | **P0 (built)** |
| New user gets only the watching notice | **P0 (built)** |
| One card per week | **P0 (built)** |
| Dismiss rate per topic (tune thresholds) | [D] via drona_cards status, analysis later |
| Talk answers remembered (summary) | column exists, P2 |
| Injury notes present: never act on training, talk only | [D] user_profiles.injury_notes, P2 |

---

## 3. What is built today (P0)

| Layer | Built |
|---|---|
| Behaviours read | tenure, goal, program, sessions vs planned, off-plan, food days, kcal and protein means, on-target days, weigh-ins and slope, readiness, sleep, measurement days, last cards |
| Signals used | new_user, weight_goal, weight_none, weight_sparse, food_none, food_sparse, sessions_missed, no_training |
| Cards | notice: watching. request: due_session, weigh_in, log_food. hold |
| Results served | R1 (data asks only), R3 (consistency asks), R6 (logging asks) |

Several behaviours are already counted but no rule reads them yet: weight slope,
on-target days, mean kcal and protein, readiness, sleep, off-plan sessions,
measurement days. They are the cheapest next step.

---

## 4. Suggested next scope

Ordered by value for the least new data.

1. **P1a, no model, uses behaviours we already count.** celebrate and notice
   cards: PRs this week, consistency streak, goal reached, phase ending soon,
   sleep short, too many days in a row, returning after a break. Adds R2 and R4
   and the first warm cards, so the card is not only ever asking for something.
2. **P1b, the model, act cards for targets.** weight_stalled, weight_too_fast,
   kcal_on_target, kcal_over/under, protein_low, recent_target_change. This is
   the calorie example that started the feature.
3. **P2, talk cards.** logging vs eating, dropped off, behind schedule, phase
   mostly missed. Needs the summary write path.
4. **P3, training acts.** lift stalls, regressions, muscle balance, load
   spikes, lighter week. Needs per-exercise history in facts.

## 5. Open questions for the owner

1. Should celebrate cards exist, or does a win belong in the weekly report only?
2. How often may a card ask for something vs notice something? (A ratio keeps
   the card from nagging.)
3. Weight loss faster than 1% of bodyweight a week: warn (notice) or propose
   calories (act)?
4. When injury notes exist, should training cards stop entirely, or only act
   cards?
5. Is "sleep short" something Drona should comment on without a wearable, from
   manual sleep logs only?
