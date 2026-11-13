// Every database read the MCP tools make. The function uses the service role,
// so Postgres row rules do NOT protect anything here: the token's user is not
// a Supabase session. The only guard is the user filter, so every query in
// this file starts from `own` (rows of this user) or `catalog` (shared
// exercises plus this user's own). mcp.test.ts fails if a query starts any
// other way. Nested selects (meal_entries under meals, workout_sets under
// workouts) inherit the filter from their parent row.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, "public", any>;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** Clerk user ids are user_ + letters and digits. Anything else never reaches
 *  a filter string. */
const USER_ID = /^[A-Za-z0-9_]{1,64}$/;

function checkUser(userId: string): string {
  if (!USER_ID.test(userId)) throw new Error("bad user id");
  return userId;
}

function own(db: Db, table: string, cols: string, userCol: string, userId: string, head = false) {
  return db.from(table).select(cols, head ? { count: "exact", head: true } : undefined)
    .eq(userCol, checkUser(userId));
}

function catalog(db: Db, cols: string, userId: string) {
  return db.from("exercises").select(cols).or(`created_by.is.null,created_by.eq.${checkUser(userId)}`);
}

async function rows(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

async function one(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row | null> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? null) as Row | null;
}

/** Strip characters PostgREST treats as syntax in a filter value. */
function likeText(q: string): string {
  return q.replace(/[%_*,()\\"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function makeData(db: Db) {
  return {
    profile: (u: string) =>
      one(own(db, "user_profiles",
        "name, goal, goals, experience_level, height_cm, weight_kg, goal_weight_kg, body_fat_percent, " +
          "timezone, weekly_target_sessions, daily_calorie_target, protein_target_g, carb_target_g, " +
          "fat_target_g, calorie_day_boosts, tier, tier_expires_at",
        "clerk_user_id", u).maybeSingle()),

    trial: (u: string) => one(own(db, "coach_trials", "expires_at, ended_at", "clerk_user_id", u).maybeSingle()),

    /** The Connect plan (20261112150000). Kept apart from `profile` so a
     *  deploy that lands before the migration only loses Connect access,
     *  never the whole profile read: a missing column reads as no Connect.
     *  Any other error throws, so a passing database fault is an error, not
     *  "no plan" told to a paying Connect user. */
    connect: (u: string) =>
      one(own(db, "user_profiles", "connect_plan, connect_expires_at", "clerk_user_id", u).maybeSingle())
        .catch((e: unknown) => {
          if (/connect_(plan|expires_at).*does not exist/i.test(String((e as Error)?.message ?? e))) return null;
          throw e;
        }),

    /** Calls in the last `seconds`, for the rate limit. */
    recentCalls: async (u: string, seconds: number) => {
      const since = new Date(Date.now() - seconds * 1000).toISOString();
      const { count, error } = await own(db, "mcp_traces", "id", "user_id", u, true).gte("created_at", since);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },

    targetHistory: (u: string) =>
      rows(own(db, "user_target_history", "effective_from, kcal, protein_g, carb_g, fat_g, calorie_day_boosts",
        "user_id", u).order("effective_from")),

    dayTargets: (u: string, from: string, to: string) =>
      rows(own(db, "user_day_targets", "day, kcal, protein_g, carb_g, fat_g", "user_id", u)
        .gte("day", from).lte("day", to)),

    meals: (u: string, start: string, end: string) =>
      rows(own(db, "meals",
        "id, meal_type, logged_at, meal_entries(id, food_name, quantity, serving_unit, grams_logged, " +
          "kcal, protein_g, carb_g, fat_g, fiber_g, position, logged_via)",
        "user_id", u).gte("logged_at", start).lt("logged_at", end).order("logged_at")),

    /** One food line with its meal, if the meal is this user's. */
    foodEntry: (u: string, id: string) =>
      one(own(db, "meal_entries",
        "id, food_name, quantity, serving_unit, grams_logged, kcal, protein_g, carb_g, fat_g, fiber_g, origin, " +
          "logged_via, meals!inner(meal_type, logged_at, user_id)",
        "meals.user_id", u).eq("id", id).maybeSingle()),

    workouts: (u: string, start: string, end: string, limit: number) =>
      rows(own(db, "workouts",
        "id, name, started_at, duration_seconds, total_volume_kg, source, workout_sets(exercise_id, set_type, exercises(name))",
        "user_id", u).gte("started_at", start).lt("started_at", end)
        .order("started_at", { ascending: false }).limit(limit)),

    workout: (u: string, id: string) =>
      one(own(db, "workouts",
        "id, name, notes, started_at, duration_seconds, total_volume_kg, source, " +
          "workout_sets(exercise_id, weight_kg, reps, duration_seconds, distance_m, resistance, set_type, rpe, " +
          "is_unilateral, reps_right, rpe_right, weight_kg_right, order, superset_group, exercises(name, metric_type))",
        "user_id", u).eq("id", id).maybeSingle()),

    liftStat: (u: string, exerciseId: string) =>
      one(own(db, "user_lift_stats",
        "exercise_name, muscle_group, estimated_1rm, top_set_weight, top_set_reps, last_set_weight, " +
          "last_set_reps, last_performed_at, sessions_last_28d",
        "user_id", u).eq("exercise_id", exerciseId).maybeSingle()),

    /** The newest `limit` workouts of this user that include one exercise,
     *  each with only that exercise's sets (the !inner join filters both). */
    exerciseSessions: (u: string, exerciseId: string, limit: number) =>
      rows(own(db, "workouts",
        "id, started_at, workout_sets!inner(weight_kg, reps, duration_seconds, distance_m, set_type, rpe, " +
          "is_unilateral, reps_right, weight_kg_right, order, exercise_id)",
        "user_id", u).eq("workout_sets.exercise_id", exerciseId)
        .order("started_at", { ascending: false }).limit(limit)),

    /** How many of this user's workouts include the exercise. */
    exerciseSessionCount: async (u: string, exerciseId: string) => {
      const { count, error } = await own(db, "workouts", "id, workout_sets!inner(exercise_id)", "user_id", u, true)
        .eq("workout_sets.exercise_id", exerciseId);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },

    volume: (u: string, fromWeek: string) =>
      rows(own(db, "user_volume_stats", "muscle_group, week_start, total_volume_kg, set_count", "user_id", u)
        .gte("week_start", fromWeek).order("week_start")),

    weights: (u: string, from: string, to: string) =>
      rows(own(db, "daily_metrics", "metric_date, value, source", "user_id", u)
        .eq("metric_type", "bodyweight_kg").gte("metric_date", from).lte("metric_date", to).order("metric_date")),

    exerciseById: (u: string, id: string) =>
      one(catalog(db, "id, name, muscle_group, metric_type", u).eq("id", id).maybeSingle()),

    searchExercises: (u: string, q: string, limit = 10) => {
      const text = likeText(q);
      if (!text) return Promise.resolve([] as Row[]);
      return rows(catalog(db, "id, name, muscle_group, category, metric_type, created_by", u)
        .ilike("name", `%${text}%`).limit(limit));
    },
  };
}

export type Data = ReturnType<typeof makeData>;
