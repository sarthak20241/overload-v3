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

async function call(db: Db, fn: string, args: Json): Promise<Json> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    // P0002: not found / not theirs. 22023: bad value. 55P03: same request running.
    if (error.code === "P0002") throw new WriteRefused("No such food line in this account.");
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
  };
}

export type Writes = ReturnType<typeof makeWrites>;
