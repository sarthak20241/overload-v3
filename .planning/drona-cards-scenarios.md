# Drona Card Scenarios: messages, indicators, data

Status: BRAINSTORM, 2026-09-16. Message-first. Supersedes the results framing in
`drona-cards-outcomes.md` for planning purposes (that file stays as background).

Each scenario is one kind of MESSAGE Drona can put on the card. For each:
- **Message:** what the user reads, in coach voice.
- **Buttons:** what the user can do.
- **If accepted:** exactly what changes.
- **Indicators:** the signals that must all be true.
- **Data:** what those indicators read. [F] in facts today, [D] in the database
  but not in facts, [N] not collected anywhere.
- **Model:** whether a model call is needed, and why.

Button sets used below:
- **Decide:** Apply / Talk it through / Not now. ("Talk it through" opens chat
  seeded with the card; the chat can apply a changed version.)
- **Ask:** Do it / Not now.
- **Question:** Answer / Not now. (Opens chat with the question.)
- **Note:** Got it.


## Decisions (owner, 2026-09-16)

1. **Two options on one card: yes** (A1-style "move the date, or reshape").
2. **Small changes may apply on their own: yes.** This is the handholding: the
   plan was right on day one, life is not. Drona notices small things and
   adjusts. Rules for what counts as small are in section H.
3. Structured goal fields: explained in section I; decision pending.
4. **Build order: Drona's call.** See section J.
5. **First three: B1, A1, C2.**
6. **New scenario family: Drona asks the user to use a feature** (log RIR, log
   sleep, take measurements), explains what it means, and offers to talk it
   through. Section G.

---

## A. Plan drift and the goal timeline

### A1. Drifted from the plan: move the date, or reshape the phases  *(your example)*
**Message.** "You have done 9 of the 20 sessions phase 2 asked for, and weight
is 1.4 kg behind where the plan expected. At this pace 68 kg lands in late
February, not December. Two ways back: move the goal date to 28 Feb, or stretch
phase 2 by 3 weeks and trim phase 3's calories by 100. Which suits you?"
**Buttons.** Decide, with the two options as separate Apply buttons.
**If accepted.** Option 1: `coach_programs.target_date`. Option 2: current phase
`duration_weeks`, later phases' `start_offset_weeks`, phase 3 diet targets.
**Indicators.**
- sessions done under 70% of planned across the phase so far (at least 3 weeks in)
- projected goal date (from the weight slope) 4+ weeks past the target date
- weight data trustworthy: 6+ weigh-ins in 14 days
- no plan change in the last 14 days
**Data.** sessions vs planned per phase [D], weight slope [F], target weight [F],
target date [D], phase dates [D], plan change log [N].
**Model.** Yes. Choosing between "move the date" and "reshape the phases", and
sizing the reshape, depends on how far behind, what the user changed before,
and what they said in past talks.

### A2. Ahead of the plan
**Message.** "You are 1.8 kg ahead of plan with 5 weeks left in this phase. Keep
the date and finish early, or bring the goal forward to 20 Nov?"
**Buttons.** Decide. **If accepted.** target date, or phase durations.
**Indicators.** projected date 3+ weeks before target; sessions at or above 90%
of planned; weight trend moving the right way for 3+ weeks.
**Data.** as A1. **Model.** Yes, to size the change.

### A3. A phase mostly missed
**Message.** "Phase 1 ended with 5 of 16 sessions done. Starting phase 2 now
builds on a base that is not there. Run phase 1 again for 2 weeks first?"
**Buttons.** Decide. **If accepted.** insert or extend the phase; shift later phases.
**Indicators.** phase ended; under 50% of its planned sessions done.
**Data.** phase dates [D], sessions per phase [D]. **Model.** Optional; rules can
propose "repeat 2 weeks", the model can tailor.

### A4. Program finished
**Message.** "Your 12-week cut is done: down 5.2 kg, bench up 7.5 kg. Want to
build the next block together?"
**Buttons.** Question (opens the program builder chat).
**Indicators.** past the last phase's end date. **Data.** phase dates [D], weight
change over the program [D], lift change over the program [D]. **Model.** Yes
for the next block (existing generate_program).

### A5. The week no longer fits your life
**Message.** "For 5 weeks you have trained 3 days, never the 5 the plan asks.
A 3-day split built for your goal will do more than a 5-day plan done at 60%.
Rebuild the week as 3 days?"
**Buttons.** Decide. **If accepted.** phase `week_pattern`, rebuild the split.
**Indicators.** done under 70% of planned for 4+ consecutive weeks, and a
steady actual frequency (same count most weeks).
**Data.** weekly planned vs done for 8 weeks [D], weekdays trained [D].
**Model.** Yes; rebuilding the split is generate_plan.

---

## B. Calories and macros

### B1. Logging well, weight not moving: lower calories  *(your example)*
**Message.** "You have logged 12 of 14 days, mostly within 100 kcal of 2100,
and weight has held at 72.4 kg for 2 weeks. We already went from 2250 to 2100
three weeks ago and it worked for a while. Let us try 2000."
**Buttons.** Decide. **If accepted.** current phase diet targets + profile targets.
**Indicators.**
- goal is loss (cut)
- food logged 9+ of 14 days, 70%+ of them within 10% of target
- weight slope flat (above -0.15 kg/week) with 6+ weigh-ins
- last calorie change 14+ days ago
- the proposed target stays above a safety floor (sex, weight, 10% max step)
**Data.** food days and on-target days [F], weight slope [F], targets [F],
target change history with dates and old values [N], safety floor inputs
(sex, weight, height, age) [D].
**Model.** Yes. It weighs the size of the step against past changes ("2250 to
2100 worked for 2 weeks"), the user's edits (did they raise it back by hand?),
and talk answers ("I eat out on weekends").

### B2. Losing too fast: raise calories
**Message.** "Down 1.3 kg a week for 3 weeks. That speed costs muscle. Let us
add 150 kcal and aim for about 0.6 kg a week."
**Indicators.** cut goal; slope below -1.0 kg/week or over 1% of bodyweight per
week for 3 weeks; 6+ weigh-ins. **Data.** as B1. **Model.** Yes, to size it.

### B3. Consistently over target: fix the gap, not the number
**Message.** "Most days land around 2450 against a 2100 target, and the weekends
carry most of it. Lowering the number will not help. Would a 1900 weekday /
2600 weekend split be easier to hit?"
**Buttons.** Decide or Question.
**If accepted.** weekday and weekend targets (a new target shape [N]).
**Indicators.** food logged 9+ of 14; 50%+ of days over target by 10%; the gap is
concentrated on specific weekdays.
**Data.** kcal per day with weekday [D], weekday/weekend targets [N].
**Model.** Yes; strategy, not arithmetic.

### B4. Protein short
**Message.** "Protein has averaged 95 g against 150 g. On a cut that costs muscle.
Here are 3 swaps from foods you already log that add about 45 g."
**Buttons.** Ask (open food) or Talk it through.
**Indicators.** food logged 9+ of 14; mean protein under 80% of target.
**Data.** protein per day [F], most-logged foods [D]. **Model.** Yes, for
suggestions from the user's own foods.

### B5. Bulk not gaining / gaining too fast
**Message.** "Weight has not moved in 3 weeks of logging 2900. Add 200 kcal." or
"Up 0.9 kg a week. Most of that is not muscle. Take 150 kcal off."
**Indicators.** gain goal; slope under +0.1 or above +0.5 kg/week; food logged.
**Data.** as B1. **Model.** Yes.

### B6. Cannot tell: logging or eating?
**Message.** "Weight is flat, but only 4 days of food are logged. Is that
eating off the log, or are the logs right and the scale stuck?"
**Buttons.** Question. The answer is stored and decides next week's card.
**Indicators.** weight goal; weight flat with 6+ weigh-ins; food logged 1 to 8 of 14.
**Data.** as B1, plus talk answers [N-column exists, write path N].
**Model.** Yes for the conversation.

---

## C. Training program changes

### C1. A goal-critical exercise keeps getting skipped  *(your example)*
**Message.** "Your goal is visible abs by March, and on leg day the ab work has
been skipped 5 sessions in a row. I will move 1 ab exercise to the start of leg
day and cut the last squat set, so the session stays the same length."
**Buttons.** Decide.
**If accepted.** routine exercises: add or reorder an exercise, change sets on another.
**Indicators.**
- the goal names a body area or look (goal_detail mentions abs, or the program
  objective does)
- exercises for that muscle were planned in a routine but done in under 40% of
  the sessions of that routine, 4+ sessions
- the rest of the session was done (so it is skipping, not a short day)
**Data.** routine exercises per routine [D], sets done per exercise per session
[D], goal detail and program objective text [D], muscle group per exercise [D]
(quality gap: many customs are "Other").
**Model.** Yes; which exercise, where in the session, what to trim.

### C2. An exercise always swapped for another
**Message.** "You swap Barbell Row for Chest-Supported Row every time. Make it
the plan?"
**Buttons.** Decide. **If accepted.** replace the exercise in the routine.
**Indicators.** the planned exercise was replaced by the same other exercise
(same muscle) in 3+ sessions of that routine.
**Data.** planned vs performed exercise per session [D]. **Model.** No; the swap is known.

### C3. A lift has stalled
**Message.** "Squat has held at 100 kg for 5 sessions. Switch to 3 sets of 5 at
92.5 kg for 2 weeks, then build back up?"
**Buttons.** Decide. **If accepted.** that exercise's sets and rep range in the routine.
**Indicators.** same top estimated 1RM (within 2%) for 4+ sessions; sessions to
plan (not a consistency problem); recovery not low.
**Data.** e1RM history per exercise [D], rep ranges in the routine [D],
readiness [F]. **Model.** Yes, for the scheme and load.

### C4. Sessions always cut short
**Message.** "Most push days end after about 40 minutes, with the last 2
exercises undone. A 40-minute version that keeps the big lifts?"
**Buttons.** Decide. **If accepted.** trim the routine.
**Indicators.** sets done under 70% of routine sets in 3+ sessions of a routine;
the undone sets are the same tail exercises.
**Data.** sets done vs planned per session [D], session duration [D], time
available preference [N]. **Model.** Yes, to choose what stays.

### C5. Muscle balance off for the goal
**Message.** "Back got 4 sets a week for a month while chest got 16. Add 2 back
exercises to pull day?"
**Indicators.** a pair ratio over 2 for 4 weeks; both muscles trained.
**Data.** weekly sets per muscle [D]. **Model.** Yes, for the change.

### C6. Progressing fast
**Message.** "Bench is up 10 kg in 4 weeks and every set hits the top of the
rep range. Raise the working weight 2.5 kg?"
**Indicators.** e1RM trend up; reps at the top of range in 3+ sessions.
**Data.** as C3. **Model.** No; progression rules can do it.

---

## D. Recovery

### D1. Low recovery under rising load: a lighter week
**Message.** "Readiness has been low 5 of the last 7 days while weekly sets went
up 30%. Take this week at about 60% volume, then pick back up."
**Buttons.** Decide. **If accepted.** insert a deload week (phase change, temporary).
**Indicators.** readiness under 40 on 5 of 7 days (7+ readiness days logged);
weekly sets 30%+ above the 4-week mean.
**Data.** readiness days [F] and low days [D], weekly sets trend [D].
**Model.** Yes, to shape the week.

### D2. Short sleep
**Message.** "Sleep averaged 5.6 hours this week. Keep the lifts, drop the last
set of each, until sleep comes back."
**Buttons.** Note, or Decide for a temporary change.
**Indicators.** mean sleep under 6 hours across 5+ logged nights.
**Data.** sleep nights and mean [F]. **Model.** No for the note.

### D3. No rest days
**Message.** "Eight days straight. Tomorrow is rest, and the plan is better for it."
**Buttons.** Note. **Indicators.** 7+ consecutive training days.
**Data.** training days sequence [D]. **Model.** No.

---

## E. Consistency and momentum

### E1. Plan waiting  **(P0 built)**
"Your plan is waiting. One session this week puts it back in motion."

### E2. Behind this week  **(P0 built)**
"The week is running ahead of you. Take the session that is due."

### E3. Back after a break
**Message.** "Welcome back after 12 days. Today's session is set 10% lighter
so it feels good, not punishing."
**Buttons.** Note (and the session preview applies the lighter load).
**Indicators.** first session after 10+ days. **Data.** gap between sessions [D].
**Model.** No.

### E4. Dropped off after a strong start
**Message.** "You trained 3 weeks right to plan, then 2 weeks of nothing. Did
something about the plan stop fitting?"
**Buttons.** Question. The answer is stored.
**Indicators.** 90%+ of planned for 3+ weeks, then under 30% for 2 weeks.
**Data.** weekly planned vs done [D]. **Model.** Yes for the conversation.

### E5. A win worth naming
**Message.** "Four weeks, every planned session. Bench up 5 kg and down 1.6 kg.
That is the plan working."
**Buttons.** Note. **Indicators.** 100% of planned for 4 weeks, or a PR, or a
milestone. **Data.** as above [D]. **Model.** No.

### E6. New here  **(P0 built)**
"You are new here. I am watching how your body answers before I change anything."

---

## F. Data honesty

### F1. Weigh in more  **(P0 built)**  ·  F2. Log food more  **(P0 built)**

### F3. The scale stopped syncing
**Message.** "Your weight came in every morning from Apple Health, and nothing
for 9 days. Open Health once so I can see the trend again."
**Indicators.** 10+ hub weigh-ins in the prior 28 days, none in the last 7.
**Data.** source per weigh-in [D]. **Model.** No.

### F4. A missing day
**Message.** "Yesterday has no food at all. Skipped the day, or skipped the log?"
**Buttons.** Question (two quick answers).
**Indicators.** a regular logger (12+ of 14 days) with one empty day.
**Data.** food days [F]. **Model.** No; two fixed answers.

---

---

## G. Use a feature: Drona asks, explains, and shows where it is

The app already does more than most people find. When a feature would make
this phase work better, Drona asks for it, says what it is in one line, points
to where it lives, and offers to explain.

Buttons for all of G: **Show me** (deep link to the exact place) / **What is
this?** (opens chat seeded with the feature and why it matters now) / **Not now**.

### G1. Log RIR this phase
**Message.** "This phase runs on effort, not just weight: the plan says stop 2
reps short of failure. Turn on RIR (reps left in the tank) so I can tell a hard
set from an easy one. It is one tap in workout settings."
**Show me.** Opens a workout's settings sheet with the intensity row in view.
**Indicators.**
- the current phase's training directive mentions RIR, RPE or effort
- 4+ sessions in the phase, and under 20% of their working sets carry an RPE/RIR value
- not asked in the last 6 weeks
**Data.** phase training directive text [F-adjacent, D], `workout_sets.rpe`
coverage per phase [D], whether the intensity column is switched on
(stored on the phone only [N] on the server).
**Model.** No for the card. Yes if the user taps "What is this?".

### G2. Take measurements on a recomp
**Message.** "On a recomp the scale barely moves while your body changes. A tape
at the waist every 2 weeks shows what the scale cannot."
**Show me.** Analytics, Body Measurements, Log.
**Indicators.** goal is recomp, or weight flat on a cut while lifts rise; no
measurement in 28 days. **Data.** measurement days [F], goal [F], lift trend [D].

### G3. Log sleep (no wearable)
**Message.** "Readiness needs sleep to read you. Logging last night takes ten
seconds, and I will start adjusting hard days around it."
**Show me.** Dashboard, Readiness, Log last night.
**Indicators.** no sleep rows in 14 days; no Health connection; training 3+ days a week.
**Data.** sleep days [F], hub connection [D].

### G4. Connect Apple Health or Health Connect
**Message.** "You log weight by hand most mornings. Connect Health and your
scale, steps and sleep arrive on their own."
**Indicators.** 8+ manual weigh-ins in 14 days; no hub rows ever.
**Data.** weigh-in source [D].

### G5. Tag your custom exercises
**Message.** "7 of your exercises have no muscle group, so I cannot see if back
is getting enough. Tag them once."
**Indicators.** 5+ custom exercises with muscle group "Other" that were used in 28 days.
**Data.** exercises with owner and muscle group [D].

### G6. Use set types for your drop sets
**Message.** "Your leg day has drop sets written in the notes. Mark them as drop
sets and your volume and PRs will count them properly."
**Indicators.** routine or set notes mention "drop" or "superset", and no sets
carry that type. **Data.** notes [D], set_type [D].

### Guardrails for G
- One feature ask at a time, and at most one G card every 3 weeks: a feature
  tour becomes noise fast.
- Never ask for a feature the user turned off on purpose after using it.
- The ask must name why THIS phase or goal needs it. "Try RIR" with no reason
  is an ad, not coaching.

Data to add for G: **feature usage flags on the server** [N]. Today the
intensity-column preference lives only on the phone. A small `user_features`
record (feature, first used, last used, turned off) lets Drona tell "never
found it" from "tried it and turned it off".

---

## H. Small changes Drona may make on its own

A change may apply without a tap only when ALL of these hold:
- **Same intent.** It keeps the plan's goal and the phase's purpose.
- **Small.** One exercise, one set, one load step, or one day. Never calories,
  never the goal date, never days per week, never a whole phase.
- **Reversible in one tap.** A notice card says what changed and has **Undo**.
- **Earned.** Based on something the user already did repeatedly, not a guess.
- **Safe.** Never overrides an injury note, never adds load on a low-readiness day.
- **Switchable.** One setting, "Let Drona make small adjustments", on by default
  for new plans. Off means these become Decide cards instead.

| # | Small change | Trigger | Card after it applies |
|---|---|---|---|
| H1 | Make a swap permanent | the same exercise replaced the same way 4+ times | "You always do Chest-Supported Row here, so it is in the plan now. Undo" |
| H2 | Raise the working weight one step | every set at the top of the rep range, 2 sessions running, readiness not low | "Bench goes to 62.5 kg next push day. You earned it. Undo" |
| H3 | Lighter first session back | first session after 10+ days | "Today is set 10% lighter to ease back in." (today only) |
| H4 | Drop the last set on a bad day | readiness under 35 today, or under 5 h sleep logged | "Rough night. Today's session keeps every lift and drops the last set." (today only) |
| H5 | Reorder a skipped goal exercise earlier | a goal exercise at the end of a session skipped 3+ times | "Abs now open leg day, when you have the energy for them. Undo" |
| H6 | Move a missed session | a scheduled session missed yesterday, today is a rest day | "Missed yesterday's Pull B. It is today instead, rest moves to tomorrow. Undo" |
| H7 | Adjust a rest timer | the user overrides the rest time by the same amount 5+ times | "Rest on squats is 150 s now, like you take it. Undo" |

Not small, always a Decide card: calories or macros, goal date, days per week,
adding or removing a whole exercise, anything touching a future phase.

Data to add for H: **plan change log** (who: drona_auto, drona_card, chat,
manual; before and after) [N], **routine edit history** [N], **rest timer
overrides** [N, phone only today], **the adjustments setting** [N].

---

## I. Question 3 explained: structured goal fields

Today a goal is saved as free text, like "get six pack abs by March". A person
reads that easily. The rules cannot: they cannot reliably pull out "abs" or
"March", so C1 (the skipped ab work) would have to guess.

"Structured" means storing the same goal as separate answers:
- **Goal type:** fat loss, muscle gain, strength, recomp, endurance.
- **Focus areas:** abs, arms, glutes, back, and so on. Pick any.
- **Target:** a weight, a body fat percent, a lift, or a look.
- **By when:** a date, or none.

With these, C1 becomes "focus area includes abs, and ab exercises get skipped",
which rules can check exactly. The user would pick focus areas once, on the
Goal screen or in onboarding. The free-text goal stays for Drona to read.

Decision needed: add focus areas and a target date as fields?

---

## J. Build order (Drona's call)

1. **Plan change log** and **routine edit history.** Every act card and every
   small change needs "what changed before" and "who changed it". Build first,
   because data only starts accumulating once the log exists.
2. **C2 / H1, the permanent swap.** BUILT 2026-09-18 (migration 0124,
   `_shared/dronaSwap.ts`, drona-cards v3). A run of 4 sessions applies itself
   and the notice carries Undo; a run of 3, or the setting off, asks first.
   The "Small adjustments" toggle is on the Profile screen.
3. **B1, calories when logging is good but weight is flat.** BUILT 2026-09-19
   (migration 0130, `_shared/dronaCalories.ts` + `dronaModel.ts`, drona-cards
   v7). The first model act card. Rules gate the week and set the anchor
   (10% or 150 off, whichever is less; floor = Mifflin-St Jeor); the model
   answers `propose_targets` or `hold` in one forced tool call; the validator
   has the last word; a refusal is stored as a held row with the reason.
   Eval: `scripts/drona-eval/run.mts`.
4. **A1, drift from the plan, with two options.**
5. **G1, log RIR.** Cheap, no model, and teaches the pattern for feature asks.
6. Then by value: H2, B2, B6, E3/H3, D1.

## Data we would need to start collecting  [N]

Most scenarios run on data already stored. These are the real gaps:

| Data | Needed by | Why |
|---|---|---|
| Plan change log: what changed, from what to what, when, by whom (card, chat, manual edit) | A1, A2, B1, B2, B5 | The model cannot say "we went from 2250 to 2100 and it worked for 2 weeks" without it |
| Routine edit history: exercise added, removed, swapped, sets changed | C1, C2, C4 | Tells "the user removed that on purpose" from "the user skips it" |
| Talk answers written back (the `summary` column's write path) | B6, E4, F4 and all model calls | Memory; stops the same question twice |
| Weekday / weekend calorie targets | B3 | A new target shape |
| Time available per session (a preference) | C4 | Trim to a real limit, not a guess |
| Goal detail as structured fields (target body area, look, event date) | C1, A1 | "Abs by March" is free text today |
| Custom exercise muscle group (ask when created) | C1, C5 | Many customs are "Other", which blinds balance and skip detection |

## What the model sees for any "Decide" card

- The indicators that fired, with their numbers.
- The plan: goal, target date, phases with targets, the current split.
- The plan change log (last 90 days), with who made each change.
- Routine edit history (last 90 days).
- The last 8 cards: kind, topic, what the user did, talk answers.
- Profile preferences and injury notes.
- Hard limits it may not cross: calorie step at most 10%, never below the
  safety floor, never more than 4 weeks of date movement in one card, and a
  validator checks every number before the card is stored.

## Decided 2026-09-17

1. **Structured goal fields: yes.** `user_profiles.goal_focus_areas` added in
   migration 0123 (PR #180); `goal_target_date` already existed. The picker on
   the Goal screen and onboarding is still to build.
2. **Small adjustments: on by default for everyone**, with a one-time card that
   explains it and a clear way to turn it off.

## Progress

- **J1 plan change log: BUILT, PR #180.** `plan_changes` recorded by triggers
  (targets, goal, program, phases, routines, routine exercises diffed by
  exercise), source from the x-change-source header via
  `lib/planChangeSource.ts`. Live, 26 + 7 probe checks.

## K. Where the card lives (brainstorm, 2026-09-18)

Owner's read after the first simulator run: the card takes dashboard space it
should not, and there is no way to say "later". Three questions, one proposal.

### K1. Popup or card?

| | Popup (centred, like BuildSplitPrompt) | Card under TODAY (today) |
|---|---|---|
| Dashboard space | none | a full card, every week |
| Attention | commands it; one decision, then gone | competes with TODAY, easy to scroll past |
| Cost to the user | an interruption on open | none |
| Fit by kind | right for a DECISION (act, talk) | right for a quiet read (notice, request) |

The kinds want different treatment. A popup that says "I changed Seated Leg
Curl into your plan" is an interruption with nothing to decide; a card that
says "should I drop your calories to 2000" is a decision hidden in a scroll.

**Decided 2026-09-18 (owner): every card is a popup.** The point of a card
is to bring something to the user's notice, and a strip does not do that.
The by-kind table below is kept as the alternative that was NOT taken.

**Alternative not taken: treat by kind.**

| Kind | First open of the week | After that |
|---|---|---|
| act / talk (a decision) | centred popup: Yes / No / **Later** | nothing on the dashboard; a badge on the Drona entry point |
| request (please do X) | one-line strip under TODAY, no popup | strip stays until done or dismissed; also listed in the inbox |
| notice (I adjusted X, **Undo**) | one-line strip under TODAY with Undo | Undo stays in the inbox for 7 days |

Guards: at most one popup per card, never two on one open (BuildSplitPrompt
wins, the card waits), never during an active workout, never on the first
open after install, never twice in a day.

### K2. "Decide later"

- Storage: `drona_cards.deferred_at timestamptz` (null = not deferred). No new
  status: a deferred card is still `pending`, it has just left the dashboard.
- The popup skips cards with `deferred_at` set. The inbox shows them.
- Shelf life: a card rests on last week's numbers. A deferred act card
  **expires on Sunday night** of its week (`expires_at`, already a column) and
  moves quietly to history as `expired`. Applying a stale card is worse than
  losing it: the swap's slot check already refuses a routine that moved on,
  and every act card must re-validate the same way before it applies.
- Copy on the popup's third button: **Later**, not "Remind me": Drona does not
  push notifications for this.

### K3. Where "later" goes: one screen, two entry points

A **From Drona** screen, reached from a row on Profile ("From Drona · 1
waiting") and a row on the Goal screen (it is about the plan). One list:

- **Waiting**: deferred and pending cards, each with its buttons live.
- **Done**: applied, undone, dismissed, expired, newest first, each with what
  it changed. Undo stays live for 7 days on an applied change.

This is also the **Plan history** screen decided on 2026-09-17: the change
diary (`plan_changes`) read through the cards that caused it, plus manual
edits as their own rows. One backlog item, not two.

### K4. Order

**BUILT 2026-09-18** (migrations 0127 + 0128, `DronaCardPopup`, `From Drona`
screen, rows on Profile and Goal). Verified on an iPhone 17 Pro Max end to end:
popup, Later, "1 waiting" on Profile, apply from the inbox, Undo from Done.

Build this BEFORE the next card (B1 calories): it decides how every card looks
and asks, and B1 is the first card with a real decision in it.

1. `deferred_at` + the popup for every kind, with **Later** on each. Tapping
   outside the popup counts as Later. The card under TODAY goes away.
2. The From Drona screen (Waiting + Done), rows on Profile and Goal.
