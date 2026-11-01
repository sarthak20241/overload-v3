# Onboarding and first-week learning plan (2026-11-01)

Reference: the owner's Reshape screen recording (13 min, coach "Fio").
Builds on `future-plan-from-reshape.md` (same video, written 2026-10-31) and
`onboarding-redesign-plan.md` (the 16-step intake we ship today). Do not
re-litigate their locked rules: intake questions must change the plan, no
permission prompts in the intake, no sign-in wall or hard paywall before value.

## What Reshape does well (seen in the video)

1. **Shows before it asks.** Two short feature pages (Activity, Recovery),
   each with one big moving picture, before any question.
2. **The coach talks from the first screen.** "Hey, I'm Fio" plus a
   "Today's checklist 0/4" card: learn the app, finish setup, log a meal,
   hit today's targets.
3. **Every body question says why.** A small "Why do we need this?" link
   opens a sheet with one honest paragraph.
4. **The pace slider has a danger band.** It turns red with "Not
   recommended" past a safe rate, and the goal date updates live.
5. **Home opens one room at a time.** "Build your Home": Nutrition is open,
   the rest is locked. Each room has a 3-4 card lesson ("Nutrition 1 of 4"),
   then one real action. Doing it opens the next room ("Your next step").
6. **The first action is pointed at.** A pill "Log your first meal" sits next
   to the log button, then says "Log your next meal".
7. **Small wins get a moment.** After the first meal: "Want a reminder to
   log dinner tonight?" with a time picker. A streak page with a flame.

What Reshape does badly (do NOT copy): sign-in and phone number before value,
a paywall wall, empty orb-only screens, a plan that starts next week, and a
"saved" message in chat while the screen still says Save.

## What we already have

- 16-step intake, commit hold, build moment, plan reveal, phase 1 draft.
- Getting-started checklist on the dashboard (`lib/startGuide.ts`,
  `components/home/StartGuideCard.tsx`, first 21 days).
- Floating log button with a hint pill (`lib/homeLogHint.ts`).
- Pace slider and projected curve (`components/onboarding/PaceSlider.tsx`,
  `ProjectedCurve.tsx`), demo loop (`DemoLoop.tsx`).
- Commit confetti: now full screen and colourful (this branch).

The gap is not the intake. It is the first week: about 6 of 20 new users did
nothing after onboarding, and only 1 logged a real workout (2026-10-31 data).

## Plan, in order

### Phase 1. First-week path (the "learning into the app")
Turn the Getting-started checklist into a guided path, one step open at a time.
- Drona greets on the first home visit: one line, then the path card.
- Steps: Log a meal, Start your first workout, Check in your weight,
  Ask Drona one question. Each step: 2-3 swipe cards (what it is, why it
  matters, where to tap), then a button that opens the real screen.
- Doing the step ticks it and opens the next one ("Your next step").
- All steps done: full-screen confetti (reuse `CommitConfetti`) and a short
  Drona line. The card goes away.
- Nothing is locked. Tabs stay as they are. The path only suggests order.
- Done when: a fresh account walks all 4 steps on the sim, the path survives
  an app restart, and a step done elsewhere still ticks.

### Phase 2. Celebration kit
One shared set of moments, used everywhere a "first" happens.
- First meal logged: toast + one reminder offer for the next meal.
- First workout saved: full-screen confetti + the PR card if there is one.
- Streak day 3 and 7: small flame moment on the dashboard.
- One component, one rule file with tests, one analytics event per moment.

### Phase 3. Spotlight tips on first visit
- First time on Nutrition, Workout, Drona chat: dim the screen, light up the
  one control that matters, one sentence in coach voice, "Got it".
- Once per screen per device. Use a proven library (react-native-copilot or
  similar), not a hand-made mask.

### Phase 4. Intake polish
- "Why we ask" link and sheet on sex, age, height, weight, target.
- Red "Not recommended" band on the pace slider.
- Split the progress bar into 3 named parts (You, Your body, Your pace), so
  16 steps feel like 3.
- Optional: 2 feature preview pages before the first question, using
  `DemoLoop`. Test with real users first; it adds taps before value.

## Open decision

Which phase first. Recommendation: Phase 1, because the drop is after
onboarding, not inside it.
