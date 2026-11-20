// One drona-push run, against a small database interface so run.test.ts can
// drive it with an in-memory fake. index.ts wires the real tables.
//
// Order of a run:
//   1. read receipts of earlier sends (15 min to 3 days old) and delete the
//      tokens Expo says are gone,
//   2. read candidates, decide with _shared/lapsePush.ts,
//   3. CLAIM the lapse (insert push_sends, unique per lapse) BEFORE sending, so
//      two overlapping runs can never both send. When Expo took nothing (a
//      blip), the claim is let go and the next run retries. When every phone
//      is dead, it stays (status failed): nothing to retry to. A failed
//      send does not start the 7-day cooldown (get_food_lapse_candidates).
//   4. send, record tickets, delete tokens reported dead on the spot.

import { decideFoodLapse, lapseWords, pushTarget } from "../_shared/lapsePush.ts";
import { deadTokens, type PushMessage, type PushResult } from "../_shared/expoPush.ts";

export type Candidate = {
  user_id: string;
  tz: string;
  today: string;
  hour: number;
  days: string[];
  last_push_at: string | null;
  tokens: string[];
};

export type Ticket = { token: string; ticket: string | null; error: string | null };

export interface PushDb {
  candidates(now: string): Promise<Candidate[]>;
  /** Insert the push_sends row. false when this lapse already has one. */
  claim(userId: string, lapseKey: string, title: string, body: string): Promise<boolean>;
  record(userId: string, lapseKey: string, tickets: Ticket[], status: "sent" | "failed"): Promise<void>;
  /** Delete claims still 'claimed' from before this moment (a run died mid-send). Returns how many. */
  releaseStaleClaims(before: string): Promise<number>;
  /** Delete the claim: Expo never took the push, so the next run may try again. */
  release(userId: string, lapseKey: string): Promise<void>;
  deleteTokens(tokens: string[]): Promise<void>;
  /** Sends with tickets whose receipts are unread, sent between the two moments. */
  unreadReceipts(from: string, to: string): Promise<{ id: number; tickets: Ticket[] }[]>;
  markReceiptsRead(ids: number[]): Promise<void>;
}

export interface PushApi {
  send(messages: PushMessage[]): Promise<PushResult[]>;
  receipts(ids: string[]): Promise<Record<string, { status: string; error?: string }>>;
}

export type RunReport = {
  candidates: number;
  sent: number;
  skipped: Record<string, number>;
  deadTokens: number;
  receiptsRead: number;
  staleClaims: number;
};

const MIN = 60_000;
/**
 * No new send starts after this long. The cron call times out at 55 s; one
 * send is a claim, an Expo call and a record. Who is left waits an hour (the
 * claim is unique per lapse, so nobody gets two).
 */
export const RUN_BUDGET_MS = 40_000;

type RunOpts = { dryRun?: boolean; clock?: () => number; budgetMs?: number };

export async function runPush(db: PushDb, api: PushApi, now: Date, opts: RunOpts = {}): Promise<RunReport> {
  const report: RunReport = { candidates: 0, sent: 0, skipped: {}, deadTokens: 0, receiptsRead: 0, staleClaims: 0 };
  const clock = opts.clock ?? Date.now;
  const started = clock(); // the budget covers the whole run, receipts too
  // A run that died between claim and record left 'claimed' rows. Every
  // finished send records within seconds, so a claim older than 15 min is
  // dead: let it go, so its lapse is sent now and holds no cooldown.
  if (!opts.dryRun) report.staleClaims = await db.releaseStaleClaims(new Date(now.getTime() - 15 * MIN).toISOString());
  const dead = new Set<string>();

  // 1. Receipts. A dry run changes nothing, so it reads none.
  const pending = opts.dryRun ? [] : await db.unreadReceipts(
    new Date(now.getTime() - 3 * 24 * 60 * MIN).toISOString(), // Expo keeps receipts a day; 3 days covers a skipped run
    new Date(now.getTime() - 15 * MIN).toISOString(),
  );
  const byTicket = new Map<string, string>();
  for (const p of pending) for (const t of p.tickets) if (t.ticket) byTicket.set(t.ticket, t.token);
  if (byTicket.size > 0) {
    const receipts = await api.receipts([...byTicket.keys()]);
    for (const [id, r] of Object.entries(receipts)) {
      if (r.error === "DeviceNotRegistered" && byTicket.has(id)) dead.add(byTicket.get(id)!);
      else if (r.status === "error") console.error(`drona-push receipt ${id}: ${r.error ?? "error"}`);
    }
    // Only rows whose every ticket came back are done; the rest wait a run.
    const done = pending.filter((p) => p.tickets.every((t) => !t.ticket || t.ticket in receipts)).map((p) => p.id);
    if (done.length) await db.markReceiptsRead(done);
    report.receiptsRead = done.length;
  } else if (pending.length) {
    await db.markReceiptsRead(pending.map((p) => p.id));
  }

  // 2-4. Decide, claim, send. Dead tokens are deleted even if the run breaks.
  try {
    await sendAll(db, api, now, opts, report, dead, started);
  } finally {
    // Never let the cleanup hide the error that broke the run.
    if (dead.size && !opts.dryRun) await db.deleteTokens([...dead]).catch((e) => console.error(`drona-push deleteTokens: ${e}`));
    report.deadTokens = dead.size;
  }
  return report;
}

async function sendAll(
  db: PushDb,
  api: PushApi,
  now: Date,
  opts: RunOpts,
  report: RunReport,
  dead: Set<string>,
  started: number,
): Promise<void> {
  const clock = opts.clock ?? Date.now;
  const budget = opts.budgetMs ?? RUN_BUDGET_MS;
  const people = await db.candidates(now.toISOString());
  report.candidates = people.length;
  for (const c of people) {
    const d = decideFoodLapse({ today: c.today, hour: c.hour, days: c.days, lastPushAt: c.last_push_at, now: now.toISOString() });
    if (!d.send || !d.lapseKey) {
      report.skipped[d.reason] = (report.skipped[d.reason] ?? 0) + 1;
      continue;
    }
    const tokens = c.tokens.filter((t) => !dead.has(t));
    if (tokens.length === 0) {
      report.skipped.no_token = (report.skipped.no_token ?? 0) + 1;
      continue;
    }
    if (!opts.dryRun && clock() - started > budget) {
      report.skipped.out_of_time = (report.skipped.out_of_time ?? 0) + 1;
      continue;
    }
    if (opts.dryRun) {
      report.skipped.dry_run = (report.skipped.dry_run ?? 0) + 1;
      continue;
    }
    const words = lapseWords(c.user_id, d.lapseKey);
    if (!(await db.claim(c.user_id, d.lapseKey, words.title, words.body))) {
      report.skipped.already_sent = (report.skipped.already_sent ?? 0) + 1;
      continue;
    }
    // One person's Expo error must not stop everyone after them. The claim
    // stays (status failed): a row left 'claimed' means the run died mid-send.
    let results: PushResult[];
    try {
      results = await api.send(tokens.map((to) => ({
        to,
        title: words.title,
        body: words.body,
        data: pushTarget(),
        sound: "default",
        channelId: "default",
      })));
    } catch (e) {
      results = tokens.map((token) => ({ token, error: `send_threw: ${(e as Error).message}`.slice(0, 200) }));
    }
    for (const t of deadTokens(results)) dead.add(t);
    // Expo took none of it (request failed, threw, rate limited) and no phone
    // is dead: nothing reached anyone, so let the claim go and retry next hour.
    // No phone got it, and at least one failed for a reason that can pass
    // (not dead, not malformed): retry next hour. Dead phones are already in `dead`.
    const transient = results.every((r) => !r.ticketId) &&
      results.some((r) => r.error !== "DeviceNotRegistered" && r.error !== "bad_token");
    if (transient) {
      await db.release(c.user_id, d.lapseKey);
      report.skipped.send_failed = (report.skipped.send_failed ?? 0) + 1;
      continue;
    }
    const tickets: Ticket[] = results.map((r) => ({ token: r.token, ticket: r.ticketId ?? null, error: r.error ?? null }));
    const ok = tickets.some((t) => t.ticket);
    await db.record(c.user_id, d.lapseKey, tickets, ok ? "sent" : "failed");
    if (ok) report.sent++;
  }
}
