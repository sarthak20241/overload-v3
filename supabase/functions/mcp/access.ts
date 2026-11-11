// Who may call which tool, how often, and the trace row each call leaves.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { ToolResult } from "./protocol.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any> | null;

/** Same rule as get_coach_access_status (0088): a paid tier that has not
 *  expired, or a trial that has not ended. */
export function hasPro(profile: Row, trial: Row, now: Date = new Date()): boolean {
  const tier = profile?.tier;
  if (typeof tier === "string" && tier !== "free") {
    const exp = profile?.tier_expires_at;
    if (!exp || Date.parse(exp) > now.getTime()) return true;
  }
  if (trial && !trial.ended_at && trial.expires_at && Date.parse(trial.expires_at) > now.getTime()) return true;
  return false;
}

export const NOT_PRO: ToolResult = {
  // States the plan this needs, nothing more: ChatGPT's directory rules bar
  // tools that promote upgrades or link to a purchase.
  text: "This Overload account does not have Overload Pro, which using Overload from ChatGPT or Claude needs. " +
    "No data was read or changed.",
  isError: true,
};

/** A person never meets these; a loop does. Per user, all tools together. */
export const RATE = { perMinute: 60, perDay: 2000 };

export function limitHit(lastMinute: number, lastDay: number): ToolResult | null {
  if (lastMinute < RATE.perMinute && lastDay < RATE.perDay) return null;
  const wait = lastMinute >= RATE.perMinute ? "a minute" : "a few hours";
  return { text: `Too many Overload calls in a short time. Wait ${wait}, then try again.`, isError: true };
}

export type TraceStatus = "ok" | "error" | "denied" | "limited" | "failed";

/** Best effort: a trace that fails to save never fails the user's call. */
export async function writeTrace(
  // deno-lint-ignore no-explicit-any
  db: SupabaseClient<any, "public", any>,
  t: { userId: string; tool: string; status: TraceStatus; ms: number; clientId: string | null },
): Promise<void> {
  try {
    const { error } = await db.from("mcp_traces").insert({
      user_id: t.userId,
      tool: t.tool.slice(0, 64),
      status: t.status,
      ms: Math.max(0, Math.round(t.ms)),
      client_id: t.clientId?.slice(0, 300) ?? null,
    });
    if (error) console.error("[mcp] trace insert:", error.message);
  } catch (e) {
    console.error("[mcp] trace insert threw:", e);
  }
}
