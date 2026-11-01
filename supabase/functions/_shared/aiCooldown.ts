// Pro and trial AI use: reserve one request against the cooldown, or say how
// long to wait. The rules themselves run in the database (migration
// 20261026120000_pro_ai_cooldown.sql) so a concurrent burst is serialized;
// this file picks the RPC, passes PRO_COOLDOWN in, and shapes the 429.
import { AI_LIMITS, PRO_COOLDOWN } from "./aiLimits.ts";

export type AiFeature = "chat" | "food";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

export type ProSlot =
  | { kind: "ok"; count: number }
  /** The cooldown said wait. retryAfterSeconds is exact. */
  | { kind: "cooldown"; count: number; retryAfterSeconds: number; reason: "burst" | "heavy_day" }
  /** Only before the migration is applied: the old daily cap ran out. The
   *  caller works out the wait from the oldest row, as it always did. */
  | { kind: "legacy_cap"; count: number; cap: number }
  | { kind: "error"; message: string };

const RPC: Record<AiFeature, { cooldown: string; legacy: string; legacyCap: number }> = {
  chat: {
    cooldown: "try_reserve_ai_coach_slot_cooldown",
    legacy: "try_reserve_ai_coach_slot",
    legacyCap: AI_LIMITS.legacyProChat,
  },
  food: {
    cooldown: "try_reserve_parse_meal_slot_cooldown",
    legacy: "try_reserve_parse_meal_slot",
    legacyCap: AI_LIMITS.legacyProFood,
  },
};

/** PostgREST's "no such function" (schema cache) and Postgres's own. Anything
 *  else is a real failure and must not quietly drop to the old caps. */
export function isMissingRpc(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function/i.test(error.message ?? "");
}

const firstRow = (data: unknown) =>
  (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;

export async function reserveProSlot(rpc: Rpc, feature: AiFeature): Promise<ProSlot> {
  const rule = PRO_COOLDOWN[feature];
  const names = RPC[feature];
  const { data, error } = await rpc(names.cooldown, {
    p_burst: rule.burst,
    p_burst_seconds: rule.burstWindowSeconds,
    p_heavy_after: rule.heavyAfter,
    p_heavy_gap_seconds: rule.heavyGapSeconds,
  });

  if (error && isMissingRpc(error)) {
    // Function deployed before the migration: keep the old cap until it lands.
    const legacy = await rpc(names.legacy, { p_cap: names.legacyCap });
    if (legacy.error) return { kind: "error", message: legacy.error.message ?? "legacy reserve failed" };
    const row = firstRow(legacy.data);
    const count = Number(row?.current_count ?? 0);
    return row?.inserted ? { kind: "ok", count } : { kind: "legacy_cap", count, cap: names.legacyCap };
  }
  if (error) return { kind: "error", message: error.message ?? "reserve failed" };

  const row = firstRow(data);
  const count = Number(row?.current_count ?? 0);
  if (row?.inserted) return { kind: "ok", count };
  // A false with no wait would be a row the function cannot write (signed
  // out). Never tell anyone to wait 0 seconds; one second is the floor.
  return {
    kind: "cooldown",
    count,
    retryAfterSeconds: Math.max(1, Number(row?.retry_after_seconds ?? 0) || 1),
    reason: row?.reason === "heavy_day" ? "heavy_day" : "burst",
  };
}

/**
 * The 429 for a cooldown. `error` and `retry_after_seconds` are what every
 * installed build already reads off a Pro 429 (they show their generic "busy"
 * line), so both stay. `cooldown` and `feature` let newer builds say how long.
 */
export function cooldownBody(feature: AiFeature, slot: Extract<ProSlot, { kind: "cooldown" }>) {
  return {
    error: "Rate limit exceeded",
    cooldown: true,
    feature,
    reason: slot.reason,
    retry_after_seconds: slot.retryAfterSeconds,
  };
}
