// Every write the MCP tools make. Each one is a database function
// (migration 20261111130000) that takes the user id, checks every row it
// touches against it, and runs as one transaction. Only service_role may call
// them. This file adds nothing but the call: the rules live in the SQL, and
// supabase/migrations/checks/mcp_food_writes.check.ts tests them.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, "public", any>;
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

/** A write the database refused for a reason the user can fix. */
export class WriteRefused extends Error {}

async function call(db: Db, fn: string, args: Json, notFound = "No such food line in this account."): Promise<Json> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    // P0002: not found / not theirs. 22023: bad value. 55P03: same request
    // running. 42501: not allowed (an app workout to a connector delete).
    if (error.code === "P0002") throw new WriteRefused(notFound);
    if (error.code === "42501") throw new WriteRefused(`Not allowed: ${error.message}.`);
    if (error.code === "55P03") throw new WriteRefused("That same request is still being saved. Wait a moment, then check the day.");
    if (error.code === "22023" || error.code === "23514") throw new WriteRefused(`Overload refused a value: ${error.message}`);
    throw new Error(`${fn}: ${error.message}`);
  }
  return data as Json;
}

export interface Place {
  meal: string;
  start: string;
  end: string;
  loggedAt: string;
}

export function makeWrites(db: Db) {
  return {
    logFood: (u: string, at: Place, items: Json[], requestId: string | null) =>
      call(db, "mcp_log_food", {
        p_user: u, p_meal_type: at.meal, p_start: at.start, p_end: at.end, p_logged_at: at.loggedAt,
        p_items: items, p_request_id: requestId,
      }),

    updateFoodEntry: (u: string, id: string, set: Json, to: Place | null) =>
      call(db, "mcp_update_food_entry", {
        p_user: u, p_entry: id, p_set: set,
        p_meal_type: to?.meal ?? null, p_start: to?.start ?? null, p_end: to?.end ?? null, p_logged_at: to?.loggedAt ?? null,
      }),

    deleteFoodEntries: (u: string, ids: string[]) =>
      call(db, "mcp_delete_food_entries", { p_user: u, p_ids: ids }),

    logWorkout: (u: string, w: { name: string; startedAt: string; durationSeconds: number; notes: string | null }, exercises: Json[], requestId: string | null) =>
      call(db, "mcp_log_workout", {
        p_user: u, p_name: w.name, p_started_at: w.startedAt, p_duration_seconds: w.durationSeconds,
        p_notes: w.notes, p_exercises: exercises, p_request_id: requestId,
      }, "An exercise is not in Overload's list or this user's own exercises. Use search_exercises for ids."),

    updateWorkout: (u: string, id: string, set: Json, replace: Json[] | null) =>
      call(db, "mcp_update_workout", { p_user: u, p_workout: id, p_set: set, p_replace: replace },
        "No such workout in this account, or an exercise is not in Overload's list."),

    saveRoutine: (u: string, r: { name: string; description: string | null; phaseId: string | null }, exercises: Json[], requestId: string | null) =>
      call(db, "mcp_save_routine", {
        p_user: u, p_name: r.name, p_description: r.description, p_exercises: exercises,
        p_phase: r.phaseId, p_request_id: requestId,
      }, "An exercise is not in Overload's list or this user's own exercises, or the plan phase is gone. Use search_exercises for ids."),

    // Programs (migration 20261114120000). The tool works out every value;
    // these functions write it in one transaction and check ownership.
    saveProgram: (u: string, program: Json, phases: Json[], mirror: Json | null, requestId: string | null) =>
      call(db, "mcp_save_program", {
        p_user: u, p_program: program, p_phases: phases, p_mirror: mirror, p_request_id: requestId,
      }),

    updateProgram: (u: string, id: string, fields: Json, phases: Json[], today: string, mirror: Json | null, requestId: string | null) =>
      call(db, "mcp_update_program", {
        p_user: u, p_program: id, p_fields: fields, p_phases: phases, p_today: today, p_mirror: mirror,
        p_request_id: requestId,
      }, "No active program with that id in this account, or a phase id is not one of its phases. Read get_plan again."),

    endProgram: (u: string) => call(db, "mcp_end_program", { p_user: u }, "There is no active program to end."),

    deleteProgram: (u: string, id: string) =>
      call(db, "mcp_delete_program", { p_user: u, p_program: id }, "No such program in this account. Use list_programs for ids."),

    deleteWorkout: (u: string, id: string) =>
      call(db, "mcp_delete_workout", { p_user: u, p_workout: id }, "No such workout in this account."),
  };
}

export type Writes = ReturnType<typeof makeWrites>;
