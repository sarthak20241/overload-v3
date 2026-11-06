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
  // 9 since 2026-11-05 (was 3): new free users ran out of AI food logs within
  // hours of joining. Raised quietly to watch real use; the app's own copy
  // (profile, paywall) still says 3, on purpose. Two places say 9, also on
  // purpose: the cap-hit line (it reads the server's number) and Drona's app
  // guide (appGuide.ts), which must state the real limit if asked.
  freeFood: 9,
  // One Drona goal plan per free account, for life: the onboarding build plus
  // turns of the Goal screen's program chat. Enforced by
  // try_claim_free_goal_turn (migration 20261106130000), which must hold the
  // same numbers: freeGoalBuild.test.ts runs that SQL against these. Drona's
  // app guide states them.
  freeGoalBuilds: 1,
  freeGoalEditTurns: 8,
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
