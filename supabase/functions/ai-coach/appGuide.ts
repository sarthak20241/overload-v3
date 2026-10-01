// One record per app topic. The always-present feature index is generated
// from summaries; detailed instructions and access rules are returned only
// when coach_get_app_guide is called. Keep instructions, aliases and source
// references current in the same PR as the feature they describe.
//
// Availability describes each action, rather than putting an entire topic
// behind the strictest requirement of one of its actions. Active trials and
// lifetime entitlements count as Pro access. These records describe the app;
// authorization continues to be enforced by the existing client/server gates.

import { AI_LIMITS } from "../_shared/aiLimits.ts";
import {
  FUEL_DEFAULT,
  FUEL_LABEL_MAX,
  FUEL_MAX,
  FUEL_MIN,
  FUEL_STEP,
} from "../_shared/fuelDays.ts";

export interface AppGuideAvailability {
  capability: string;
  signIn: "optional" | "required";
  /** free means no subscription is required; paid users can use it too. */
  subscription: "free" | "pro_or_trial";
  status: "available" | "unreachable" | "unavailable";
  /** Omitted when the same rule applies to both native platforms. */
  platforms?: readonly ("ios" | "android")[];
  notes?: string;
}

export interface AppGuideEntry {
  title: string;
  /** Short discovery text. Exact steps, labels and limits belong in instructions. */
  summary: string;
  aliases: readonly string[];
  availability: readonly AppGuideAvailability[];
  instructions: string;
  /** Maintenance references; these are not sent to the model. */
  sources: readonly string[];
}

export const APP_GUIDE = {
  workout_logging: {
    title: "Workout logging",
    summary:
      "Log sets, effort, notes and supersets; use rest timers, edit past sessions, share recaps and get coaching during a workout.",
    aliases: [
      "workout",
      "logging",
      "log a set",
      "set type",
      "warmup",
      "warmups",
      "warm ups",
      "warm-up",
      "drop set",
      "drop sets",
      "failure",
      "unilateral",
      "one side",
      "rpe",
      "rir",
      "superset",
      "supersets",
      "rest timer",
      "rest timers",
      "music",
      "note",
      "notes",
      "edit workout",
      "pr",
      "prs",
    ],
    availability: [{
      "capability": "Workout logging and editing",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Live workout coaching",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
      "notes": "Uses the free chat allowance; no Pro subscription required.",
    }],
    instructions:
      `Workout logging (screen: the centre button on the tab bar, then a routine or "Blank Workout").
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
- You, mid-session: the coach button opens you with a recap of the live session. You change the session only through edit_active_workout (swap, add, remove, update unlogged exercises). You cannot log or edit performed sets or finish the workout.
- Availability: manual logging works for guests and signed-in users. Personal live-workout coaching requires signing in and uses the free chat allowance or Pro/trial allowance; it does not require Pro.`,
    sources: [
      "app/workout/[id].tsx",
      "components/workout/WorkoutSettingsSheet.tsx",
      "supabase/functions/ai-coach/index.ts",
    ],
  },

  routines: {
    title: "Routines",
    summary:
      "Build, edit, reorder and start routines, including supersets, exercise cues and routines belonging to a program phase.",
    aliases: ["routine", "routines", "editor", "split"],
    availability: [{
      "capability": "Manual routine creation and editing",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "AI routine generation and refining",
      "signIn": "required",
      "subscription": "pro_or_trial",
      "status": "available",
    }],
    instructions: `Routines (tab: Routines).
- "New" opens the editor: Routine Name, Description, then exercise rows with Sets, Reps (min to max), Rest (seconds), an optional "Note for this routine" cue per exercise, drag to reorder, and superset link rows. "Add Exercise" searches the library. "Save".
- Row menu: Edit, Delete, "Start {routine}". The empty state offers "Create Routine" or "Build with Drona".
- A routine can belong to a program phase (routines.program_phase_id); the current phase's routines are the ones TODAY picks from.
- You can build a routine through Generate a Workout or Generate Workout Plan (the user taps Save), and refine it in chat. You cannot edit a saved routine directly from chat; build the new version and they save it.
- Manual routine editing is free and works for guests. AI generation, discussion and refining require sign-in plus Pro or an active trial.`,
    sources: ["app/(app)/routines.tsx", "components/ai/AICoachModal.tsx"],
  },

  exercises: {
    title: "Exercise library",
    summary:
      "Search the exercise library or create custom exercises with their own muscle group, category and metric type.",
    aliases: [
      "exercise",
      "exercises",
      "library",
      "catalog",
      "custom exercise",
      "metric type",
    ],
    availability: [{
      "capability": "Exercise library and custom exercises",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }],
    instructions:
      `Exercise library (Routines tab > book icon, or Profile > My Exercises).
- About 800 built-in exercises plus the user's custom ones (tagged Custom), searchable, filterable by muscle group.
- Create or edit a custom exercise: name, muscle group, category (Barbell, Dumbbell, Cable, Machine, Bodyweight, Other) and TYPE, the metric type: weight and reps, bodyweight reps, weighted bodyweight, assisted bodyweight, duration, duration and weight, distance and duration, weight and distance, resistance and duration.
- Names are inconsistent in the catalog ("Seated Cable Row" and "Seated Cable Rows" both exist). Always call coach_search_exercise_catalog before naming an exercise for a swap or a plan.`,
    sources: [
      "app/(app)/exercises.tsx",
      "components/routines/ExercisePickerSheet.tsx",
    ],
  },

  history: {
    title: "History",
    summary:
      "Browse the workout calendar, search sessions, inspect sets and notes, edit or delete sessions, and share recaps.",
    aliases: ["history", "calendar", "past workouts", "heatmap"],
    availability: [{
      "capability": "Workout history, editing and sharing",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }],
    instructions: `History (tab: History).
- A month calendar heatmap (Rest, Trained, Multiple sessions) with a Today button, a date filter and "Search workouts...".
- Each session expands to its exercises and set pills, the best set, SUPERSET labels, the per-exercise session notes and the workout note. "Share workout" makes a recap card. Row menu: "Edit workout", "Delete workout".
- Your tools for this: coach_get_recent_workouts (headers), coach_get_workout_detail (every set), coach_get_exercise_history (one exercise over time).`,
    sources: ["app/(app)/history.tsx"],
  },

  analytics: {
    title: "Analytics",
    summary:
      "View training and nutrition trends, muscle distribution, exercise progress, body logs, personal records and coach analysis.",
    aliases: [
      "analytics",
      "charts",
      "progress",
      "volume",
      "personal records",
      "body distribution",
    ],
    availability: [{
      "capability": "Training charts, body logs and personal records",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Coach analysis",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
      "notes": "Uses the free or Pro chat allowance.",
    }, {
      "capability": "Nutrition trends",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }],
    instructions:
      `Analytics (tab: Analytics, "Track your progress over time"). Top to bottom:
- "Insights from Coach Drona" with Analyze / Hide. That is you, reading their data.
- Volume and Duration trend charts; Sets and Reps cards.
- Nutrition trends (only when food is logged).
- "Body Distribution": a muscle heatmap of recent work.
- "Exercise Progress": one lift at a time, Max Weight or Volume, with the PR shown.
- "Weight Trend" (+ to "Log Weight"), "Body Fat %" (+ to "Log Body Fat"), and BODY MEASUREMENTS (see body_log).
- "Personal Records" list. A body share card lives here too.`,
    sources: [
      "app/(app)/analytics.tsx",
      "components/diet/NutritionTrendsCard.tsx",
    ],
  },

  body_log: {
    title: "Body log",
    summary:
      "Track body weight, body fat and TAPE MEASUREMENTS at 13 sites, with history and charts in Analytics.",
    aliases: [
      "body",
      "body log",
      "measurement",
      "measurements",
      "tape",
      "waist",
      "hips",
      "chest",
      "arms",
      "bicep",
      "thigh",
      "calf",
      "body fat",
      "bodyfat",
      "weight log",
      "weigh",
      "weigh-in",
      "scale",
      "body composition",
    ],
    availability: [{
      "capability": "Weight, body-fat and tape logging",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
      "notes": "Guests keep device logs; signing in syncs them to the account.",
    }, {
      "capability": "Coach access to body history",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }],
    instructions:
      `Body log (Analytics tab, lower half). Three things, all with history:
- Weight: "Weight Trend" > + > "Log Weight", in kg or lbs (the unit is a Profile setting). Stored per local day (daily_metrics, bodyweight_kg). The latest value also becomes the profile weight. Health-connected scales sync here too.
- Body fat: "Body Fat %" > + > "Log Body Fat". Stored per local day (daily_metrics, body_fat_percent).
- Tape measurements: BODY MEASUREMENTS > "Log" (or "Log First Measurement") opens "Log Measurements": pick the DATE, then fill any of the sites grouped Upper Body (chest, shoulders, neck), Arms (bicep left and right, forearm left and right), Core (waist, hips), Legs (thigh left and right, calf left and right), in cm or inches. "Save Measurements". "Measurement History" lists every entry with delete; a picker charts one site over time. Stored per local day per site in cm (body_measurements).
- What you see: user_context.body_measurements has the latest reading per site with the oldest one in the last 90 days for comparison. coach_get_body_log returns the full weight, body-fat or tape history. Coach from it: waist and hips for a cut, arms and chest and thighs for a gain; every two to four weeks, same time of day, is a sensible cadence. You never diagnose from it.
- Guest weight, body-fat and tape logs stay on the device; signing in uploads them to the account. No Pro subscription is required. You can read their history only after sign-in.`,
    sources: [
      "app/(app)/analytics.tsx",
      "supabase/functions/ai-coach/index.ts",
    ],
  },

  health_readiness: {
    title: "Health and readiness",
    summary:
      "Log sleep, connect Apple Health or Health Connect, and see daily readiness, trends and individual health signals.",
    aliases: [
      "health",
      "readiness",
      "sleep",
      "steps",
      "hrv",
      "heart rate",
      "apple health",
      "health connect",
      "recovery",
      "watch",
      "wearable",
    ],
    availability: [{
      "capability": "Sleep logging and readiness",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Apple Health sync",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
      "platforms": ["ios"],
    }, {
      "capability": "Health Connect sync",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
      "platforms": ["android"],
    }],
    instructions:
      `Health and readiness (Home > the READINESS card, screen title "Readiness").
- Sleep log: "Log last night" opens "Log sleep": duration chips plus 15-minute minus/plus adjustments and an optional 1 to 5 "How did it feel?" quality. One entry per local day; a manual entry wins over a synced one.
- Connect Apple Health (iOS) or Health Connect (Android), then "Sync now": steps, sleep, resting heart rate, HRV and active energy flow into daily_metrics. Any watch, ring or band that feeds those hubs works (Apple Watch, Garmin, Oura, Whoop, Fitbit, Samsung and others).
- Readiness: a 0 to 100 score the app computes each morning against the user's own baseline; provisional until about 7 nights of sleep are logged; tempered slightly by training load and by recent protein and calories. Bands: low under 40, moderate 40 to 66, high 67 and up. The screen shows the score, a trend for the last 14 days, and "Your signals" with an "Ask Drona" link on each row.
- Everything is in user_context.recovery; see <recovery_and_readiness> for how to coach with it. Raw rows: daily_metrics, metric types steps, sleep_minutes, sleep_quality, bodyweight_kg, body_fat_percent, resting_hr_bpm, hrv_sdnn_ms, active_energy_kcal, readiness_score.
- Sleep logging and health sync require signing in, with no Pro requirement. Apple Health is the iOS hub; Health Connect is the Android hub and needs the native hub/adapters to be available.`,
    sources: [
      "app/health.tsx",
      "components/health/SleepLogSheet.tsx",
      "lib/healthSync.ts",
      "lib/readiness.ts",
    ],
  },

  nutrition: {
    title: "Nutrition",
    summary:
      "Use the food diary, calorie and macro goals, food search, saved meals, meal builder and AI logging with three accuracy modes.",
    aliases: [
      "nutrition",
      "food",
      "diet",
      "meal",
      "meals",
      "calories",
      "macros",
      "protein",
      "diary",
      "log food",
      "parse",
      "barcode",
      "targets",
    ],
    availability: [{
      "capability": "Diary logging, saved meals and goals",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Quick and Thorough AI food logging",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
      "notes": "Free users have a separate food-log allowance.",
    }, {
      "capability": "Precise AI food logging",
      "signIn": "required",
      "subscription": "pro_or_trial",
      "status": "available",
    }, {
      "capability": "Coach target proposals",
      "signIn": "required",
      "subscription": "pro_or_trial",
      "status": "available",
    }],
    instructions: `Nutrition (Home > the FUEL card opens the diary).
- Diary: a day stepper, a calorie ring with what is LEFT, protein, carbs and fat bars, and the meals Breakfast, Lunch, Dinner, Snack with "Add to {meal}". A logging streak shows on top.
- Tell Drona what you ate: the bar at the bottom of the diary. The user types a meal in plain words; the app parses it and logs it straight in ("Added by Drona", with Undo). Anything it could not place shows as "Drona didn't get: ..." with Retry or Forget. A chip on the bar sets the accuracy: Quick (an estimate, no lookup), Thorough (catalog matched), Precise (Pro, reads real product numbers).
- Food search: "Search foods" over a large catalog with recents, or "Ask Drona to find" a food that is missing. Food detail shows serving sizes and full nutrition facts.
- Saved meals and the meal builder: "New meal", name it, add foods, "Save meal" or "Log to {meal}".
- Daily goal: "Goal" or "Set goal" on the diary: Calories, Protein, Carbs, Fat. In chat you change them through propose_targets, which shows a card they Apply.
- The Daily goal sheet also has "Fuel days" for extra calories on selected weekdays; call coach_get_app_guide with fuel_days for the steps and limits.
- What you see: user_context.nutrition (targets, today so far, the 3-day average). Per-item history is in meals and meal_entries through coach_query_sql.
- Not in the app: a barcode scanner (there is none), day-by-day meal plans (not your lane).
- Saving diary entries, meals and account goals requires signing in, but manual tracking needs no Pro subscription. Quick and Thorough AI parsing use the free or Pro food-log allowance; Precise requires Pro or an active trial. propose_targets requires Pro or an active trial; free users set targets manually in Daily goal. You can log food and create foods or meals through the conversational food tools, with the user reviewing and saving creation cards.`,
    sources: [
      "app/(app)/nutrition.tsx",
      "lib/dietData.ts",
      "supabase/functions/ai-coach/index.ts",
      "supabase/functions/ai-coach/prompt.ts",
    ],
  },

  fuel_days: {
    title: "Fuel days",
    summary:
      "Add calories as carbs on selected weekdays; edit the live schedule or have Drona plan fuel days for each program phase.",
    aliases: [
      "fuel day",
      "fuel days",
      "fuel by day",
      "extra calories",
      "more calories",
      "calorie cycling",
      "day boosts",
      "weekday calories",
      "higher calorie day",
    ],
    availability: [{
      "capability": "Manual fuel-day editing",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "AI program fuel-day planning and refining",
      "signIn": "required",
      "subscription": "pro_or_trial",
      "status": "available",
    }],
    instructions:
      `Fuel days (extra calories for harder sessions on fixed weekdays).
- From Home: tap the Goal pill to open "Goal and plan". In the current phase, tap "Fuel days" if none are set, or "Edit" beside "FUEL BY DAY" if they are. The week shows the calorie target for each weekday.
- From the food diary: tap "Goal" or "Set goal", then "Fuel days" in the "Daily goal" sheet. On a fuel day, the extra-calorie chip on the diary also opens the editor. Fuel days require signing in; the diary does not offer the editor to guests.
- In the "Fuel days" sheet: tap the weekday circles to select days. Each new day starts at +${FUEL_DEFAULT} kcal; use minus or plus to choose +${FUEL_MIN} to +${FUEL_MAX} kcal in ${FUEL_STEP} kcal steps. Optionally label the session ("Long run", "Leg day", up to ${FUEL_LABEL_MAX} characters), then tap "Save fuel days". Deselect a weekday and save to remove it; deselect every day to return to the same goal all week.
- The extra is added on top of the base calorie target as carbs; protein and fat stay the same. Other weekdays keep their base target. Eating to the larger fuel-day target is on plan. The sheet shows the weekly calorie total and daily average.
- You see the live schedule in user_context.fuel_days. propose_targets changes only the base calorie and macro targets, keeping fuel days on top. To plan or change a program's fuel days in conversation, use generate_program with each phase's fuel_days after the user confirms the proposal; there is no standalone chat tool to edit the live schedule.
- A manual save updates the live schedule and the current program phase, if one is running. A future phase's planned fuel days go live when that phase starts. When building or refining a program, an omitted fuel_days field keeps the live schedule; an empty list removes it. Preserve existing phase schedules unless the user asks to change them.
- Manual editing needs sign-in, with no Pro requirement. Planning or refining fuel days through the program coach requires Pro or an active trial.`,
    sources: [
      "components/diet/FuelDaysSheet.tsx",
      "components/diet/NutritionGoalSheet.tsx",
      "app/goal-plan.tsx",
      "supabase/functions/_shared/fuelDays.ts",
      "lib/programData.ts",
    ],
  },

  goal_plan_program: {
    title: "Goal and program",
    summary:
      "Set a goal and follow a dated program with phases, diet targets, directives, training splits and fuel days; adjust it with Drona.",
    aliases: [
      "goal",
      "goals",
      "program",
      "programs",
      "plan",
      "plans",
      "phase",
      "phases",
      "target weight",
      "goal and plan",
      "adjust",
    ],
    availability: [{
      "capability": "Viewing and managing an existing goal/program",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "AI generation, discussion and refining",
      "signIn": "required",
      "subscription": "pro_or_trial",
      "status": "available",
    }, {
      "capability": "Initial onboarding program preview",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
      "notes":
        "A separate guest onboarding path accepts structured intake before account creation.",
    }],
    instructions:
      `Goal and program (Home > the Goal pill, screen "Goal and plan").
- HERO: the goal, the destination (target weight and date) and a phase progress bar. NOW: the current phase with its daily target chips, its diet, training and readiness directives, and that phase's split as routines (or "Build workout split" if none yet). THE FULL PLAN: every phase. "Adjust with Drona" opens you in refine mode. The user can also end the program.
- A program is what you build with generate_program (Build a Program in the coach menu, or during onboarding): 2 to 6 phases, each with weeks, diet targets, three directives and a training block (split, days per week, a 7-day week pattern with Rest days). The app advances phases by date and applies the current phase's diet targets automatically.
- The user can change targets and goal on the Goal screen and the diary; every change is logged (user_context.recent_plan_changes tells you what changed, when, and by whom).
- Goal choices: build muscle, get stronger, lose fat, build endurance, overall fitness; optional focus areas (abs, arms, chest, back, shoulders, glutes, legs, calves, posture, grip).
- The current phase includes Fuel days / FUEL BY DAY; call coach_get_app_guide with fuel_days for editing steps. Program generation, discussion and refining require sign-in plus Pro or an active trial. The initial onboarding program preview is a separate, limited path before account creation; it does not grant ongoing guest access to coach chat.`,
    sources: [
      "app/goal-plan.tsx",
      "app/onboarding.tsx",
      "lib/programData.ts",
      "supabase/functions/ai-coach/index.ts",
    ],
  },

  today_and_cards: {
    title: "Today and weekly cards",
    summary:
      "See today's workout or rest recommendation and respond to weekly coach cards, including permanent exercise swaps with Undo.",
    aliases: [
      "today",
      "suggestion",
      "card",
      "cards",
      "weekly card",
      "swap",
      "permanent swap",
      "undo",
      "small adjustments",
      "rest day",
    ],
    availability: [{
      "capability": "Local today pick",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Server today pick and weekly cards",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }],
    instructions: `TODAY and weekly cards (Home).
- TODAY card: one pick for the day, made on the server at the user's local midnight from the program phase's week pattern and which routine is most due. It reads "Today's session" with a routine and a one-line reason, "Rest day, recover", "Build today's session" when there are no routines, or "{name}, done for today" after they train.
- Weekly card: at most one per week, marked DRONA ASKS, DRONA SUGGESTS, DRONA NOTICED or DRONA ADJUSTED, with 2 to 4 evidence chips. Kinds: a request (log a weigh-in, log food, see what is due), a notice, or a proposal with "Make it the plan" and "Keep the plan". Most weeks there is no card. The user's answer (applied, dismissed, done) is a decision; user_context.recent_coach_cards lists them.
- Permanent swap: when the user keeps doing exercise B in place of planned exercise A, the app can make B the plan. Four swaps in a row applies it automatically with a notice and Undo; three asks first. Profile > "Small adjustments" turns the automatic part off.`,
    sources: [
      "app/(app)/index.tsx",
      "supabase/functions/drona-cards/index.ts",
      "lib/dronaCard.ts",
    ],
  },

  coach_chat: {
    title: "Coach Drona",
    summary:
      "Chat, keep durable user facts, log food, get live workout edits, and generate or refine workouts, plans and programs.",
    aliases: [
      "coach",
      "chat",
      "drona",
      "generate",
      "refine",
      "discuss",
      "limits",
      "messages",
    ],
    availability: [{
      "capability": "Chat, memory and live workout edits",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Generate, discuss, refine and propose nutrition targets",
      "signIn": "required",
      "subscription": "pro_or_trial",
      "status": "available",
    }],
    instructions:
      `Coach Drona (the coach button on Home, the AI button on Routines, insight cards, health signals, the Goal screen, and inside a workout).
- Menu: "Chat with Coach Drona", "Build a Program", "Generate Workout Plan" (multi-day), "Generate a Workout" (one session). Results show "Why this works for you", "Refine with AI" and Save. Discuss-first chats exist for each.
- In chat you read everything in user_context and can pull more with the typed tools and coach_query_sql. You change targets through propose_targets, the live session through edit_active_workout, and you remember durable facts with remember_fact.
- Limits per rolling 24 hours: free users get ${AI_LIMITS.freeChat} coach messages (plain chat and live_workout) and ${AI_LIMITS.freeFood} AI food logs. Paid and active-trial users get ${AI_LIMITS.proChat} coach messages and ${AI_LIMITS.proFood} AI food logs. Generation, discussion, refining, propose_targets and Precise food parsing require Pro or an active trial. All personal coach conversations require signing in.
- You cannot: log or edit performed sets, finish a workout, edit a saved routine or program in place, send notifications, or see anyone else's data.`,
    sources: [
      "components/ai/AICoachModal.tsx",
      "hooks/useCoachAccess.ts",
      "supabase/functions/ai-coach/index.ts",
      "supabase/functions/ai-coach/prompt.ts",
    ],
  },

  xp_and_insights: {
    title: "Levels and insights",
    summary:
      "Earn workout XP, progress through 50 levels, keep a training streak and read the Coach noticed insights on Home.",
    aliases: [
      "xp",
      "level",
      "levels",
      "title",
      "legend",
      "streak",
      "insight",
      "insights",
      "coach noticed",
    ],
    availability: [{
      "capability": "Workout XP, levels and streak",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Coach noticed insights",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }],
    instructions: `Levels and insights.
- XP: every finished workout earns (sets x 2) + (volume in kg / 100). 50 levels with titles: Beginner (1 to 4), Rookie (5 to 9), Regular (10 to 14), Dedicated (15 to 19), Athlete (20 to 29), Warrior (30 to 39), Elite (40 to 49), Legend (50). Shown on Home and Profile. user_context.profile carries level, xp and streak.
- Streak: consecutive training weeks kept on the profile.
- "Coach noticed" insights on Home: new PRs this week, an exercise that has stalled, a muscle with low volume, one side outpacing the other, days since the last workout, a streak. Tapping one opens you with that topic.`,
    sources: [
      "lib/xp.ts",
      "app/(app)/index.tsx",
      "components/insights/InsightsStrip.tsx",
    ],
  },

  import: {
    title: "Import",
    summary:
      "Import Hevy CSV workout history from Profile, preserving set types, supersets and effort ratings.",
    aliases: ["import", "imports", "hevy", "csv", "strong"],
    availability: [{
      "capability": "Hevy CSV import",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }],
    instructions:
      `Import (Profile > Import Data, "Bring your history in from another app").
- Hevy only, today: "Choose Hevy CSV file", pick the weight unit used in Hevy (kg or lbs), preview Workouts, Sets and Exercises, import. Set types, supersets and RPE are kept. Imported sessions are ordinary workouts in History and in your tools. Guests must sign in first.`,
    sources: ["app/(app)/import.tsx"],
  },

  form_check: {
    title: "Form check",
    summary:
      "Drona Eyes exists as a camera screen but has no menu entry; check the guide before directing anyone to it.",
    aliases: ["form", "form check", "camera", "drona eyes", "pose"],
    availability: [{
      "capability": "Form-check camera flow",
      "signIn": "optional",
      "subscription": "free",
      "status": "unreachable",
      "notes": "The screen exists but no menu button exposes it.",
    }],
    instructions:
      `Form check ("Drona Eyes"): an on-device camera flow that counts reps and scores a set out of 100 with cues. It exists as a screen but has no button in the menus today, so do not send users to it. Only per-rep joint angles ever leave the phone.`,
    sources: ["app/form-check.tsx"],
  },

  share: {
    title: "Sharing",
    summary:
      "Create workout recap and body-distribution images, save them or open the system sharing flow.",
    aliases: ["share", "story", "stories", "card image"],
    availability: [{
      "capability": "Workout recap and body-distribution sharing",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }],
    instructions:
      `Sharing: "Share workout" from the finish screen or History makes a recap card; Analytics has a body heatmap card. "Share to Stories" or save the image. Nothing is posted by the app itself and nothing is stored.`,
    sources: [
      "components/share/RecapShareCard.tsx",
      "components/share/BodyShareCard.tsx",
    ],
  },

  profile_settings: {
    title: "Profile",
    summary:
      "Edit body and training information, units, appearance and workout preferences; manage the plan, import data or delete the account.",
    aliases: [
      "profile",
      "settings",
      "units",
      "kg",
      "lbs",
      "appearance",
      "theme",
      "injury",
      "preferences",
      "delete account",
      "sign out",
      "timezone",
    ],
    availability: [{
      "capability": "Profile and workout settings",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Account management, importing and bug reports",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "Editing injury notes or training preferences on a screen",
      "signIn": "optional",
      "subscription": "free",
      "status": "unavailable",
      "notes":
        "Collected at onboarding; new facts can be remembered in signed-in coach chat.",
    }],
    instructions: `Profile (tab: Profile).
- PLAN: the subscription card, "With Pro you get" (unlimited coach chat, unlimited AI food logs, personalized plans rewritten weekly).
- BASIC INFORMATION: Gender, Height, Weight, Goal weight, Body fat %.
- TRAINING PROFILE: Primary goal, Experience, Sessions per week, Training age (months), Birth year. These feed you.
- PREFERENCES: Appearance (theme), Small adjustments (automatic permanent swaps), Weight Unit (kg or lbs), Report a Bug.
- TRAINING: Workout Settings, My Exercises, Import Data.
- ACCOUNT: Sign Out, Delete Account (requests deletion of the account and its data).
- Injury notes ("Anything I should train around?") and training preferences ("How do you like to train?") are asked at onboarding and cannot be edited on a screen yet. If the user gives you a new one in chat, save it with remember_fact so you keep honouring it. Timezone is detected from the phone, not a setting. Units are display only; storage is kg and cm.
- Profile and workout settings have a local guest version. Account management, importing and submitting bug reports require sign-in. The plan card is shown only when signed in. The UI advertises unlimited AI use; the enforced rolling limits are documented under pro_and_free.`,
    sources: [
      "app/(app)/profile.tsx",
      "app/onboarding.tsx",
      "components/workout/WorkoutSettingsSheet.tsx",
    ],
  },

  pro_and_free: {
    title: "Free versus Pro",
    summary:
      "Check free allowances, Pro/trial and lifetime access, upgrade and restore options, and platform-specific purchase limits.",
    aliases: [
      "pro",
      "free",
      "paywall",
      "subscription",
      "subscriptions",
      "trial",
      "trials",
      "upgrade",
      "price",
      "tier",
      "founding",
      "lifetime",
    ],
    availability: [{
      "capability": "Viewing the upgrade screen",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability": "In-app Pro purchase and restore",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
      "platforms": ["ios"],
    }, {
      "capability": "In-app Pro purchase",
      "signIn": "required",
      "subscription": "free",
      "status": "unavailable",
      "platforms": ["android"],
    }],
    instructions: `Free versus Pro.
- Free signed-in users: ${AI_LIMITS.freeChat} coach messages and ${AI_LIMITS.freeFood} AI food logs per rolling 24 hours. Plain chat, live-workout coaching and memory are included. Manual routines, workout history, workout/diet tracking, body logs, health sync and readiness do not require Pro; account-backed features still require sign-in.
- Pro includes monthly/annual subscribers, founding lifetime, AppSumo lifetime and active trials. It unlocks program/plan/workout generation, discussion, refining, coach nutrition-target proposals and Precise food parsing. The backend enforces ${AI_LIMITS.proChat} coach messages and ${AI_LIMITS.proFood} AI food logs per rolling 24 hours, even though the UI calls them unlimited.
- Upgrade: Profile > Plan, or the paywall when a free user reaches a limit. In-app purchase and Restore purchases are offered on iOS; Android displays "Pro is coming to Android". An existing paid entitlement is checked by the same backend access gate; Android purchase availability does not mean all Android users are limited to free.
- Trial eligibility and length come from the selected App Store product. An eligible annual offer may have a 7-day trial; do not promise a trial for every plan or repeat trial eligibility. Lifetime purchases do not renew. AppSumo lifetime is redeemed by code, not through store subscription management.
- The UI advertises personalized plans rewritten weekly; weekly written reports and proactive nudges are not available. Do not promise an automatic weekly rewrite from that marketing text. The user builds or refines a program through the coach.`,
    sources: [
      "app/upgrade.tsx",
      "lib/revenuecat.ts",
      "lib/tiers.ts",
      "supabase/functions/ai-coach/index.ts",
    ],
  },

  guest_mode: {
    title: "Guest mode",
    summary:
      "Use local workout, routine, exercise, profile and body logs before signing in; check which account-backed features need sign-in.",
    aliases: ["guest", "signed out", "sign in"],
    availability: [{
      "capability": "Local workout, routine, exercise, profile and body logs",
      "signIn": "optional",
      "subscription": "free",
      "status": "available",
    }, {
      "capability":
        "Cloud sync, personal coaching, food logging, health logs and import",
      "signIn": "required",
      "subscription": "free",
      "status": "available",
    }],
    instructions: `Guest mode: "Continue as guest" on the sign-in screen.
- Workouts, routines, custom exercises, profile information and body logs (weight, body fat and tape measurements) can be kept on the device. They need no Pro subscription.
- Personal coach chat, AI food logs, saving the food diary, fuel days, sleep/health sync and importing need an account. A guest does not send their personal training data to Drona. The initial onboarding program preview is a separate limited path based on structured intake before account creation.
- Signing in later (Apple, Google or email) brings local guest workout/profile data and device body logs into the account. Signing in does not by itself grant Pro; consult pro_and_free for AI generation and parsing access.`,
    sources: [
      "lib/guestStore.ts",
      "lib/guestMode.ts",
      "app/(app)/analytics.tsx",
      "hooks/useCoachAccess.ts",
      "lib/supabase.ts",
    ],
  },

  not_available: {
    title: "Unavailable features and action limits",
    summary:
      "Check barcode scanning, reminders, music playback, weekly reports, camera access, profile-note editing and coach action limits.",
    aliases: [
      "not available",
      "missing",
      "cannot",
      "can't",
      "unsupported",
      "notifications",
      "reminder",
      "reminders",
    ],
    availability: [{
      "capability":
        "Barcode scanning, general push reminders, music playback, weekly reports and proactive nudges",
      "signIn": "optional",
      "subscription": "free",
      "status": "unavailable",
    }],
    instructions:
      `Things the app does not do today, so never claim them: barcode scanning; push reminders (only one trial reminder exists); playing or reading music (the shortcut just opens the music app); weekly written progress reports and proactive nudges (marked "soon"); a form-check flow reachable from the menus; editing injury notes or training preferences on a screen after onboarding; Pro purchase on Android; past chat transcripts across devices. And you cannot log or edit performed sets, finish a workout, or edit a saved routine or program in place from chat.`,
    sources: [
      "app/upgrade.tsx",
      "app/form-check.tsx",
      "app/(app)/profile.tsx",
      "supabase/functions/ai-coach/prompt.ts",
    ],
  },
} satisfies Record<string, AppGuideEntry>;

export type AppGuideTopic = keyof typeof APP_GUIDE;
export const APP_GUIDE_TOPICS = Object.keys(APP_GUIDE) as AppGuideTopic[];

export const APP_FEATURES = `<app_features>
You live inside the OVERLOAD app. This is a discovery index, not a promise that every action is available to every account or device. Never tell them the app cannot do one of these without checking the guide and its access requirements. For exact steps, limits, sign-in/subscription requirements and platform availability, call coach_get_app_guide with its topic ID. Pro access includes active trials and lifetime entitlements. Summaries omit details, so absence from a summary does not establish that a feature is unsupported.

Tabs: Home, Routines, History, Analytics, Profile, plus the centre button that starts a workout.

${
  APP_GUIDE_TOPICS.map((topic) =>
    `- ${APP_GUIDE[topic].title} (topic ${topic}): ${APP_GUIDE[topic].summary}`
  ).join("\n")
}
</app_features>`;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface AppGuideResult {
  topic: AppGuideTopic;
  title: string;
  instructions: string;
  availability: readonly AppGuideAvailability[];
}

function resultFor(topic: AppGuideTopic): AppGuideResult {
  const { title, instructions, availability } = APP_GUIDE[topic];
  return { topic, title, instructions, availability };
}

/** Exact IDs first. Legacy/free-text callers use whole-word aliases. An
 * unknown or equally strong ambiguous match returns topic IDs for recovery,
 * without sending the details of unrelated features to the coach. */
export function lookupAppGuide(
  topic: unknown,
): AppGuideResult | { error: string; topics: AppGuideTopic[] } {
  const raw = typeof topic === "string" ? topic : "";
  const q = norm(raw);
  if (!q) return { error: "topic is required", topics: APP_GUIDE_TOPICS };

  const asKey = q.replace(/ /g, "_");
  if (Object.hasOwn(APP_GUIDE, asKey)) return resultFor(asKey as AppGuideTopic);

  let longest = 0;
  const matches = new Set<AppGuideTopic>();
  for (const key of APP_GUIDE_TOPICS) {
    for (const alias of APP_GUIDE[key].aliases) {
      const word = norm(alias);
      if (!word || !` ${q} `.includes(` ${word} `)) continue;
      if (word.length > longest) {
        longest = word.length;
        matches.clear();
      }
      if (word.length === longest) matches.add(key);
    }
  }
  if (matches.size === 1) return resultFor([...matches][0]);
  if (matches.size > 1) {
    return {
      error: `ambiguous guide topic "${raw}"; choose a topic ID`,
      topics: [...matches],
    };
  }
  return { error: `no guide topic matches "${raw}"`, topics: APP_GUIDE_TOPICS };
}
