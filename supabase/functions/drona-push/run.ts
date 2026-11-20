// One drona-push run, against a small database interface so run.test.ts can
// drive it with an in-memory fake. index.ts wires the real tables.
//
// Order of a run:
//   1. read receipts of earlier sends (15 min to 3 days old) and delete the
//      tokens Expo says are gone,
//   2. read candidates, decide with _shared/lapsePush.ts,
//   3. CLAIM the lapse (insert push_sends, unique per lapse) BEFORE sending, so
//      two overlapping runs can never both send. A claim whose send fails stays
//      claimed (status failed): one missed push is better than a double one. A failed
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
};

const MIN = 60_000;

export async function runPush(db: PushDb, api: PushApi, now: Date, opts: { dryRun?: boolean } = {}): Promise<RunReport> {
  const report: RunReport = { candidates: 0, sent: 0, skipped: {}, deadTokens: 0, receiptsRead: 0 };
  const dead = new Set<string>();

  // 1. Receipts.
  const pending = await db.unreadReceipts(
    new Date(now.getTime() - 3 * 24 * 60 * MIN).toISOString(), // Expo keeps receipts a day; 3 days covers a skipped run
    new Date(now.getTime() - 15 * MIN).toISOString(),
  );
  const byTicket = new Map<string, string>();
  for (const p of pending) for (const t of p.tickets) if (t.ticket) byTicket.set(t.ticket, t.token);
  if (byTicket.size > 0) {
    const receipts = await api.receipts([...byTicket.keys()]);
    for (const [id, r] of Object.entries(receipts)) {
      if (r.error === "DeviceNotRegistered" && byTicket.has(id)) dead.add(byTicket.get(id)!);
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
    await sendAll(db, api, now, opts, report, dead);
  } finally {
    // Never let the cleanup hide the error that broke the run.
    if (dead.size) await db.deleteTokens([...dead]).catch((e) => console.error(`drona-push deleteTokens: ${e}`));
    report.deadTokens = dead.size;
  }
  return report;
}

async function sendAll(
  db: PushDb,
  api: PushApi,
  now: Date,
  opts: { dryRun?: boolean },
  report: RunReport,
  dead: Set<string>,
): Promise<void> {
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
    const tickets: Ticket[] = results.map((r) => ({ token: r.token, ticket: r.ticketId ?? null, error: r.error ?? null }));
    const ok = tickets.some((t) => t.ticket);
    await db.record(c.user_id, d.lapseKey, tickets, ok ? "sent" : "failed");
    if (ok) report.sent++;
  }
}
