// daily-suggestion: each user's TODAY pick, made at their local 00:00.
//
// Two callers:
//   cron  pg_cron posts {"mode":"cron"} every 15 minutes with x-cron-secret,
//         checked against the database (daily_suggestion_cron_ok, 0117).
//         Every real time zone's midnight lands on a quarter hour, so each user
//         whose day just began gets a row within that run. A missed run heals
//         on the next: any user with no row for their current day is filled.
//   app   the app posts {"mode":"app","tz":"Asia/Kolkata"} with its Clerk JWT
//         when it finds no row for today, or a row made from stale data (a new
//         program, a split just built, a workout that synced late). It also
//         keeps user_profiles.timezone current, which is what cron runs on.
//
// Rules live in ../_shared (the same files the app runs offline).
// Deploy with verify_jwt = false (config.toml): Clerk JWTs are verified here.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { buildSuggestion, type SuggestionProgram, type SuggestionRow } from "../_shared/dailySuggestion.ts";
import { isTimeZone, wallClock } from "../_shared/wallClock.ts";
import { retried } from "../_shared/retried.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER");
if (!CLERK_ISSUER) {
  throw new Error("CLERK_ISSUER env var is required (see ai-coach/index.ts).");
}

/** How far back workouts are read. Covers the longest phase the rest rule counts. */
const WORKOUT_WINDOW_DAYS = 200;
/** Saved picks older than this are deleted by the cron run. */
const KEEP_DAYS = 30;
const CRON_CONCURRENCY = 4;
const USER_PAGE = 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));
async function clerkUserId(authHeader: string | null): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(authHeader.slice(7), JWKS, { issuer: CLERK_ISSUER });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

const admin = () =>
  createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Read one user's inputs, build the pick for their current day, and save it. */
async function generate(
  db: SupabaseClient,
  userId: string,
  timeZone: string,
  now: Date,
  source: "cron" | "app",
): Promise<{ row: SuggestionRow | null; saved: boolean; error?: string }> {
  const since = new Date(now.getTime() - WORKOUT_WINDOW_DAYS * 86_400_000).toISOString();
  const [routinesRes, workoutsRes, programRes] = await Promise.all([
    retried(() => db.from("routines").select("id, name, created_at, program_phase_id").eq("user_id", userId)),
    retried(() => db.from("workouts").select("name, routine_id, started_at, finished_at, created_at")
      .eq("user_id", userId).gte("started_at", since)),
    retried(() => db.from("coach_programs").select("id, start_date").eq("user_id", userId).eq("status", "active").maybeSingle()),
  ]);
  // supabase-js resolves with { error } rather than throwing: never build a
  // pick from a half-read, it would be saved and held all day.
  const readErr = routinesRes.error ?? workoutsRes.error ?? programRes.error;
  if (readErr) return { row: null, saved: false, error: readErr.message };

  let program: SuggestionProgram | null = null;
  if (programRes.data) {
    const programId = programRes.data.id;
    const phasesRes = await retried(() => db.from("coach_program_phases")
      .select("id, duration_weeks, start_offset_weeks, training_block")
      .eq("program_id", programId).order("seq", { ascending: true }));
    if (phasesRes.error) return { row: null, saved: false, error: phasesRes.error.message };
    program = { id: programRes.data.id, start_date: String(programRes.data.start_date), phases: phasesRes.data ?? [] };
  }

  const row = buildSuggestion({
    routines: routinesRes.data ?? [],
    workouts: workoutsRes.data ?? [],
    program,
    timeZone,
    now,
  });
  if (!row) return { row: null, saved: false, error: "unknown time zone" };

  const { error: upErr } = await retried(() => db.from("daily_suggestions").upsert(
    { user_id: userId, ...row, source, updated_at: new Date().toISOString() },
    { onConflict: "user_id,day" },
  ));
  return { row, saved: !upErr, error: upErr?.message };
}

async function runCron(): Promise<Response> {
  const db = admin();
  const now = new Date();
  // The prune touches only days long past, so it runs beside the reads instead
  // of adding one more round trip (and its retries) to the end of every run.
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const prune = retried(() => db.from("daily_suggestions").delete().lt("day", cutoff));

  // PostgREST caps a read at 1000 rows: page through, or users past the first
  // thousand silently never get a midnight pick.
  const users: { clerk_user_id: string | null; timezone: string | null }[] = [];
  for (let from = 0; ; from += USER_PAGE) {
    const { data, error } = await retried(() => db.from("user_profiles")
      .select("clerk_user_id, timezone").not("timezone", "is", null)
      .order("clerk_user_id", { ascending: true })
      .range(from, from + USER_PAGE - 1));
    if (error) return json({ error: error.message, stage: "users" }, 500);
    users.push(...(data ?? []));
    if (!data || data.length < USER_PAGE) break;
  }

  const todays = users
    .filter((u) => u.clerk_user_id && isTimeZone(u.timezone))
    .map((u) => ({ userId: u.clerk_user_id as string, tz: u.timezone as string, day: wallClock(now, u.timezone as string)!.slice(0, 10) }));

  // Who already has a pick for their current day (made by the app, or an earlier run).
  const days = [...new Set(todays.map((t) => t.day))];
  const have = new Set<string>();
  if (days.length > 0) {
    for (let from = 0; ; from += USER_PAGE) {
      const { data: rows, error: rowsErr } = await retried(() => db.from("daily_suggestions").select("user_id, day")
        .in("day", days).order("user_id", { ascending: true }).range(from, from + USER_PAGE - 1));
      if (rowsErr) return json({ error: rowsErr.message, stage: "existing" }, 500);
      for (const r of rows ?? []) have.add(`${r.user_id}|${r.day}`);
      if (!rows || rows.length < USER_PAGE) break;
    }
  }
  const due = todays.filter((t) => !have.has(`${t.userId}|${t.day}`));

  let saved = 0;
  const failures: string[] = [];
  for (let i = 0; i < due.length; i += CRON_CONCURRENCY) {
    const batch = due.slice(i, i + CRON_CONCURRENCY);
    const results = await Promise.all(batch.map((t) => generate(db, t.userId, t.tz, now, "cron")));
    results.forEach((r, j) => {
      if (r.saved) saved += 1;
      else failures.push(`${batch[j].userId.slice(0, 12)}: ${r.error ?? "not saved"}`);
    });
  }

  const pruned = await prune;
  if (pruned.error) console.error("[daily-suggestion] prune failed:", pruned.error.message);

  return json({ users: todays.length, due: due.length, saved, failures: failures.slice(0, 20) });
}

async function runApp(req: Request, body: Record<string, unknown>): Promise<Response> {
  const userId = await clerkUserId(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);
  const tz = body.tz;
  if (!isTimeZone(tz)) return json({ error: "tz must be an IANA time zone" }, 400);

  const db = admin();
  // Keep the zone current: it is what the midnight run uses. No-op when unchanged.
  await db.from("user_profiles").update({ timezone: tz }).eq("clerk_user_id", userId).neq("timezone", tz);
  await db.from("user_profiles").update({ timezone: tz }).eq("clerk_user_id", userId).is("timezone", null);

  const result = await generate(db, userId, tz, new Date(), "app");
  if (!result.row) return json({ error: result.error ?? "could not build" }, 500);
  // A pick that failed to SAVE (e.g. no profile row yet) is still returned: the
  // card shows it now and the next open tries again.
  return json({ suggestion: result.row, saved: result.saved });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // empty body
  }
  if (body.mode === "cron") {
    const secret = req.headers.get("x-cron-secret") ?? "";
    const { data: ok, error } = await retried(() => admin().rpc("daily_suggestion_cron_ok", { p_secret: secret }));
    // A check that could not RUN is the API layer failing, not a bad secret.
    // Reporting it as 401 made three gateway 504s (2026-09-14 13:15) read as
    // a rotated secret.
    if (error) return json({ error: error.message, stage: "auth" }, 503);
    if (ok !== true) return json({ error: "Unauthorized" }, 401);
    return await runCron();
  }
  return await runApp(req, body);
});
