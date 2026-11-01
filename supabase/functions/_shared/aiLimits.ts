// AI allowances, shared by enforcement and app help.
//
// Free: a hard rolling 24-hour allowance. Changes must also update
// get_coach_access_status() in the database, which supplies the client meter.
//
// Pro and trial: no daily stop, only a cooldown (PRO_COOLDOWN below). The
// rules live in the try_reserve_*_slot_cooldown RPCs (migration
// 20261026120000_pro_ai_cooldown.sql), which take these numbers as arguments,
// so this file is the one place they are set.
export const AI_LIMITS = {
  freeChat: 3,
  freeFood: 3,
  // The old Pro daily caps. Enforced ONLY while the cooldown migration is not
  // applied yet (reserveProSlot falls back to the old RPC), so a deploy that
  // lands before the migration keeps today's behaviour instead of failing.
  legacyProChat: 30,
  legacyProFood: 40,
} as const;

export interface CooldownRule {
  /** At most this many requests in any `burstWindowSeconds`. */
  burst: number;
  burstWindowSeconds: number;
  /** Past this many requests in a rolling 24 hours, requests are spaced... */
  heavyAfter: number;
  /** ...at least this far apart. */
  heavyGapSeconds: number;
}

// Set from production use on 2026-10-26: the busiest Pro account peaked at
// 13 chat messages / 12 food logs in 10 minutes, and 29 chat / 39 food in a
// day. A person never meets these; a script does, and then waits minutes,
// never a day.
export const PRO_COOLDOWN: { chat: CooldownRule; food: CooldownRule } = {
  chat: { burst: 20, burstWindowSeconds: 600, heavyAfter: 100, heavyGapSeconds: 600 },
  food: { burst: 20, burstWindowSeconds: 600, heavyAfter: 100, heavyGapSeconds: 300 },
};
