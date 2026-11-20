// Sends push notifications through Expo's push service, and says which tokens
// are dead. Expo hands each message to APNs / FCM; the app's token comes from
// expo-notifications (getExpoPushTokenAsync).
//
// A token is dead when Expo answers DeviceNotRegistered, either straight away
// (the ticket) or later (the receipt, readReceipts). The caller deletes those
// rows from push_tokens. Any other error keeps the token: a failed request or
// a rate limit says nothing about the phone.
//
// Unit-tested in expoPush.test.ts with a fake fetch.

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo takes at most 100 messages per send and 1000 ids per receipts read. */
export const EXPO_CHUNK = 100;
const RECEIPT_CHUNK = 1000;

export type PushMessage = {
  to: string;
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  /** Android channel. */
  channelId?: string;
};

export type PushResult = {
  token: string;
  ticketId?: string;
  /** Expo's error code (DeviceNotRegistered, MessageRateExceeded, ...), or ours: request_failed, bad_token. */
  error?: string;
};

type Opts = { fetch?: typeof fetch; accessToken?: string };

export function isExpoPushToken(t: unknown): t is string {
  return typeof t === "string" && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
}

function headers(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

export async function sendExpoPush(messages: PushMessage[], opts: Opts = {}): Promise<PushResult[]> {
  const f = opts.fetch ?? fetch;
  const results: PushResult[] = messages.map((m) => ({ token: m.to }));
  const ok = messages.map((m, i) => ({ m, i })).filter(({ m, i }) => {
    if (isExpoPushToken(m.to)) return true;
    results[i].error = "bad_token";
    return false;
  });

  for (let s = 0; s < ok.length; s += EXPO_CHUNK) {
    const chunk = ok.slice(s, s + EXPO_CHUNK);
    let tickets: { status?: string; id?: string; details?: { error?: string } }[] | null = null;
    try {
      const res = await f(EXPO_SEND_URL, {
        method: "POST",
        headers: headers(opts.accessToken),
        body: JSON.stringify(chunk.map(({ m }) => m)),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.data)) tickets = body.data;
    } catch {
      tickets = null;
    }
    chunk.forEach(({ i }, k) => {
      const t = tickets?.[k];
      if (!t) results[i].error = "request_failed";
      else if (t.status === "ok" && t.id) results[i].ticketId = t.id;
      else results[i].error = t.details?.error ?? "error";
    });
  }
  return results;
}

/** Tokens Expo says are gone for good: delete them. */
export function deadTokens(results: PushResult[]): string[] {
  return results.filter((r) => r.error === "DeviceNotRegistered").map((r) => r.token);
}

/** Receipts by ticket id. Read them 15 minutes or more after the send. */
export async function readReceipts(
  ids: string[],
  opts: Opts = {},
): Promise<Record<string, { status: string; error?: string }>> {
  const f = opts.fetch ?? fetch;
  const out: Record<string, { status: string; error?: string }> = {};
  for (let s = 0; s < ids.length; s += RECEIPT_CHUNK) {
    try {
      const res = await f(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: headers(opts.accessToken),
        body: JSON.stringify({ ids: ids.slice(s, s + RECEIPT_CHUNK) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.data || typeof body.data !== "object") continue;
      for (const [id, r] of Object.entries(body.data as Record<string, { status?: string; details?: { error?: string } }>)) {
        out[id] = { status: r?.status ?? "unknown", error: r?.details?.error };
      }
    } catch {
      /* unread receipts are read on the next run */
    }
  }
  return out;
}
