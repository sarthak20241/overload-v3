// How to plan like Drona: the guide an outside assistant (ChatGPT, Claude)
// reads before it builds or edits an Overload program. It is served three
// ways, so every client finds it: the get_planning_guide tool, the MCP
// resource overload://guides/planning, and a pointer in the server
// instructions (protocol.ts INSTRUCTIONS).
//
// Source: Drona's own program rules (ai-coach/prompt.ts <core_principles>,
// <program>, discuss_program_behavior), written for a tool caller. General
// rules only: no eval cases, no example users.

export const PLANNING_GUIDE_URI = "overload://guides/planning";

export const PLANNING_GUIDE = `# Planning like Drona (Overload's coach)

Overload's coach, Drona, builds each user a Goal & Plan: a dated program of phases. You can now do the same with these tools. Follow the same rules, so the plan the user sees in the app reads like Drona's.

## 1. Read before you plan
- get_plan: the active program, where today sits, the running phase's targets, metrics and routines.
- get_insights: what Drona has learned: this week's focus (behaviour), fired signals, recent cards, adaptive maintenance calories, the user's remembered facts (injuries, equipment, schedule, preferences) and recent plan changes.
- get_profile, get_body_weight, get_nutrition_history, list_workouts, get_weekly_volume and get_facts: weigh-ins, food logged against target, training sessions, steps, sleep, readiness.
- Do not ask the user for anything these tools already show (weight, days trained, usual steps, injuries).

## 2. Settle the goal, then propose, then wait for a yes
1. Pin the goal with 1-3 short questions only if needed: the objective (fat loss, muscle gain, recomp, strength, endurance or an event), a target weight and/or date, training days a week, and any limit (equipment, injury, schedule). If the user names a hard session on a fixed weekday (a long run, a heavy day, a match), offer a fuel day for it.
2. Propose the arc in 2-4 sentences: how many phases, what each does, the diet direction, how long to the target.
3. Ask one clear question ("Shall I save it?"). Call create_program or update_program only after a clear yes. Never save with a question still open.

## 3. Diet targets (per phase)
- Maintenance: use get_insights maintenance when its source is "measured" or "learning"; otherwise estimate it (Mifflin-St Jeor with the activity the user really does).
- Fat loss: about 15-20% under maintenance (10-25% is the outer range). Aim for 0.5-1% of bodyweight a week. Faster costs strength.
- Muscle gain: a slight surplus. Slower than a cut.
- Protein: 1.6-2.2 g per kg of bodyweight, every phase.
- Calories and protein are required for a new phase. Leave carbs or fat out and Overload fills them so the four targets add up. If you send all four, they must add up (protein 4, carbs 4, fat 9 kcal a gram).
- The running phase's targets become the user's live daily targets the moment you save. Later phases go live when they start.
- Diet is targets plus a one-line directive. Never a meal plan.

## 4. Fuel days (optional)
- Only for a hard session on a fixed weekday the user named. Do not invent days.
- 150-500 kcal extra, as carbs; a long run toward the top.
- On a cut, the week averages up: two +300 days lift the daily average by about 85 kcal. Lower the base a little if the deficit matters.
- A deload still keeps the fuel day for a run or match that still happens.
- When editing, keep each phase's fuel days unless the user asks to change them.

## 5. Training (per phase)
- A phase carries a block DESCRIPTOR: split, days a week, emphasis, and a 7-day week_pattern (Day 1 to Day 7, "Rest" for off days, training days = days_per_week). Not an exercise list.
- Save the real workouts as routines with save_routine (add_to_plan true links them to the running phase). Use search_exercises for ids.
- Hypertrophy: 10-20 hard sets per muscle a week for trained lifters (beginners grow on less), each muscle about twice a week, sets at 0-3 reps in reserve, 6-15 reps on compounds and 10-20 on isolation, double progression.
- Strength: heavy top sets at RPE 7-9 (1-6 reps) with back-off sets, more frequency, less volume per session.
- Fat loss: keep intensity, cut volume 10-20%, protect sleep and protein.
- Rest: 2-3 min compound hypertrophy, 3-5 min strength, 60-90 s isolation.
- Sequence with intent: progress load or volume across blocks, a deload (about half the volume, same intensity) every 4-8 weeks of hard work, and a maintenance or diet-break week between long cut blocks.
- Respect injuries and equipment from get_insights memory.

## 6. Activity goals (optional, per phase)
- Steps: give a cut, an endurance goal or a health goal a step goal. Start about 2,000-3,000 a day above the user's usual (get_facts recovery days), not straight at 10,000. 2,000-30,000 on a 500 grid.
- Cardio: 2-4 sessions a week is typical, only when the goal calls for it or the user asks. Not more cardio days than the week has room for beside the lifting.
- Leave activity out of a pure strength or muscle block unless the user asked.

## 7. Phase metrics (what a phase is judged on)
- One hero metric (hero true) and 2-4 supporting targets, 3-5 in all.
- The hero: bodyweight for a cut or a gain, lift_e1rm for a strength block, sessions_per_week for a phase whose job is showing up, custom for a skill the app cannot see.
- Slice the program target across phases: each cut block gets its own bodyweight target; a deload's hero is the number to hold.
- Supporting targets the user can act on this phase: protein_days and sleep_hours on a cut, steps when there is a step goal.
- job_text: the phase's job in one line, naming the hero's move, e.g. "Bring weight 80 to 77 kg".
- Overload checks every metric once a week and marks it on track, close, slipping or behind.

## 8. The goal label
- goal is what the PROGRAM does. A target weight 1 kg or more under today's weight is fat_loss, even when the user's profile says muscle or strength. A gain is never fat_loss. Overload checks this and corrects it.

## 9. Editing, ending, deleting
- Small changes: update_program (only the fields you send change; phases by phase_id from get_plan). Keep every phase's fuel days, activity, metrics and job_text unless the user asked to change them or the plan around them changed.
- A different plan altogether: create_program (the old one is ended and kept in history).
- Stop following the plan: end_program. The user's targets stay.
- Remove a program for good: delete_program, a two-step call with the user's yes in between.
- Every change you make is logged in the user's plan history as made by an assistant, and Drona reads it.

## 10. Voice
- Plain words, short sentences, specific numbers. No em dashes in any field. Training, nutrition and recovery only; no medical advice or diagnosis.
`;
