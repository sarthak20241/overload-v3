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
// The weekly card, first match wins:
//   1. pain the person told Drona about (the word step, _shared/dronaWords.ts)
//   2. the new-user notice
//   3. the permanent swap
//   4. the behaviour pick: last week's behaviours plus the word behaviours, in
//      fixed words (get_drona_pick_facts + _shared/dronaPick.ts)
//   5. the older P0 rules (get_drona_facts + _shared/dronaCards.ts)
// Nothing to say writes nothing, which is most weeks. The calorie check-in is
// a second, separate card per week (slot 'calories', _shared/dronaEnergy.ts). B1 (the model's calorie card) is
// retired here: the check-in owns calories (.planning/drona-cards-pick.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { decideCard, type DronaFacts, onCooldown, signalsFrom, weekStartOf } from "../_shared/dronaCards.ts";
import { decideSwap, type SwapFacts, swapCard } from "../_shared/dronaSwap.ts";
import { checkinCooldown, decideEnergyCard, type EnergyFacts } from "../_shared/dronaEnergy.ts";
import { askedLately, decidePick, hushed, mutedTopics, painFirst, type PickFacts } from "../_shared/dronaPick.ts";
import {
  chooseTexts, QUESTIONS, questionKey, readText, stateFor, type StoredSignal, type WordFacts, type WordText,
  wordBehaviours, wordSignals,
} from "../_shared/dronaWords.ts";
import { askJev } from "../ai-coach/jev.ts";
import { catchMemory, MEMORY_WRITER_MODEL, readMemoryRows, saveResult } from "../_shared/dronaMemory.ts";
import { type MomentPerson, momentRow, pickMoment } from "../_shared/dronaMoments.ts";
import { isTimeZone, wallClock } from "../_shared/wallClock.ts";
import { retried } from "../_shared/retried.ts";
import { type Db as MetricsDb, metricsStep } from "./metrics.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER") ?? "";
const JEV_API_KEY = Deno.env.get("JEV_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
/** The sweep reads texts from this many days back (the zones differ; seen ones are skipped). */
const SWEEP_DAYS = 3;
/**
 * Stop starting new texts after this long. The cron call times out at 55 s and
 * one text can take Jev (6 s) plus the writer (15 s) plus the mark, so the last
 * text started must still finish inside it.
 */
const SWEEP_BUDGET_MS = 25_000;
/** Per Jev call (one per text). */
const JEV_TIMEOUT_MS = 6000;
/** Jev calls in flight per person: the cron already runs CRON_CONCURRENCY people at once. */
const JEV_CONCURRENCY = 5;
/**
 * A failed word step holds the weekly card (it is written once a week and
 * cannot be replaced, so a numbers card would lock out what the person told
 * Drona) for this many days into the week; after that the numbers speak alone.
 */
const WORDS_RETRY_DAYS = 2;
const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

const USER_PAGE = 1000;
const CRON_CONCURRENCY = 4;
/**
 * Stop starting phase metric checks this long after the metrics pass began,
 * and in any case once the run is METRICS_LATEST_MS old: the cron call times
 * out at 55 s, the cards and check-ins run first, and the moments pass must
 * still get its turn. The budget is checked before each batch (the first
 * batch always runs, so a busy card pass cannot push the metrics out of
 * every run), and a batch can hold one model call per user (20 s timeout
 * each, in parallel), so the last batch started inside the budget ends by
 * about 40 s. What is left waits for the next run.
 */
const METRICS_BUDGET_MS = 20_000;
const METRICS_LATEST_MS = 22_000;
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

type WordsState = "none" | "stored" | "asked" | "failed";

/**
 * The word step (.planning/drona-word-behaviours.md): what the person told
 * Drona in the week that just ended. Stored answers are reused, so Jev is asked
 * once per person per week; a week with no texts costs nothing. Code picks the
 * texts and decides; Jev only answers yes/no (and which) about each text.
 * Never throws: a failure means no word behaviours this week, and the numbers
 * cards run as before.
 */
async function wordStep(
  db: SupabaseClient,
  userId: string,
  localDay: string,
): Promise<{ signals: StoredSignal[]; state: WordsState }> {
  const { data, error } = await retried(() =>
    db.rpc("get_drona_word_facts", { p_user_id: userId, p_as_of: localDay })
  );
  if (error || !data) {
    if (error) console.error("[drona-cards] word facts:", error.message);
    return { signals: [], state: "failed" };
  }
  const f = data as WordFacts;
  if ((f.stored ?? []).length > 0) return { signals: f.stored!, state: "stored" };
  const texts = chooseTexts(f);
  if (texts.length === 0) return { signals: [], state: "none" };

  // One call per text, a few at a time: each text's answers stay tied to its day.
  const questions = Object.fromEntries(Object.entries(QUESTIONS).map(([q, v]) => [questionKey(0, q), v]));
  const deps = { apiKey: JEV_API_KEY, timeoutMs: JEV_TIMEOUT_MS, log: (m: string) => console.error(`[drona-cards] ${m}`) };
  // Every text carries the same questions under index 0 (one call per text).
  const ask = (t: WordText) => askJev(stateFor(t, texts), questions, deps);
  const answers: Awaited<ReturnType<typeof askJev>>[] = [];
  for (let i = 0; i < texts.length; i += JEV_CONCURRENCY) {
    answers.push(...await Promise.all(texts.slice(i, i + JEV_CONCURRENCY).map(ask)));
  }
  // One more try for the texts that failed: one flaky call must not hold a
  // chatty person's whole week. Still failing: the week fails (a missing text
  // could be the one that says "travelling").
  const failed = texts.map((_, i) => i).filter((i) => !answers[i].ok);
  for (let k = 0; k < failed.length; k += JEV_CONCURRENCY) {
    const batch = failed.slice(k, k + JEV_CONCURRENCY);
    const again = await Promise.all(batch.map((i) => ask(texts[i])));
    batch.forEach((i, j) => { answers[i] = again[j]; });
  }
  const readings = [];
  let model: string | null = null;
  for (let i = 0; i < texts.length; i++) {
    const a = answers[i];
    if (!a.ok) return { signals: [], state: "failed" };
    model = a.response.model ?? model;
    readings.push(readText(texts[i], 0, a.response.answers as Record<string, unknown>));
  }
  const signals = wordSignals(f, readings);
  const { error: upErr } = await retried(() =>
    db.from("drona_word_signals").upsert(signals.map((s) => ({
      user_id: userId, week_start: f.week_start, signal: s.signal, fired: s.fired, detail: s.detail ?? {}, model,
    })), { onConflict: "user_id,week_start,signal" })
  );
  if (upErr) console.error("[drona-cards] word signals write:", upErr.message);
  return { signals, state: "asked" };
}

/** Whole days from the week's Monday to the local day (0 on Monday). */
function daysInto(weekStart: string, localDay: string): number {
  const a = Date.parse(`${weekStart}T00:00:00Z`);
  const b = Date.parse(`${localDay}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

/** Read one user's facts, decide, and write the card. A hold writes nothing. */
async function generate(
  db: SupabaseClient,
  userId: string,
  localDay: string,
  weekStart: string,
  source: "cron" | "app",
): Promise<{ kind: string; saved: boolean; error?: string; words?: WordsState }> {
  const { data: facts, error } = await retried(() =>
    db.rpc("get_drona_facts", { p_user_id: userId, p_as_of: localDay, p_week_start: weekStart })
  );
  if (error) return { kind: "none", saved: false, error: error.message };
  if (!facts) return { kind: "none", saved: false, error: "no facts" };
  const newUser = signalsFrom(facts as DronaFacts).new_user;

  // A new user gets the "I am reading" notice (decideCard): no pick, so no read.
  // Otherwise the behaviour pick: what last week's behaviours found. A failed
  // read says nothing this week: without it the mutes and the "not hearing
  // Drona" hush are unknown, and asking someone who muted a topic is worse
  // than silence.
  let pf: PickFacts | null = null;
  if (!newUser) {
    const { data: pick, error: pickErr } = await retried(() =>
      db.rpc("get_drona_pick_facts", { p_user_id: userId, p_as_of: localDay })
    );
    if (pickErr) {
      // Its own kind, so the cron summary counts it: a read that keeps failing
      // would otherwise silence every weekly card with only a log line to
      // show. The app path just gets no card back (`card` is null).
      console.error("[drona-cards] pick facts:", pickErr.message);
      return { kind: "pick_failed", saved: false };
    }
    pf = pick as PickFacts | null;
  }

  // Words beat numbers: what they told Drona joins the pick, above the number
  // behaviours, and quiets the cards it would argue with.
  const words = await wordStep(db, userId, localDay);
  // A failed word step early in the week holds the card, so a retry (the cron,
  // or the next app open) can still say what they told Drona. Later in the
  // week the numbers speak alone rather than leave the week silent.
  if (words.state === "failed" && daysInto(weekStart, localDay) < WORDS_RETRY_DAYS) {
    return { kind: "words_failed", saved: false, words: words.state };
  }
  const all: PickFacts = { ...(pf ?? {}), behaviours: [...(pf?.behaviours ?? []), ...wordBehaviours(words.signals)] };
  const tagged = <T extends object>(r: T) => ({ ...r, words: words.state });

  // Pain comes first: before the swap, and for new users too.
  const hurt = painFirst(all, facts as DronaFacts);
  if (hurt) return tagged(await insertWeekly(db, userId, weekStart, hurt, facts, all, source));

  // Too new to read a habit, and a swap just asked about waits its turn.
  if (!newUser && !onCooldown("swap", facts as DronaFacts)) {
    const swap = await swapFirst(db, userId, localDay, weekStart, source);
    if (swap) return tagged(swap);
  }

  const picked = newUser ? null : decidePick(all, facts as DronaFacts);
  const skip = new Set([...mutedTopics(all), ...askedLately(facts as DronaFacts)]);
  const card = picked ?? hushed(decideCard(facts as DronaFacts, undefined, skip), all);
  if (card.kind === "hold") return tagged({ kind: "hold", saved: false });
  return tagged(await insertWeekly(db, userId, weekStart, card, facts, picked ? all : null, source));
}

/**
 * Insert, never upsert: the cron and the app can race for the same week, and
 * the first card written is the one that stands. The pick rows, when a pick
 * made the card, are kept with it: the audit of why it was said.
 */
async function insertWeekly(
  db: SupabaseClient,
  userId: string,
  weekStart: string,
  card: { kind: string; topic: string; title: string; body: string; evidence: unknown; payload: unknown; signals: string[] },
  facts: unknown,
  pick: PickFacts | null,
  source: "cron" | "app",
): Promise<{ kind: string; saved: boolean; error?: string }> {
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
      facts: pick ? { ...(facts as Record<string, unknown>), pick } : facts,
      source,
    })
  );
  // 23505: someone else wrote this week's card first. Not a failure.
  if (insErr && (insErr as { code?: string }).code !== "23505") {
    return { kind: card.kind, saved: false, error: insErr.message };
  }
  return { kind: card.kind, saved: !insErr };
}

/**
 * Drona moments (.planning/drona-moments.md): every 15-minute run, everyone
 * with something worth saying now (get_drona_moment_candidates: missed
 * sessions, food far off, an ask the plan did not follow, a fresh PR) gets at
 * most one moment, under the caps and cooldowns in _shared/dronaMoments.ts.
 * Pain moments are made by ai-coach right after the message. Never throws.
 */
async function runMoments(db: SupabaseClient, nowMs: number): Promise<{ made: number; failed: number }> {
  const { data, error } = await retried(() => db.rpc("get_drona_moment_candidates", { p_now: new Date(nowMs).toISOString() }));
  if (error) {
    console.error("[drona-cards] moment candidates:", error.message);
    return { made: 0, failed: 1 };
  }
  let made = 0;
  let failed = 0;
  for (const p of (data ?? []) as MomentPerson[]) {
    const picked = pickMoment(p);
    if (!picked) continue;
    const { card, candidate } = picked;
    const { error: insErr } = await retried(() => db.from("drona_cards").insert(momentRow(p.user_id, p.today, card, candidate, "cron", nowMs)));
    if (insErr) {
      // 23505: this moment was already made today. Not a failure.
      if ((insErr as { code?: string }).code !== "23505") { failed += 1; console.error("[drona-cards] moment:", insErr.message); }
      continue;
    }
    made += 1;
    if (card.topic === "asked_for_a_change" && typeof candidate?.detail?.source === "string") {
      await retried(() => db.from("drona_moment_asks").update({ status: "carded" })
        .eq("user_id", p.user_id).eq("source_id", candidate.detail.source as string));
    }
  }
  return { made, failed };
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
    let pickFailed = 0;
    let wordsFailed = 0;
    let wordsAsked = 0;
    let checkins = 0;
    let metricsChecked = 0;
    let linesWritten = 0;
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
        if ("words" in g && g.words === "failed") wordsFailed += 1;
        if ("words" in g && g.words === "asked") wordsAsked += 1;
        if (g.saved) saved += 1;
        else if (g.kind === "hold") held += 1;
        else if (g.kind === "pick_failed") pickFailed += 1;
        else if (g.kind === "words_failed") failures.push(`${batch[j].userId.slice(0, 12)}: words failed, card held for a retry`);
        else failures.push(`${batch[j].userId.slice(0, 12)}: ${g.error ?? "not saved"}`);
      });
    }

    // The phase metrics check (.planning/phase-metrics/SPEC.md): once a local
    // week per user with an active program, whether or not a card is due.
    // One read finds who has a metric row not yet checked this LOCAL week
    // (checked_week, the local Monday the job wrote). The bound is the LATEST
    // week start of this run's zones, so the read is a superset: a zone
    // already on the next week is listed at once, and metricsStep's own
    // checkDue filters per user. Everyone else costs nothing. The cost of the
    // superset: while the zones straddle a Monday (about a day a week), a
    // user whose own Monday has not come yet is listed too, and pays three
    // small reads per run until it does.
    // A time budget keeps the moments pass below from being starved.
    const latestWeek = weekStarts.length > 0 ? [...weekStarts].sort().pop()! : null;
    const dueMetrics = new Set<string>();
    if (latestWeek) {
      for (let from = 0; ; from += USER_PAGE) {
        // Active programs only, rows the check can read (a target), and a
        // stable page key (user_id, id) so no row straddles a page edge.
        const { data: unchecked, error: uncheckedErr } = await retried(() =>
          db.from("coach_program_phase_metrics").select("user_id, coach_programs!inner(status)")
            .eq("coach_programs.status", "active")
            .not("target_value", "is", null)
            .or(`checked_week.is.null,checked_week.lt.${latestWeek}`)
            .order("user_id", { ascending: true }).order("id", { ascending: true })
            .range(from, from + USER_PAGE - 1)
        );
        if (uncheckedErr) { failures.push(`metrics: due read: ${uncheckedErr.message}`); break; }
        for (const m of unchecked ?? []) if (m.user_id) dueMetrics.add(String(m.user_id));
        if (!unchecked || unchecked.length < USER_PAGE) break;
      }
    }
    // Rotated by run, so a cron that is always near its budget does not
    // starve the same users at the end of the list every week.
    const dueUsers = weeks.filter((w) => dueMetrics.has(w.userId));
    const rotate = dueUsers.length > 0 ? Math.floor(now.getTime() / 900_000) % dueUsers.length : 0;
    const metricUsers = [...dueUsers.slice(rotate), ...dueUsers.slice(0, rotate)];
    let metricsSkipped = 0;
    const metricsStart = Date.now();
    const metricsDeadline = Math.min(metricsStart + METRICS_BUDGET_MS, now.getTime() + METRICS_LATEST_MS);
    for (let i = 0; i < metricUsers.length; i += CRON_CONCURRENCY) {
      if (i > 0 && Date.now() > metricsDeadline) {
        metricsSkipped = metricUsers.length - i;
        failures.push(`metrics: out of time, ${metricsSkipped} left for the next run`);
        break;
      }
      const batch = metricUsers.slice(i, i + CRON_CONCURRENCY);
      // The real client is structurally the little Db the step types against.
      const results = await Promise.all(batch.map((w) => metricsStep(db as unknown as MetricsDb, w.userId, w.day, w.week, ANTHROPIC_API_KEY, fetch, now.toISOString())));
      results.forEach((m, j) => {
        metricsChecked += m.checked;
        if (m.line) linesWritten += 1;
        if (m.error) failures.push(`${batch[j].userId.slice(0, 12)} metrics: ${m.error}`);
      });
    }

    // Moments after the weekly cards: a weekly card written this run is waiting,
    // so the moment rules leave that person alone today.
    const moments = await runMoments(db, now.getTime());
    return json({ users: weeks.length, due: due.length, saved, held, checkins, pick_failed: pickFailed,
      words_asked: wordsAsked, words_failed: wordsFailed, moments_made: moments.made, moments_failed: moments.failed,
      metrics_checked: metricsChecked, coach_lines: linesWritten, metrics_skipped: metricsSkipped,
      failures: failures.slice(0, 20) });
  } finally {
    // Settled on every path: the runtime may stop the worker once the response
    // is out, and an abandoned delete may never land.
    const pruned = await prune;
    if (pruned.error) console.error("[drona-cards] prune failed:", pruned.error.message);
  }
}

/**
 * The daily memory sweep (.planning/drona-memory-catch.md): every text from the
 * last few days that no pass has read yet (notes, and any message whose
 * after-reply pass failed), through the same catch as ai-coach. One person's
 * texts in order, so a fact saved from one is in memory for the next. Stops
 * starting texts near the cron's time limit; the rest wait for tomorrow.
 */
async function runMemorySweep(): Promise<Response> {
  // The same kill switch as the after-reply pass. Missing keys stop the run
  // BEFORE any text is read: otherwise every text fails, uses up a try, and
  // after three nights is never read again.
  if (Deno.env.get("MEMORY_CATCH") === "off") return json({ skipped: "MEMORY_CATCH=off" });
  if (!JEV_API_KEY || !ANTHROPIC_API_KEY) return json({ error: "JEV_API_KEY or ANTHROPIC_API_KEY missing" }, 503);
  const db = admin();
  const started = Date.now();
  const since = new Date(started - SWEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await retried(() => db.rpc("get_drona_memory_unseen", { p_since: since, p_limit: 300 }));
  if (error) return json({ error: error.message, stage: "unseen" }, 500);
  const texts = (data ?? []) as { user_id: string; id: string; kind: string; text: string }[];
  const byUser = new Map<string, typeof texts>();
  for (const t of texts) byUser.set(t.user_id, [...(byUser.get(t.user_id) ?? []), t]);

  // saved counts facts; the rest count texts. `left` is the backlog for tomorrow: watch it.
  const tally = { texts: texts.length, read: 0, saved: 0, no: 0, nothing: 0, failed: 0, left: 0 };
  const today = new Date(started).toISOString().slice(0, 10);
  const people = [...byUser.entries()];
  for (let i = 0; i < people.length; i += CRON_CONCURRENCY) {
    await Promise.all(people.slice(i, i + CRON_CONCURRENCY).map(async ([userId, mine]) => {
      const logs: PromiseLike<unknown>[] = [];
      for (const t of mine) {
        if (Date.now() - started > SWEEP_BUDGET_MS) { tally.left += 1; continue; }
        const r = await catchMemory(t.text, t.kind, {
          jev: { apiKey: JEV_API_KEY, timeoutMs: JEV_TIMEOUT_MS },
          anthropicKey: ANTHROPIC_API_KEY,
          today,
          readMemory: () => readMemoryRows(db as never, userId),
          saveFact: async (f) => {
            const { data: res, error: e } = await db.rpc("coach_remember_fact_for", {
              p_user_id: userId, p_category: f.category, p_key: f.key, p_value: f.value, p_source: "sweep",
            });
            return saveResult(res, e);
          },
          logUsage: (u) => {
            logs.push(db.rpc("log_token_usage", {
              p_pipeline: "drona_memory", p_provider: "anthropic", p_model: MEMORY_WRITER_MODEL,
              p_input_tokens: u.input_tokens, p_output_tokens: u.output_tokens, p_cache_read_tokens: 0,
              p_cache_creation_tokens: 0, p_metadata: { via: "sweep", kind: t.kind }, p_latency_ms: u.latency_ms,
              p_status: u.status, p_error_message: u.error ?? null,
            }));
          },
        });
        await retried(() => db.rpc("drona_memory_mark_seen", {
          p_user_id: userId, p_source_id: t.id, p_outcome: r.outcome, p_facts: r.saved, p_gate: r.gate, p_via: "sweep",
        }));
        tally.read += 1;
        if (r.outcome === "saved") tally.saved += r.saved; // facts, not texts
        else tally[r.outcome] += 1;
      }
      // Settled before the response: the isolate may stop once it is sent.
      await Promise.allSettled(logs);
    }));
  }
  return json(tally);
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
  if (body.mode === "memory_sweep") {
    const secret = req.headers.get("x-cron-secret") ?? "";
    const { data: ok, error } = await retried(() => admin().rpc("drona_cards_cron_ok", { p_secret: secret }));
    if (error) return json({ error: error.message }, 500);
    if (ok !== true) return json({ error: "Unauthorized" }, 401);
    return runMemorySweep();
  }
  if (body.mode === "app") return runApp(req, body);
  return json({ error: "mode must be cron, memory_sweep or app" }, 400);
});
