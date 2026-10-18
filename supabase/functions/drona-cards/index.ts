// Drona cards worker (P0). One card per user per LOCAL week, or nothing.
//
//   cron  pg_cron posts {"mode":"cron"} every 15 minutes with x-cron-secret,
//         checked against the database (drona_cards_cron_ok). Users whose local
//         Monday has begun and who have no row for that week get one.
//   app   the app posts {"mode":"app"} with its Clerk JWT when it sees no card
//         for the current week. HealthKit weight only lands when the app opens,
//         so the Monday run can be reading a stale scale for someone who was
//         away; the app path is how that user still gets a card.
//
// The weekly card, first match wins: the new-user notice, the permanent swap,
// the behaviour pick (get_drona_pick_facts + _shared/dronaPick.ts: what last
// week's behaviours found, in fixed words), then the older P0 rules
// (get_drona_facts + _shared/dronaCards.ts). The calorie check-in is a second,
// separate card per week (slot 'calories', _shared/dronaEnergy.ts). Nothing to
// say writes nothing, which is most weeks. B1 (the model's calorie card) is
// retired here: the check-in owns calories (.planning/drona-cards-pick.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { decideCard, type DronaFacts, onCooldown, signalsFrom, weekStartOf } from "../_shared/dronaCards.ts";
import { decideSwap, type SwapFacts, swapCard } from "../_shared/dronaSwap.ts";
import { checkinCooldown, decideEnergyCard, type EnergyFacts } from "../_shared/dronaEnergy.ts";
import { decidePick, hushed, mutedTopics, type PickFacts } from "../_shared/dronaPick.ts";
import { isTimeZone, wallClock } from "../_shared/wallClock.ts";
import { retried } from "../_shared/retried.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER") ?? "";
const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

const USER_PAGE = 1000;
const CRON_CONCURRENCY = 4;
/** Cards older than this are history nobody reads; the facts window is 8 weeks. */
const KEEP_WEEKS = 26;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const admin = () =>
  createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function clerkUserId(authHeader: string | null): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(authHeader.slice(7), JWKS, { issuer: CLERK_ISSUER });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Tag a write so the plan change log records WHO changed the plan (0123). */
function tagged<T>(request: T, cardId: string): T {
  const r = request as unknown as { setHeader?: (name: string, value: string) => void };
  r.setHeader?.("x-change-source", "card");
  r.setHeader?.("x-change-card", cardId);
  return request;
}

/**
 * The permanent swap (C2 / H1). Checked BEFORE the weekly rules: a habit the
 * user already built is more concrete than any nudge, and it is the only card
 * that changes the plan without a model.
 *
 * A run of 4 applies itself and the notice carries Undo. A run of 3, or the
 * auto-adjust setting off, asks first. When the routine has moved on since the
 * facts were read the card is deleted again: a notice nobody acted on is a lie.
 */
async function swapFirst(
  db: SupabaseClient,
  userId: string,
  localDay: string,
  weekStart: string,
  source: "cron" | "app",
): Promise<{ kind: string; saved: boolean; error?: string } | null> {
  const { data, error } = await retried(() =>
    db.rpc("get_drona_swap_facts", { p_user_id: userId, p_as_of: localDay })
  );
  if (error || !data) return null;

  const { move, candidate } = decideSwap(data as SwapFacts);
  if (move === "none" || !candidate) return null;

  const card = swapCard(candidate, move);
  const { data: row, error: insErr } = await retried(() =>
    db.from("drona_cards").insert({
      user_id: userId,
      week_start: weekStart,
      kind: card.kind,
      topic: card.topic,
      title: card.title,
      body: card.body,
      evidence: card.evidence,
      payload: card.payload,
      signals: card.signals,
      facts: data,
      source,
    }).select("id").single()
  );
  if (insErr) {
    // 23505: this week's card already exists. Not a failure, and not ours.
    return (insErr as { code?: string }).code === "23505"
      ? { kind: card.kind, saved: false }
      : { kind: card.kind, saved: false, error: insErr.message };
  }
  if (move === "ask") return { kind: card.kind, saved: true };

  const cardId = row!.id as string;
  const { data: result, error: applyErr } = await retried(() =>
    tagged(db.rpc("drona_swap_autoapply", { p_card_id: cardId }), cardId)
  );
  if (applyErr || result !== "ok") {
    // Delete the notice ONLY where the routine plainly did not change. If that
    // read fails too, keep the card: a stale card is a smaller harm than a
    // changed plan with no Undo on it.
    const { data: slot } = await retried(() =>
      db.from("routine_exercises").select("exercise_id")
        .eq("id", card.payload.routine_exercise_id).maybeSingle()
    );
    if (slot && slot.exercise_id !== card.payload.to_exercise_id) {
      await retried(() => db.from("drona_cards").delete().eq("id", cardId));
      return null;
    }
  }
  return { kind: card.kind, saved: true };
}

/**
 * The calorie check-in (20261018091823_drona_calorie_checkin): its own card
 * slot ('calories'), apart from the weekly Drona card, so a calorie step is
 * never pushed out by a lift-stall or a swap. The database keeps a maintenance
 * estimate that starts at the app's formula and moves toward the person's real
 * number as weigh-ins and whole food days arrive; last week's behaviours say
 * whether to ask for that data or to move the calorie target (and the
 * program's future phases with it). get_drona_energy_facts rebuilds the facts
 * first when the daily job has not reached this person yet today, so a Monday
 * check-in reads the week that just ended. Rules only, no model. Nothing to say
 * writes nothing.
 */
async function checkin(
  db: SupabaseClient,
  userId: string,
  localDay: string,
  weekStart: string,
  source: "cron" | "app",
): Promise<{ kind: string; saved: boolean; error?: string }> {
  const { data, error } = await retried(() =>
    db.rpc("get_drona_energy_facts", { p_user_id: userId, p_as_of: localDay })
  );
  if (error) return { kind: "none", saved: false, error: error.message };
  if (!data) return { kind: "hold", saved: false };
  const f = data as EnergyFacts;
  const card = decideEnergyCard(f, checkinCooldown(f.cards, weekStart));
  if (!card) return { kind: "hold", saved: false };
  const { error: insErr } = await retried(() =>
    db.from("drona_cards").insert({
      user_id: userId, week_start: weekStart, slot: "calories", kind: card.kind, topic: card.topic,
      title: card.title, body: card.body, evidence: card.evidence, payload: card.payload,
      signals: card.signals, facts: { energy: data }, source,
    })
  );
  // 23505: this week's check-in already exists. Not a failure.
  if (insErr && (insErr as { code?: string }).code !== "23505") {
    return { kind: card.kind, saved: false, error: insErr.message };
  }
  return { kind: card.kind, saved: !insErr };
}

/** Read one user's facts, decide, and write the card. A hold writes nothing. */
async function generate(
  db: SupabaseClient,
  userId: string,
  localDay: string,
  weekStart: string,
  source: "cron" | "app",
): Promise<{ kind: string; saved: boolean; error?: string }> {
  const { data: facts, error } = await retried(() =>
    db.rpc("get_drona_facts", { p_user_id: userId, p_as_of: localDay, p_week_start: weekStart })
  );
  if (error) return { kind: "none", saved: false, error: error.message };
  if (!facts) return { kind: "none", saved: false, error: "no facts" };

  // Too new to read a habit, and a swap just asked about waits its turn.
  const newUser = signalsFrom(facts as DronaFacts).new_user;
  if (!newUser && !onCooldown("swap", facts as DronaFacts)) {
    const swap = await swapFirst(db, userId, localDay, weekStart, source);
    if (swap) return swap;
  }

  // The behaviour pick: what last week's behaviours found. A failed read
  // falls through to the P0 rules (without mutes: they are not known then).
  const { data: pick, error: pickErr } = await retried(() =>
    db.rpc("get_drona_pick_facts", { p_user_id: userId, p_as_of: localDay })
  );
  if (pickErr) console.error("[drona-cards] pick facts:", pickErr.message);
  const pf = pickErr ? null : (pick as PickFacts | null);
  const picked = newUser ? null : decidePick(pf, facts as DronaFacts);
  const card = picked ?? hushed(decideCard(facts as DronaFacts, undefined, mutedTopics(pf)), pf);
  if (card.kind === "hold") return { kind: "hold", saved: false };

  // Insert, never upsert: the cron and the app can race for the same week, and
  // the first card written is the one that stands.
  const { error: insErr } = await retried(() =>
    db.from("drona_cards").insert({
      user_id: userId,
      week_start: weekStart,
      kind: card.kind,
      topic: card.topic,
      title: card.title,
      body: card.body,
      evidence: card.evidence,
      payload: card.payload,
      signals: card.signals,
      facts: picked ? { ...(facts as Record<string, unknown>), pick: pf } : facts,
      source,
    })
  );
  // 23505: someone else wrote this week's card first. Not a failure.
  if (insErr && (insErr as { code?: string }).code !== "23505") {
    return { kind: card.kind, saved: false, error: insErr.message };
  }
  return { kind: card.kind, saved: !insErr };
}

async function runCron(): Promise<Response> {
  const db = admin();
  const now = new Date();
  const cutoff = new Date(now.getTime() - KEEP_WEEKS * 7 * 86_400_000).toISOString().slice(0, 10);
  const prune = retried(() => db.from("drona_cards").delete().lt("week_start", cutoff));

  try {
    // PostgREST caps a read at 1000 rows: page, or users past the first
    // thousand silently never get a card.
    const users: { clerk_user_id: string | null; timezone: string | null }[] = [];
    for (let from = 0; ; from += USER_PAGE) {
      const { data, error } = await retried(() =>
        db.from("user_profiles").select("clerk_user_id, timezone").not("timezone", "is", null)
          .order("clerk_user_id", { ascending: true }).range(from, from + USER_PAGE - 1)
      );
      if (error) return json({ error: error.message, stage: "users" }, 500);
      users.push(...(data ?? []));
      if (!data || data.length < USER_PAGE) break;
    }

    const weeks = users
      .filter((u) => u.clerk_user_id && isTimeZone(u.timezone))
      .map((u) => {
        const day = wallClock(now, u.timezone as string)!.slice(0, 10);
        return { userId: u.clerk_user_id as string, day, week: weekStartOf(day) };
      })
      .filter((u): u is { userId: string; day: string; week: string } => !!u.week);

    // Who already has this week's card, per slot (from an earlier run, or the
    // app): the weekly Drona card and the calorie check-in are due apart.
    const weekStarts = [...new Set(weeks.map((w) => w.week))];
    const have = new Set<string>();
    if (weekStarts.length > 0) {
      for (let from = 0; ; from += USER_PAGE) {
        const { data: rows, error: rowsErr } = await retried(() =>
          db.from("drona_cards").select("user_id, week_start, slot").in("week_start", weekStarts)
            .order("user_id", { ascending: true }).order("slot", { ascending: true })
            .range(from, from + USER_PAGE - 1)
        );
        if (rowsErr) return json({ error: rowsErr.message, stage: "existing" }, 500);
        for (const r of rows ?? []) have.add(`${r.user_id}|${r.week_start}|${r.slot ?? "weekly"}`);
        if (!rows || rows.length < USER_PAGE) break;
      }
    }
    const due = weeks
      .map((w) => ({
        ...w,
        checkin: !have.has(`${w.userId}|${w.week}|calories`),
        weekly: !have.has(`${w.userId}|${w.week}|weekly`),
      }))
      .filter((w) => w.checkin || w.weekly);

    let saved = 0;
    let held = 0;
    let checkins = 0;
    const failures: string[] = [];
    for (let i = 0; i < due.length; i += CRON_CONCURRENCY) {
      const batch = due.slice(i, i + CRON_CONCURRENCY);
      const results = await Promise.all(batch.map(async (w) => {
        // The check-in first, so the weekly card sees it and does not ask for
        // the same weigh-in or food days again.
        const c = w.checkin ? await checkin(db, w.userId, w.day, w.week, "cron") : null;
        const g = w.weekly ? await generate(db, w.userId, w.day, w.week, "cron") : null;
        return { c, g };
      }));
      results.forEach(({ c, g }, j) => {
        if (c?.saved) checkins += 1;
        else if (c?.error) failures.push(`${batch[j].userId.slice(0, 12)} check-in: ${c.error}`);
        if (!g) return;
        if (g.saved) saved += 1;
        else if (g.kind === "hold") held += 1;
        else failures.push(`${batch[j].userId.slice(0, 12)}: ${g.error ?? "not saved"}`);
      });
    }

    return json({ users: weeks.length, due: due.length, saved, held, checkins, failures: failures.slice(0, 20) });
  } finally {
    // Settled on every path: the runtime may stop the worker once the response
    // is out, and an abandoned delete may never land.
    const pruned = await prune;
    if (pruned.error) console.error("[drona-cards] prune failed:", pruned.error.message);
  }
}

async function runApp(req: Request, body: Record<string, unknown>): Promise<Response> {
  const userId = await clerkUserId(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const db = admin();
  const { data: profile, error } = await retried(() =>
    db.from("user_profiles").select("timezone").eq("clerk_user_id", userId).maybeSingle()
  );
  if (error) return json({ error: error.message }, 500);

  const tz = isTimeZone(body.tz) ? body.tz : profile?.timezone;
  if (!isTimeZone(tz)) return json({ error: "tz must be an IANA time zone" }, 400);
  // Keep the zone current: it is what the weekly run uses. No-op when unchanged.
  if (profile?.timezone !== tz) {
    await retried(() => db.from("user_profiles").update({ timezone: tz }).eq("clerk_user_id", userId));
  }

  const day = wallClock(new Date(), tz)!.slice(0, 10);
  const week = weekStartOf(day);
  if (!week) return json({ error: "bad day" }, 500);

  // The check-in first (it writes nothing when it has nothing to say, or when
  // this week's already exists), then the weekly card.
  const check = await checkin(db, userId, day, week, "app");
  if (check.error) console.error("[drona-cards] check-in:", check.error);
  // The app also asks when only the check-in is missing. A weekly card that
  // already exists is never decided again: B1 would pay for a model call whose
  // card the insert then refuses.
  const { data: hasWeekly } = await retried(() =>
    db.from("drona_cards").select("id").eq("user_id", userId).eq("week_start", week).eq("slot", "weekly").maybeSingle()
  );
  const result = hasWeekly
    ? { kind: "existing", saved: false }
    : await generate(db, userId, day, week, "app");
  if (!result.saved && "error" in result && result.error) return json({ error: result.error }, 500);

  const { data: rows } = await retried(() =>
    db.from("drona_cards").select("*").eq("user_id", userId).eq("week_start", week)
  );
  const row = (rows ?? []).find((r) => (r.slot ?? "weekly") === "weekly") ?? null;
  const checkinRow = (rows ?? []).find((r) => r.slot === "calories") ?? null;
  return json({ week_start: week, kind: result.kind, card: row, checkin: checkinRow });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  if (body.mode === "cron") {
    const secret = req.headers.get("x-cron-secret") ?? "";
    const { data: ok, error } = await retried(() => admin().rpc("drona_cards_cron_ok", { p_secret: secret }));
    if (error) return json({ error: error.message }, 500);
    if (ok !== true) return json({ error: "Unauthorized" }, 401);
    return runCron();
  }
  if (body.mode === "app") return runApp(req, body);
  return json({ error: "mode must be cron or app" }, 400);
});
