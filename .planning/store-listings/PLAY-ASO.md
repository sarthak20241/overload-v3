# Play Store reach plan (not screenshots)

Read from the live Play listing on 2026-10-25 through the Play Developer API.

## What is live now (com.overload.tracker)

- Title: `Overload: AI Coach & Tracker`
- Short: `A workout tracker with an AI coach that has seen every set you've ever logged.`
- Full: 1,736 of 4,000 characters. Training only.
- Languages: en-US only.
- Promo video: none.
- Production track: empty (1.0.2 / vc134 on internal, alpha, beta).

The old app `com.overload.gym` is still live in Production, titled
`Overload: Gym Workout Tracker`, with 30 translated listings.

## Gaps, biggest first

1. **The old app is still live.** A Play search for "Overload" finds two apps
   with the same name and icon. Ratings, installs and search rank split
   between them. Play cannot merge two packages.
2. **The title has no search words.** Play gives the title the most weight.
   "AI Coach & Tracker" says nothing a person types. "gym", "workout" and
   "log" are missing.
3. **Half the app is not in the listing.** Food logging, calories and macros,
   Drona's program, Health Connect (steps, sleep, heart rate, weight) and Hevy
   import are not mentioned. People who search "calorie counter" or "macro
   tracker" never see the app.
4. **2,264 characters unused** in the full description. Play reads this text
   for search.
5. **English (US) only.** India is a main market. An en-IN copy (same text)
   gets its own ranking there. en-GB and en-AU are free extra reach too.
6. **No in-app review prompt in 1.0.2.** Nothing asks happy users to rate.
   Ratings count and star average move rank and installs a lot. Fixed by
   PR #297; it shows from the next store build.
7. **No promo video.** Optional, but it plays at the top of the listing.
8. **Em dashes** in the live copy. Drop them.

Not added on purpose: the form checker. No screen in the app opens
`/form-check` today, so the listing must not promise it.

## New copy (paste into Play Console, en-US, then copy to en-IN, en-GB, en-AU)

### Title (30 max, 28 used)

```text
Overload: Gym Log & AI Coach
```

### Short description (80 max, 76 used)

```text
Workout tracker, gym log and calorie counter, with an AI coach who knows you
```

### Full description (4000 max)

```text
Overload is a gym workout tracker and calorie counter with a coach built in. His name is Drona. He reads every set you log and every meal you eat, then tells you what to do next.

Most trainers see a few of your sessions. Drona sees all of them.

TRACK EVERY WORKOUT

• Log sets, reps and weight in a few taps
• Rest timer that starts on its own
• Supersets, warm-up sets, drop sets and RPE
• Your last session shows on every exercise, so you know what to beat
• Personal records and estimated 1RM, saved the moment you hit them
• Build your own routines or start from a plan

A PROGRAM THAT ADAPTS

Tell Drona your goal in your own words: lose fat, build muscle, get stronger. He builds a multi-week program around your days, your gym and your injuries. With Pro, he rewrites it every week, so when you stall, miss a week or get stronger, the plan moves with you.

LOG FOOD THE EASY WAY

• Type what you ate, like "2 eggs and toast", and it is logged
• Calories, protein, carbs and fat for every meal
• A large food catalog, plus your own foods and saved meals
• Daily calorie and macro targets set from your goal
• Maintenance calories that update as your weight changes

SEE YOUR PROGRESS

• Strength trends for every lift
• Weekly volume by muscle group, so you see what is lagging
• Body weight against your goal
• Daily calories against your target
• A weekly report from Drona on what went well and what to fix

READS YOUR RECOVERY

Connect Health Connect and Overload reads your steps, sleep, resting heart rate, HRV and weight. Drona uses them to judge how recovered you are before he pushes you. Overload only reads this data. It never writes or changes it.

ASK DRONA ANYTHING

"Why is my bench stuck?" "What should I eat after training?" "Can I train legs with a sore knee?" Drona answers from your own numbers, not a generic article.

COMING FROM ANOTHER APP?

Import your workout history from Hevy in one step.

FREE TO START

Tracking workouts and logging food from the catalog is free, with 3 coach chats and 3 AI food logs per rolling 24 hours. Overload Pro gives you unlimited coach chat and AI food logs, and a plan rewritten every week. No ads. We do not sell your data. You can delete your account and all of your data from inside the app.

HEALTH DISCLAIMER

Overload is not a medical device. It does not diagnose, treat, cure, or prevent any medical condition. The AI coach gives training guidance, not medical advice. Always consult a doctor or other qualified healthcare professional for medical advice, diagnosis, or treatment, and before starting a new exercise or nutrition program.
```

Checked against the code on 2026-10-25:
- Free plan: 3 coach chats and 3 AI food logs per rolling 24 hours
  (`AI_LIMITS` in `supabase/functions/ai-coach/index.ts`). Pro adds the
  weekly plan rewrite (`PLAN_BENEFITS` in `lib/tiers.ts`). If these limits
  change, change the FREE TO START paragraph too.
- "A large food catalog": about 8,000 foods in production.
- Hevy import: `app/(app)/import.tsx`, enabled.

Keep the HEALTH DISCLAIMER paragraph. Play rejected an update without it
(2026-09-13).

## Old app: pick one

- **A. Unpublish `com.overload.gym` after the new app is in Production.**
  First ship one last update to it with a banner and listing line: "Overload
  has moved. Get the new app." with the new store link. Then unpublish it a
  few weeks later. Existing users keep the app; new searches only find the new
  one.
- **B. Keep both live.** Easy now, but the two apps fight for the same
  searches forever, and old-app reviews can confuse people.

Pick A.

## Code change for reach (PR #297)

In-app review prompt with `expo-store-review` (`lib/reviewPrompt.ts`,
`lib/storeReview.ts`). It asks after a workout with a PR, once the lifter has
3+ workouts over 3+ days, at most every 90 days. Play limits how often the
dialog shows, so a bad moment wastes it. It needs a new native build; an OTA
onto 1.0.2 stays silent.
