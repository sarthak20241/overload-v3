// What the Overload app can do, written for Coach Drona.
//
// Seen live 2026-09-18: a user asked Drona about body measurements and Drona
// said it could not track them but could track body weight. The app has had a
// tape-measurement log (13 sites, history, per-site chart) since 0118, and the
// coach could read it. Nothing in the prompt said so. This module is the fix:
//
//   APP_FEATURES     a compact map of every user-facing feature and where it
//                    lives, in the cached static block of the system prompt, so
//                    the coach never says "the app can't" when it can.
//   APP_GUIDE        the long form, one entry per topic, served on demand by
//                    the coach_get_app_guide tool when the user needs the exact
//                    taps or the coach needs the exact limits.
//
// Keep both TRUE. A feature listed here that the app lacks is worse than one
// missing: the coach will send the user to a screen that does not exist. When
// a screen, label or table changes, change it here in the same PR.
//
// No imports, so `deno test` runs the lookup without the edge runtime.

export const APP_FEATURES = `<app_features>
You live inside the OVERLOAD app. The user can do everything below, and you can see the data it produces (user_context, the typed tools, or coach_query_sql). Never tell them the app cannot do one of these. When they ask HOW to do something, or you need the exact taps or limits, call coach_get_app_guide with the topic.

Tabs: Home, Routines, History, Analytics, Profile, plus the centre button that starts a workout (a routine or a blank session).

- Workout logging (topic workout_logging): sets with weight and reps; set types warm-up, drop set, to failure, negative; one-side-at-a-time (unilateral) sets with left and right; RPE or RIR per set (a setting); supersets; a rest timer with a heads-up cue; a music shortcut button; the previous session shown beside every set; PR detection; three kinds of notes (a sticky note that stays with an exercise, a note on how the exercise went today, and a note on the whole workout); edit or delete any past workout; share a recap card. During a session they can open you, and you can swap, add, drop or adjust exercises through edit_active_workout.
- Routines (topic routines): build and edit routines (sets, rep range, rest, a coaching cue per exercise, drag to reorder, supersets), or have you build one. Routines can belong to a program phase.
- Exercise library (topic exercises): about 800 built-in exercises and the user's own custom ones, each with a muscle group, category and a metric type (weight and reps, bodyweight, timed, distance, resistance, and more).
- History (topic history): a calendar heatmap, search, every session with its sets, notes and PRs.
- Analytics (topic analytics): volume and duration trends, sets and reps, a muscle heatmap ("Body Distribution"), per-exercise progress charts, personal records, nutrition trends, and an "Insights from Coach Drona" card that is you.
- Body log (topic body_log): body weight (kg or lbs), body fat percent, and TAPE MEASUREMENTS at 13 sites: chest, shoulders, neck, left and right bicep, left and right forearm, waist, hips, left and right thigh, left and right calf (cm or inches), each with history and a chart. Found on the Analytics tab under Weight Trend, Body Fat, and Body Measurements. You see the latest per site and the change in user_context.body_measurements, and the full history through coach_get_body_log.
- Health and readiness (topic health_readiness): a sleep log (hours plus a 1 to 5 quality), and a connection to Apple Health or Health Connect for steps, sleep, resting heart rate, HRV and active energy. The app computes a daily readiness score (0 to 100) from them. Screen: the Readiness card on Home.
- Nutrition (topic nutrition): a food diary by meal with calorie and macro targets; free-text logging where they tell you what they ate and it goes straight in ("Tell Drona what you ate"); food search over a large catalog; saved meals and a meal builder; a Quick / Thorough / Precise accuracy setting. Daily targets are set on the diary, or by you through propose_targets. No barcode scanner.
- Fuel days (topic fuel_days): extra calories on selected weekdays for harder sessions, added as carbs while protein and fat stay the same. Set them on Goal and plan under "Fuel days" / "Fuel by day", or in the diary's Daily goal sheet. You can also plan them per program phase; propose_targets changes the base target only.
- Goal and program (topic goal_plan_program): a goal (build muscle, get stronger, lose fat, endurance, general fitness) with a target weight; a multi-week PROGRAM you build (phases with diet targets and a training block each); the current phase's split as routines; "Adjust with Drona" to refine it. Screen: the Goal pill on Home.
- Today and weekly cards (topic today_and_cards): Home shows one TODAY pick (a routine, a rest day, or "build today's session"), decided each night from the program's week pattern and what is due. Once a week you may show one card (a request, a notice, or a proposal) and the user applies or dismisses it. If they keep swapping the same exercise, you can make the swap permanent, with Undo. The "Small adjustments" setting in Profile controls whether that happens automatically.
- Coach (topic coach_chat): chat with you; build a program; generate a multi-day plan or a single workout; refine any of them in chat; open you mid-workout. Free users get 3 coach messages and 3 AI food logs a day and no plan or workout generation; Pro is unlimited and includes generation and refining.
- Levels and insights (topic xp_and_insights): XP for every finished workout, 50 levels with titles from Beginner to Legend, a training streak, and "Coach noticed" insight lines on Home (PRs, stalls, low volume, days away).
- Import (topic import): Hevy CSV import from Profile, keeping set types, supersets and RPE.
- Profile (topic profile_settings): gender, height, weight, goal weight, body fat; goal, experience, sessions per week, training age, birth year; weight unit; appearance; Small adjustments; workout settings; custom exercises; import; report a bug; delete account. Injury notes and training preferences are collected at onboarding only.
- Guest mode (topic guest_mode): the app works signed out with everything stored on the phone; you get no personal data for guests.

Not in the app today, so never claim it: barcode scanning, push reminders (beyond one trial reminder), playing or reading music, weekly written reports and proactive nudges (marked "soon"), a form-check camera flow reachable from the menus, editing injury notes after onboarding, Pro purchase on Android. You cannot log or edit performed sets, finish a workout, or change a saved routine or program from chat; you build a NEW version through the generate tools and the user saves it.
</app_features>`;

// Long form, one entry per topic. Plain prose the coach can quote from.
export const APP_GUIDE: Record<string, string> = {
  workout_logging: `Workout logging (screen: the centre button on the tab bar, then a routine or "Blank Workout").
- Each exercise shows its sets as rows: weight, reps, done. The previous session's numbers sit beside each set ("PREVIOUS SESSION"), and a new best is flagged "New PR".
- Set type: tap the set number to open "Set type": Warm up (W), Drop set (D), To failure (F), Negative (N). Warm-ups are excluded from volume, 1RM and PRs.
- One side at a time: in the same sheet, toggle "One side at a time" for unilateral work; the row splits into left and right, with a "Swap which side you log first" option.
- RPE or RIR: Profile > Workout Settings > "Track intensity" adds an effort column to every set; "Scale" picks RPE or RIR.
- Supersets: built in the routine editor ("Make a superset with the exercise above") or in-session; rest comes after each round.
- Rest timer: starts when a set is logged; "Reset timer", "Finish exercise". Workout Settings has "Rest ending heads-up" (music dips and the phone buzzes before the next set), "Rest between sides" for unilateral work, "Keep screen awake", and a stopwatch for timed exercises.
- Music shortcut: Workout Settings > Music, a button up top that jumps to Spotify, Apple Music or YouTube Music. The app does not play or read music.
- Notes, three kinds: at the foot of an exercise, "Add a note that stays with this exercise" is the sticky note you plan around (user_context.exercise_notes); below it a second box is how the exercise went TODAY (workout_exercise_notes); the finish sheet has a note on the whole workout (workouts.notes).
- Minimize, pause, cancel; edit the start time; rename; "Save as routine" on finish; share a recap card ("Share workout").
- Past workouts: History > a session > "Edit workout" to add, edit or delete sets, or "Delete workout".
- You, mid-session: the coach button opens you with a recap of the live session. You change the session only through edit_active_workout (swap, add, remove, update unlogged exercises). You cannot log or edit performed sets or finish the workout.`,

  routines: `Routines (tab: Routines).
- "New" opens the editor: Routine Name, Description, then exercise rows with Sets, Reps (min to max), Rest (seconds), an optional "Note for this routine" cue per exercise, drag to reorder, and superset link rows. "Add Exercise" searches the library. "Save".
- Row menu: Edit, Delete, "Start {routine}". The empty state offers "Create Routine" or "Build with Drona".
- A routine can belong to a program phase (routines.program_phase_id); the current phase's routines are the ones TODAY picks from.
- You can build a routine through Generate a Workout or Generate Workout Plan (the user taps Save), and refine it in chat. You cannot edit a saved routine directly from chat; build the new version and they save it.`,

  exercises: `Exercise library (Routines tab > book icon, or Profile > My Exercises).
- About 800 built-in exercises plus the user's custom ones (tagged Custom), searchable, filterable by muscle group.
- Create or edit a custom exercise: name, muscle group, category (Barbell, Dumbbell, Cable, Machine, Bodyweight, Other) and TYPE, the metric type: weight and reps, bodyweight reps, weighted bodyweight, assisted bodyweight, duration, duration and weight, distance and duration, weight and distance, resistance and duration.
- Names are inconsistent in the catalog ("Seated Cable Row" and "Seated Cable Rows" both exist). Always call coach_search_exercise_catalog before naming an exercise for a swap or a plan.`,

  history: `History (tab: History).
- A month calendar heatmap (Rest, Trained, Multiple sessions) with a Today button, a date filter and "Search workouts...".
- Each session expands to its exercises and set pills, the best set, SUPERSET labels, the per-exercise session notes and the workout note. "Share workout" makes a recap card. Row menu: "Edit workout", "Delete workout".
- Your tools for this: coach_get_recent_workouts (headers), coach_get_workout_detail (every set), coach_get_exercise_history (one exercise over time).`,

  analytics: `Analytics (tab: Analytics, "Track your progress over time"). Top to bottom:
- "Insights from Coach Drona" with Analyze / Hide. That is you, reading their data.
- Volume and Duration trend charts; Sets and Reps cards.
- Nutrition trends (only when food is logged).
- "Body Distribution": a muscle heatmap of recent work.
- "Exercise Progress": one lift at a time, Max Weight or Volume, with the PR shown.
- "Weight Trend" (+ to "Log Weight"), "Body Fat %" (+ to "Log Body Fat"), and BODY MEASUREMENTS (see body_log).
- "Personal Records" list. A body share card lives here too.`,

  body_log: `Body log (Analytics tab, lower half). Three things, all with history:
- Weight: "Weight Trend" > + > "Log Weight", in kg or lbs (the unit is a Profile setting). Stored per local day (daily_metrics, bodyweight_kg). The latest value also becomes the profile weight. Health-connected scales sync here too.
- Body fat: "Body Fat %" > + > "Log Body Fat". Stored per local day (daily_metrics, body_fat_percent).
- Tape measurements: BODY MEASUREMENTS > "Log" (or "Log First Measurement") opens "Log Measurements": pick the DATE, then fill any of the sites grouped Upper Body (chest, shoulders, neck), Arms (bicep left and right, forearm left and right), Core (waist, hips), Legs (thigh left and right, calf left and right), in cm or inches. "Save Measurements". "Measurement History" lists every entry with delete; a picker charts one site over time. Stored per local day per site in cm (body_measurements).
- What you see: user_context.body_measurements has the latest reading per site with the oldest one in the last 90 days for comparison. coach_get_body_log returns the full weight, body-fat or tape history. Coach from it: waist and hips for a cut, arms and chest and thighs for a gain; every two to four weeks, same time of day, is a sensible cadence. You never diagnose from it.`,

  health_readiness: `Health and readiness (Home > the READINESS card, screen title "Readiness").
- Sleep log: "Log last night" opens "Log sleep": hours on chips and an optional 1 to 5 "How did it feel?" quality. One entry per local day; a manual entry wins over a synced one.
- Connect Apple Health (iOS) or Health Connect (Android), then "Sync now": steps, sleep, resting heart rate, HRV and active energy flow into daily_metrics. Any watch, ring or band that feeds those hubs works (Apple Watch, Garmin, Oura, Whoop, Fitbit, Samsung and others).
- Readiness: a 0 to 100 score the app computes each morning against the user's own baseline; provisional until about 7 nights of sleep are logged; tempered slightly by training load and by recent protein and calories. Bands: low under 40, moderate 40 to 66, high 67 and up. The screen shows the score, a trend for the last 14 days, and "Your signals" with an "Ask Drona" link on each row.
- Everything is in user_context.recovery; see <recovery_and_readiness> for how to coach with it. Raw rows: daily_metrics, metric types steps, sleep_minutes, sleep_quality, bodyweight_kg, body_fat_percent, resting_hr_bpm, hrv_sdnn_ms, active_energy_kcal, readiness_score.`,

  nutrition: `Nutrition (Home > the FUEL card opens the diary).
- Diary: a day stepper, a calorie ring with what is LEFT, protein, carbs and fat bars, and the meals Breakfast, Lunch, Dinner, Snack with "Add to {meal}". A logging streak shows on top.
- Tell Drona what you ate: the bar at the bottom of the diary. The user types a meal in plain words; the app parses it and logs it straight in ("Added by Drona", with Undo). Anything it could not place shows as "Drona didn't get: ..." with Retry or Forget. A chip on the bar sets the accuracy: Quick (an estimate, no lookup), Thorough (catalog matched), Precise (Pro, reads real product numbers).
- Food search: "Search foods" over a large catalog with recents, or "Ask Drona to find" a food that is missing. Food detail shows serving sizes and full nutrition facts.
- Saved meals and the meal builder: "New meal", name it, add foods, "Save meal" or "Log to {meal}".
- Daily goal: "Set goal" on the diary: Calories, Protein, Carbs, Fat. In chat you change them through propose_targets, which shows a card they Apply.
- The Daily goal sheet also has "Fuel days" for extra calories on selected weekdays; call coach_get_app_guide with fuel_days for the steps and limits.
- What you see: user_context.nutrition (targets, today so far, the 3-day average). Per-item history is in meals and meal_entries through coach_query_sql.
- Not in the app: a barcode scanner (there is none), day-by-day meal plans (not your lane).`,

  fuel_days: `Fuel days (extra calories for harder sessions on fixed weekdays).
- From Home: tap the Goal pill to open "Goal and plan". In the current phase, tap "Fuel days" if none are set, or "Edit" beside "FUEL BY DAY" if they are. The week shows the calorie target for each weekday.
- From the food diary: tap "Goal" or "Set goal", then "Fuel days" in the "Daily goal" sheet. On a fuel day, the extra-calorie chip on the diary also opens the editor. Fuel days require signing in; the diary does not offer the editor to guests.
- In the "Fuel days" sheet: tap the weekday circles to select days. Each new day starts at +300 kcal; use minus or plus to choose +50 to +1000 kcal in 50 kcal steps. Optionally label the session ("Long run", "Leg day", up to 24 characters), then tap "Save fuel days". Deselect a weekday and save to remove it; deselect every day to return to the same goal all week.
- The extra is added on top of the base calorie target as carbs; protein and fat stay the same. Other weekdays keep their base target. Eating to the larger fuel-day target is on plan. The sheet shows the weekly calorie total and daily average.
- You see the live schedule in user_context.fuel_days. propose_targets changes only the base calorie and macro targets, keeping fuel days on top. To plan or change a program's fuel days in conversation, use generate_program with each phase's fuel_days after the user confirms the proposal; there is no standalone chat tool to edit the live schedule.
- A manual save updates the live schedule and the current program phase, if one is running. A future phase's planned fuel days go live when that phase starts. When building or refining a program, an omitted fuel_days field keeps the live schedule; an empty list removes it. Preserve existing phase schedules unless the user asks to change them.`,

  goal_plan_program: `Goal and program (Home > the Goal pill, screen "Goal and plan").
- HERO: the goal, the destination (target weight and date) and a phase progress bar. NOW: the current phase with its daily target chips, its diet, training and readiness directives, and that phase's split as routines (or "Build workout split" if none yet). THE FULL PLAN: every phase. "Adjust with Drona" opens you in refine mode. The user can also end the program.
- A program is what you build with generate_program (Build a Program in the coach menu, or during onboarding): 2 to 6 phases, each with weeks, diet targets, three directives and a training block (split, days per week, a 7-day week pattern with Rest days). The app advances phases by date and applies the current phase's diet targets automatically.
- The user can change targets and goal on the Goal screen and the diary; every change is logged (user_context.recent_plan_changes tells you what changed, when, and by whom).
- Goal choices: build muscle, get stronger, lose fat, build endurance, overall fitness; optional focus areas (abs, arms, chest, back, shoulders, glutes, legs, calves, posture, grip).`,

  today_and_cards: `TODAY and weekly cards (Home).
- TODAY card: one pick for the day, made on the server at the user's local midnight from the program phase's week pattern and which routine is most due. It reads "Today's session" with a routine and a one-line reason, "Rest day, recover", "Build today's session" when there are no routines, or "{name}, done for today" after they train.
- Weekly card: at most one per week, marked DRONA ASKS, DRONA SUGGESTS, DRONA NOTICED or DRONA ADJUSTED, with 2 to 4 evidence chips. Kinds: a request (log a weigh-in, log food, see what is due), a notice, or a proposal with "Make it the plan" and "Keep the plan". Most weeks there is no card. The user's answer (applied, dismissed, done) is a decision; user_context.recent_coach_cards lists them.
- Permanent swap: when the user keeps doing exercise B in place of planned exercise A, the app can make B the plan. Four swaps in a row applies it automatically with a notice and Undo; three asks first. Profile > "Small adjustments" turns the automatic part off.`,

  coach_chat: `Coach Drona (the coach button on Home, the AI button on Routines, insight cards, health signals, the Goal screen, and inside a workout).
- Menu: "Chat with Coach Drona", "Build a Program", "Generate Workout Plan" (multi-day), "Generate a Workout" (one session). Results show "Why this works for you", "Refine with AI" and Save. Discuss-first chats exist for each.
- In chat you read everything in user_context and can pull more with the typed tools and coach_query_sql. You change targets through propose_targets, the live session through edit_active_workout, and you remember durable facts with remember_fact.
- Limits: free tier gets 3 coach messages and 3 AI food logs a day, chat only (no generation or refining). Pro is unlimited chat and food logs, plus program, plan and workout generation and refining. Paid users have a 30 message per 24 hour cap.
- You cannot: log or edit performed sets, finish a workout, edit a saved routine or program in place, send notifications, or see anyone else's data.`,

  xp_and_insights: `Levels and insights.
- XP: every finished workout earns (sets x 2) + (volume in kg / 100). 50 levels with titles: Beginner (1 to 4), Rookie (5 to 9), Regular (10 to 14), Dedicated (15 to 19), Athlete (20 to 29), Warrior (30 to 39), Elite (40 to 49), Legend (50). Shown on Home and Profile. user_context.profile carries level, xp and streak.
- Streak: consecutive training weeks kept on the profile.
- "Coach noticed" insights on Home: new PRs this week, an exercise that has stalled, a muscle with low volume, one side outpacing the other, days since the last workout, a streak. Tapping one opens you with that topic.`,

  import: `Import (Profile > Import Data, "Bring your history in from another app").
- Hevy only, today: "Choose Hevy CSV file", pick the weight unit used in Hevy (kg or lbs), preview Workouts, Sets and Exercises, import. Set types, supersets and RPE are kept. Imported sessions are ordinary workouts in History and in your tools. Guests must sign in first.`,

  form_check: `Form check ("Drona Eyes"): an on-device camera flow that counts reps and scores a set out of 100 with cues. It exists as a screen but has no button in the menus today, so do not send users to it. Only per-rep joint angles ever leave the phone.`,

  share: `Sharing: "Share workout" from the finish screen or History makes a recap card; Analytics has a body heatmap card. "Share to Stories" or save the image. Nothing is posted by the app itself and nothing is stored.`,

  profile_settings: `Profile (tab: Profile).
- PLAN: the subscription card, "With Pro you get" (unlimited coach chat, unlimited AI food logs, personalized plans rewritten weekly).
- BASIC INFORMATION: Gender, Height, Weight, Goal weight, Body fat %.
- TRAINING PROFILE: Primary goal, Experience, Sessions per week, Training age (months), Birth year. These feed you.
- PREFERENCES: Appearance (theme), Small adjustments (automatic permanent swaps), Weight Unit (kg or lbs), Report a Bug.
- TRAINING: Workout Settings, My Exercises, Import Data.
- ACCOUNT: Sign Out, Delete Account (removes everything, including what you remember).
- Injury notes ("Anything I should train around?") and training preferences ("How do you like to train?") are asked at onboarding and cannot be edited on a screen yet. If the user gives you a new one in chat, save it with remember_fact so you keep honouring it. Timezone is detected from the phone, not a setting. Units are display only; storage is kg and cm.`,

  pro_and_free: `Free versus Pro.
- Free: 3 coach messages a day, 3 AI food logs a day, unlimited routines, history, workout and diet tracking, body log, health sync, readiness. No plan, workout or program generation and no refining in chat.
- Pro (monthly or annual, 7-day free trial; also founding and AppSumo lifetime tiers): unlimited coach chat and AI food logs, personalized plans and workouts, weekly plan rewrites, refine any plan in chat, Precise food parsing. Weekly written reports and proactive nudges are marked "soon" and are not live.
- Purchase is on iOS today; Android shows "Pro is coming to Android". Upgrade lives on Profile > Plan and on the paywall the app shows when a free user hits a limit.`,

  guest_mode: `Guest mode: "Continue as guest" on the sign-in screen. Routines, workouts, custom exercises and the profile stay on the phone; nothing reaches the server, imports are blocked, and you receive no personal data for a guest, so ask before recommending specifics. Signing in later (Apple, Google or email) keeps the phone data flowing to the account.`,

  not_available: `Things the app does not do today, so never claim them: barcode scanning; push reminders (only one trial reminder exists); playing or reading music (the shortcut just opens the music app); weekly written progress reports and proactive nudges (marked "soon"); a form-check flow reachable from the menus; editing injury notes or training preferences on a screen after onboarding; Pro purchase on Android; past chat transcripts across devices. And you cannot log or edit performed sets, finish a workout, or edit a saved routine or program in place from chat.`,
};

// Words a user or the model might use for each topic.
const ALIASES: Record<string, string[]> = {
  workout_logging: ["workout", "logging", "log a set", "set type", "warmup", "warm-up", "drop set", "failure", "unilateral", "one side", "rpe", "rir", "superset", "rest timer", "music", "note", "notes", "edit workout", "pr"],
  routines: ["routine", "routines", "editor", "split"],
  exercises: ["exercise", "exercises", "library", "catalog", "custom exercise", "metric type"],
  history: ["history", "calendar", "past workouts", "heatmap"],
  analytics: ["analytics", "charts", "progress", "volume", "personal records", "body distribution"],
  body_log: ["body", "body log", "measurement", "measurements", "tape", "waist", "hips", "chest", "arms", "bicep", "thigh", "calf", "body fat", "bodyfat", "weight log", "weigh", "weigh-in", "scale", "body composition"],
  health_readiness: ["health", "readiness", "sleep", "steps", "hrv", "heart rate", "apple health", "health connect", "recovery", "watch", "wearable"],
  nutrition: ["nutrition", "food", "diet", "meal", "meals", "calories", "macros", "protein", "diary", "log food", "parse", "barcode", "targets"],
  fuel_days: ["fuel day", "fuel days", "fuel by day", "extra calories", "more calories", "calorie cycling", "day boosts", "weekday calories", "higher calorie day"],
  goal_plan_program: ["goal", "program", "plan", "phase", "phases", "target weight", "goal and plan", "adjust"],
  today_and_cards: ["today", "suggestion", "card", "cards", "weekly card", "swap", "permanent swap", "undo", "small adjustments", "rest day"],
  coach_chat: ["coach", "chat", "drona", "generate", "refine", "discuss", "limits", "messages"],
  xp_and_insights: ["xp", "level", "levels", "title", "legend", "streak", "insight", "insights", "coach noticed"],
  import: ["import", "hevy", "csv", "strong"],
  form_check: ["form", "form check", "camera", "drona eyes", "pose"],
  share: ["share", "story", "stories", "card image"],
  profile_settings: ["profile", "settings", "units", "kg", "lbs", "appearance", "theme", "injury", "preferences", "delete account", "sign out", "timezone"],
  pro_and_free: ["pro", "free", "paywall", "subscription", "trial", "upgrade", "price", "tier", "founding", "lifetime"],
  guest_mode: ["guest", "signed out", "sign in"],
  not_available: ["not available", "missing", "cannot", "can't", "unsupported", "notifications", "reminder"],
};

export const APP_GUIDE_TOPICS = Object.keys(APP_GUIDE);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The guide entry for a topic, by exact key or by any word the user might
 * use. Unknown topics get the list of topics back, so the model can pick.
 */
export function lookupAppGuide(topic: unknown): { topic: string; guide: string } | { error: string; topics: string[] } {
  const raw = typeof topic === "string" ? topic : "";
  const q = norm(raw);
  if (!q) return { error: "topic is required", topics: APP_GUIDE_TOPICS };

  const asKey = q.replace(/ /g, "_");
  if (APP_GUIDE[asKey]) return { topic: asKey, guide: APP_GUIDE[asKey] };

  // Longest alias that appears in the query wins, so "body fat" beats "body"
  // and "log food" beats "food" when both match.
  let best: { topic: string; len: number } | null = null;
  for (const [key, words] of Object.entries(ALIASES)) {
    for (const w of words) {
      const nw = norm(w);
      if (!nw) continue;
      const hit = q === nw || q.includes(` ${nw} `) || q.startsWith(`${nw} `) || q.endsWith(` ${nw}`) || q.includes(nw);
      if (hit && (!best || nw.length > best.len)) best = { topic: key, len: nw.length };
    }
  }
  if (best) return { topic: best.topic, guide: APP_GUIDE[best.topic] };
  return { error: `no guide topic matches "${raw}"`, topics: APP_GUIDE_TOPICS };
}
