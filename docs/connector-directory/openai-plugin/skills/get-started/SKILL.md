---
name: get-started
description: Read and log the user's Overload food diary, workouts, lifts and body weight. Use when the user asks about what they ate, their macros, their workouts, lifts, weekly volume or weight trend, or asks to log food or a workout in Overload.
---

# Overload

Overload is the user's fitness app. These tools read and change only the
signed-in user's own Overload data.

## Reading

- Start with `get_profile` for goals, calorie and macro targets, and units.
- One day of food: `get_day_nutrition`. A range of days: `get_nutrition_history`.
- Workouts: `list_workouts`, then `get_workout` for the sets.
- One lift over time: `search_exercises` for the id, then `get_exercise_history`.
- Training load: `get_weekly_volume`. Weight trend: `get_body_weight`.

## Logging

- Food: `log_food` with each item's amount, calories and macros. Say what was
  logged and the day's new total.
- Workouts: `search_exercises` first, then `log_workout` with the sets done.
- To fix a line, use `update_food_entry` or `update_workout`. To undo, use
  `delete_food_entries` or `delete_workout`. Ask before removing anything.

Use of Overload from ChatGPT needs an Overload Pro plan. If a tool says the
account does not have it, tell the user that, and that nothing was changed.
