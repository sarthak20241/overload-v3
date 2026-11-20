// The manual send: our own push, to chosen accounts or to everyone with a
// phone. drona-push mode "send" (same x-cron-secret as the cron), see index.ts.
//
// Safe to run twice: each (user, campaign) is claimed in push_sends (kind
// 'manual', lapse_key = campaign), so a retry or a second call with the same
// campaign id never sends a second copy. People outside 09:00-21:00 on their
// own clock are skipped unless respect_quiet_hours is false; send again later
// with the same campaign id to reach them (the ones already sent are skipped).

import { deadTokens, type PushResult } from "../_shared/expoPush.ts";
import { passes, type PushApi, type PushDb, RUN_BUDGET_MS, type Ticket } from "./run.ts";

export const MANUAL_FROM_HOUR = 9;
export const MANUAL_UNTIL_HOUR = 21;
const MAX_USERS = 1000;
/** Where a tap lands. The app maps these in lib/pushAsk.ts (pushRoute). */
export const SCREENS = ["home", "nutrition"] as const;
export type Screen = typeof SCREENS[number];

export type SendRequest = {
  campaign: string;
  title: string;
  body: string;
  screen: Screen;
  /** null = everyone with a phone. */
  userIds?: string[] | null;
  respectQuietHours: boolean;
  dryRun: boolean;
};

export type Target = { user_id: string; hour: number; tokens: string[] };

export type ManualDb = Pick<PushDb, "claim" | "record" | "release" | "deleteTokens"> & {
  targets(userIds: string[] | null): Promise<Target[]>;
};

export type ManualReport = {
  campaign: string;
  targets: number;
  sent: number;
  wouldSend: number;
  skipped: Record<string, number>;
  deadTokens: number;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function parseSendRequest(raw: Record<string, unknown>): { req: SendRequest } | { error: string } {
  const campaign = str(raw.campaign);
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/i.test(campaign)) return { error: "campaign: 3-64 letters, digits, - or _" };
  const title = str(raw.title);
  if (!title || title.length > 60) return { error: "title: 1-60 characters" };
  const body = str(raw.body);
  if (!body || body.length > 200) return { error: "body: 1-200 characters" };
  const screen = (raw.screen ?? "home") as Screen;
  if (!SCREENS.includes(screen)) return { error: `screen: one of ${SCREENS.join(", ")}` };
  const all = raw.all === true;
  const ids = Array.isArray(raw.user_ids) ? raw.user_ids.filter((u): u is string => typeof u === "string" && u.length > 0) : null;
  if (all && ids) return { error: "give user_ids or all, not both" };
  if (!all && (!ids || ids.length === 0)) return { error: "give user_ids (a list) or all: true" };
  if (ids && ids.length > MAX_USERS) return { error: `at most ${MAX_USERS} user_ids per call` };
  return {
    req: {
      campaign, title, body, screen,
      userIds: all ? null : [...new Set(ids)],
      respectQuietHours: raw.respect_quiet_hours !== false,
      dryRun: raw.dry_run === true,
    },
  };
}

export async function runManualSend(
  db: ManualDb,
  api: PushApi,
  _now: Date,
  req: SendRequest,
  opts: { clock?: () => number; budgetMs?: number } = {},
): Promise<ManualReport> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budget = opts.budgetMs ?? RUN_BUDGET_MS;
  const targets = await db.targets(req.userIds ?? null);
  const report: ManualReport = { campaign: req.campaign, targets: targets.length, sent: 0, wouldSend: 0, skipped: {}, deadTokens: 0 };
  const skip = (why: string) => { report.skipped[why] = (report.skipped[why] ?? 0) + 1; };
  const dead = new Set<string>();

  try {
    for (const t of targets) {
      if (t.tokens.length === 0) { skip("no_token"); continue; }
      if (req.respectQuietHours && (t.hour < MANUAL_FROM_HOUR || t.hour >= MANUAL_UNTIL_HOUR)) { skip("quiet_hours"); continue; }
      if (req.dryRun) { report.wouldSend++; continue; }
      if (clock() - started > budget) { skip("out_of_time"); continue; }
      if (!(await db.claim(t.user_id, req.campaign, req.title, req.body, "manual"))) { skip("already_sent"); continue; }

      let results: PushResult[];
      try {
        results = await api.send(t.tokens.map((to) => ({
          to,
          title: req.title,
          body: req.body,
          data: { type: "drona", screen: req.screen, campaign: req.campaign },
          sound: "default",
          channelId: "default",
        })));
      } catch (e) {
        results = t.tokens.map((token) => ({ token, error: `send_threw: ${(e as Error).message}`.slice(0, 200) }));
      }
      for (const d of deadTokens(results)) dead.add(d);
      if (results.every((r) => !r.ticketId) && results.some((r) => passes(r.error))) {
        await db.release(t.user_id, req.campaign, "manual"); // a blip: the same campaign can be sent again
        skip("send_failed");
        continue;
      }
      const tickets: Ticket[] = results.map((r) => ({ token: r.token, ticket: r.ticketId ?? null, error: r.error ?? null }));
      const ok = tickets.some((x) => x.ticket);
      await db.record(t.user_id, req.campaign, tickets, ok ? "sent" : "failed", "manual");
      if (ok) report.sent++;
    }
  } finally {
    if (dead.size) await db.deleteTokens([...dead]).catch((e) => console.error(`drona-push deleteTokens: ${e}`));
    report.deadTokens = dead.size;
  }
  return report;
}
