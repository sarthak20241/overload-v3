// drona-push: Drona's server push. Today one kind: the "food logging went
// quiet" nudge (_shared/lapsePush.ts holds the rules, run.ts the run).
//
//   cron  pg_cron posts {"mode":"cron"} hourly with x-cron-secret, checked
//         against the database (drona_push_cron_ok, 20261120120100).
//   dry   same secret, {"mode":"dry"}: decides and reports, claims and sends
//         nothing. For checking who WOULD get a push before turning it on.
//
// Sends through Expo (_shared/expoPush.ts). EXPO_ACCESS_TOKEN is optional: set
// it only if the Expo project turns on "enhanced push security".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { readReceipts, sendExpoPush } from "../_shared/expoPush.ts";
import { SEND_FROM_HOUR, SEND_UNTIL_HOUR } from "../_shared/lapsePush.ts";
import { retried } from "../_shared/retried.ts";
import { type Candidate, type PushApi, type PushDb, runPush, type Ticket } from "./run.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const EXPO_ACCESS_TOKEN = Deno.env.get("EXPO_ACCESS_TOKEN") ?? undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function realDb(db: SupabaseClient): PushDb {
  return {
    async candidates(now) {
      const { data, error } = await retried(() => db.rpc("get_food_lapse_candidates", { p_now: now, p_from_hour: SEND_FROM_HOUR, p_until_hour: SEND_UNTIL_HOUR }));
      if (error) throw new Error(`candidates: ${error.message}`);
      return (data ?? []) as Candidate[];
    },
    async claim(userId, lapseKey, title, body) {
      const { error } = await retried(() =>
        db.from("push_sends").insert({ user_id: userId, kind: "food_lapse", lapse_key: lapseKey, title, body })
      );
      if (!error) return true;
      if ((error as { code?: string }).code === "23505") return false;
      throw new Error(`claim: ${error.message}`);
    },
    async record(userId, lapseKey, tickets, status) {
      const { error } = await retried(() =>
        db.from("push_sends").update({ tickets, status })
          .eq("user_id", userId).eq("kind", "food_lapse").eq("lapse_key", lapseKey)
      );
      if (error) console.error(`drona-push record ${userId}: ${error.message}`);
    },
    async deleteTokens(tokens) {
      const { error } = await retried(() => db.from("push_tokens").delete().in("token", tokens));
      if (error) console.error(`drona-push deleteTokens: ${error.message}`);
    },
    async unreadReceipts(from, to) {
      const { data } = await retried(() =>
        db.from("push_sends").select("id, tickets").eq("status", "sent").is("receipt_checked_at", null)
          .gte("sent_at", from).lte("sent_at", to).limit(1000)
      );
      return (data ?? []) as { id: number; tickets: Ticket[] }[];
    },
    async markReceiptsRead(ids) {
      const { error } = await retried(() =>
        db.from("push_sends").update({ receipt_checked_at: new Date().toISOString() }).in("id", ids)
      );
      if (error) console.error(`drona-push markReceiptsRead: ${error.message}`);
    },
  };
}

const api: PushApi = {
  send: (messages) => sendExpoPush(messages, { accessToken: EXPO_ACCESS_TOKEN }),
  receipts: (ids) => readReceipts(ids, { accessToken: EXPO_ACCESS_TOKEN }),
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({})) as { mode?: string };
  if (body.mode !== "cron" && body.mode !== "dry") return json({ error: "mode must be cron or dry" }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: ok, error } = await retried(() => db.rpc("drona_push_cron_ok", { p_secret: secret }));
  if (error) return json({ error: "secret check failed" }, 500);
  if (ok !== true) return json({ error: "unauthorized" }, 401);

  try {
    const report = await runPush(realDb(db), api, new Date(), { dryRun: body.mode === "dry" });
    return json({ ok: true, mode: body.mode, ...report });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
