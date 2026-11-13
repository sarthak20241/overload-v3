// Drona's insights for ChatGPT and Claude, as structured JSON: what Overload's
// coach has worked out about the user. Read only. Every table here is written
// by Drona's weekly jobs (the facts cron, drona-cards, ai-coach); these tools
// only select from them, filtered to the user in data.ts. The get_drona_*
// SQL functions are NOT used: they rebuild facts and write when a day is due.
//
//   get_insights        this week's focus, fired signals, cards, maintenance,
//                       remembered facts, recent plan changes
//   get_facts           the facts ledger itself: weeks, days, exercises,
//                       muscles, readiness
//   get_planning_guide  how Drona plans (planningGuide.ts)
//
// Never sent: the user's raw chat and note text. drona_week_facts.wd_texts and
// the note columns, and drona_word_facts, hold it; word signals go out as the
// signal name only, and get_facts passes text columns only from an allowlist
// (SAFE_TEXT). Sent on purpose: Drona's remembered facts (coach_memory, short
// key/value lines Drona saved, which the user sees and edits in the app) and
// the plan log's from/to values and names. weekly_reports is left out:
// nothing writes it.

import { addDays, todayIn, weekStart } from "./days.ts";
import { PLANNING_GUIDE, PLANNING_GUIDE_URI } from "./planningGuide.ts";
import type { Tool } from "./protocol.ts";
import { answer, type Ctx, dayArg, refuse } from "./tools.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** What each weekly signal means, so the assistant need not guess from a name. */
export const SIGNAL_MEANING: Record<string, string> = {
  follows_split_not_today: "Does most of the program's week, but under 40% of the sets on TODAY's pick.",
  muscle_left_out: "A muscle the plan gives 4+ sets a week got under half of them.",
  scale_untrusted: "Weigh-ins jump over 1.5 kg as a rule, or a reading is impossible.",
  logs_snack_not_day: "Most logged days are under half the calorie target: part days, not whole days.",
  cards_not_landing: "The last 2 cards were ignored or tapped without being done.",
  goals_disagree: "The program goal and the profile goal, or their goal weights, point different ways.",
  training_dropped: "Training sessions fell off.",
  lift_stuck: "A lift's estimated max has not moved.",
  protein_short: "Protein under target on logged days.",
  off_pace: "The weight trend will miss the goal date, or the date needs an unsafe pace.",
  maintenance_unknown: "Maintenance calories cannot be measured yet; detail says what is missing.",
  calories_off: "The calorie target is 250+ kcal away from what the goal pace needs.",
  trains_any_day: "Trains 3+ times a week on changing weekdays.",
  fixed_days: "Trains on 3+ steady weekdays.",
  plan_too_big: "The plan asks for 1+ more sessions a week than the 8-week average.",
  favourite_exercises: "Exercises done in 6 of the last 8 weeks that are not in this phase.",
  exercise_skipped: "An exercise skipped in half or more of its routine sessions.",
  topic_not_landing: "Cards on one topic were not followed, 2 or more times.",
  change_backfired: "After a plan change, sessions or food days fell under 3 in 4 of before.",
};

export const BEHAVIOUR_MEANING: Record<string, string> = {
  scale_untrusted: "The scale cannot be trusted 2 weeks running; ask for steady weigh-ins.",
  logs_partial_days: "Logs part days 2 weeks running; ask for whole days.",
  not_hearing_drona: "The last 2 cards were missed.",
  goals_unclear: "The goals disagree 2 weeks running; settle the goal.",
  drifting_away: "Training dropped 2 weeks running; a smaller plan may help.",
  own_way: "Follows their own split, not TODAY, 2 weeks running.",
  lift_stall: "The same lift is stuck 2 weeks running.",
  topic_not_landing: "One topic keeps missing; drop or reframe it.",
  finding_maintenance: "Still learning maintenance calories.",
  off_pace: "Off pace for the goal date 2 weeks running.",
  calories_off: "The calorie target is off what the goal pace needs; a new target is proposed.",
  plan_too_big: "The plan asks for more sessions than the user does.",
  exercise_skipped: "The same exercise is skipped 2 weeks running.",
  change_backfired: "A recent plan change was followed by fewer sessions or food days.",
  on_track: "No signal fired and the planned sessions were done.",
  maintenance_found: "Maintenance calories are measured.",
  trains_any_day: "Trains on changing weekdays: plan sessions by count, not by weekday.",
  fixed_days: "Trains on fixed weekdays: plan on those days.",
  keep_favourites: "Keep the exercises the user keeps coming back to.",
  change_worked: "A recent plan change worked; keep it.",
};

const WORD_MEANING: Record<string, string> = {
  hurting: "Mentioned pain or an injury in the last weeks.",
  life_got_in_the_way: "Said life (work, travel, illness) got in the way.",
  trains_not_logging: "Says they train but the sessions are not logged.",
  asked_for_a_change: "Asked Drona for a plan change.",
};

/** Columns that hold raw user text or bookkeeping, never sent. */
const HIDDEN = new Set(["user_id", "wd_texts", "wd_injury_notes", "wd_training_prefs", "p_change_list", "source_version"]);

/**
 * The text, list and JSON columns of the facts tables that are codes or
 * Drona's own words, never the user's (checked against the live columns on
 * 2026-11-13). Fail safe: numbers, booleans and dates always go out; any other
 * value goes out only when its column is named here, so a text column added
 * later stays in until someone looks at it and adds it.
 */
const SAFE_TEXT = new Set([
  // drona_week_facts
  "c_action", "c_by_topic_to_date", "c_kind", "c_outcome", "c_signals", "c_status", "c_title", "c_topic",
  "f_target_source", "g_goal_from", "g_target_from", "m_source", "p_changes_by_entity", "p_changes_by_source",
  "p_goal", "p_goal_src", "p_phase_name", "p_program_goal", "p_program_src", "p_program_title", "p_target_src",
  "r_sleep_sources", "r_steps_sources", "t_back_to_back_muscles", "t_parents_trained", "t_plan_parents_missed",
  "t_plan_source", "t_weekday_weeks_8w", "t_weekdays", "tape_sites", "w_sources", "wd_chat_by_mode",
  // drona_day_facts, drona_training_day_facts, drona_recovery_day_facts
  "target_source", "muscles", "parents", "pick_kind", "pick_parents_extra", "pick_parents_missed",
  "dropped", "readiness_hrv_why", "readiness_rhr_why", "readiness_sleep_basis", "readiness_tier",
  "sleep_source", "steps_source",
  // drona_exercise_week_facts, drona_muscle_week_facts, readiness_parts
  "exercise_name", "muscle", "parent", "role", "tier", "band", "sleep_basis", "rhr_why", "hrv_why",
]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A facts row without raw text, bookkeeping or empty values. */
export function cleanFacts(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (HIDDEN.has(k) || k.endsWith("computed_at") || v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "number") out[k] = Math.round(v * 100) / 100;
    else if (typeof v === "boolean" || (typeof v === "string" && DATE.test(v)) || SAFE_TEXT.has(k)) out[k] = v;
  }
  return out;
}

function cardOut(c: Row, nowIso: string) {
  const waiting = c.status === "pending" && (!c.expires_at || c.expires_at > nowIso);
  return {
    week_start: c.week_start,
    slot: c.slot,
    kind: c.kind,
    ...(c.topic ? { topic: c.topic } : {}),
    title: c.title,
    body: c.body,
    ...(c.evidence ? { evidence: c.evidence } : {}),
    ...(c.payload ? { proposal: c.payload } : {}),
    status: c.status,
    waiting,
    ...(c.deferred_at ? { saved_for_later: true } : {}),
    ...(c.decided_at ? { decided: String(c.decided_at).slice(0, 10) } : {}),
    created: String(c.created_at).slice(0, 10),
  };
}

// ── get_insights ────────────────────────────────────────────────────────────

const getInsights: Tool = {
  name: "get_insights",
  title: "Get Drona's insights",
  description: "What Overload's coach Drona has worked out about this user, as structured data: this week's focus " +
    "(the top behaviour and what it mutes), every behaviour and fired signal by week with the numbers behind it, " +
    "Drona's cards (weekly proposals, calorie check-ins, moments) and how the user answered them, the adaptive " +
    "maintenance calorie estimate, the user's remembered facts (injuries, equipment, schedule, preferences), and " +
    "recent plan changes with who made them. Read this before coaching or planning.",
  inputSchema: {
    type: "object",
    properties: { weeks: { type: "integer", minimum: 1, maximum: 12, description: "Weeks back. Default 4." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const weeks = Math.min(12, Math.max(1, Math.round(Number(a.weeks ?? 4)) || 4));
    const today = todayIn(ctx.tz, ctx.now);
    const thisWeek = weekStart(today);
    const from = addDays(thisWeek, -7 * weeks);
    const u = ctx.userId;
    const [pick, behaviours, signals, words, cards, maint, memory, changes] = await Promise.all([
      ctx.data.behaviourPick(u, from),
      ctx.data.behaviours(u, from),
      ctx.data.signals(u, from),
      ctx.data.wordSignals(u, from),
      ctx.data.cards(u, from),
      ctx.data.maintenance(u, thisWeek),
      ctx.data.memory(u),
      ctx.data.planChanges(u, `${addDays(today, -60)}T00:00:00Z`),
    ]);
    const nowIso = ctx.now.toISOString();
    const byWeek = (rows: Row[], f: (r: Row) => Row) => {
      const out: Record<string, Row[]> = {};
      for (const r of rows) (out[r.week_start] ??= []).push(f(r));
      return out;
    };
    const focus = pick[0] ?? null;
    return answer({
      today,
      week_start: thisWeek,
      note: "Weekly facts cover finished weeks (Monday start, the user's local days). No row means Drona could not judge.",
      focus: focus
        ? {
          week_start: focus.week_start,
          behaviour: focus.behaviour,
          meaning: BEHAVIOUR_MEANING[focus.behaviour] ?? null,
          card_kind: focus.card_kind,
          mutes: focus.mutes ?? [],
        }
        : null,
      behaviours: byWeek(behaviours, (b) => ({
        behaviour: b.behaviour,
        meaning: BEHAVIOUR_MEANING[b.behaviour] ?? null,
        priority: b.priority,
        card_kind: b.card_kind,
        ...(b.meta ? { meta: true } : {}),
        ...(b.mutes?.length ? { mutes: b.mutes } : {}),
        ...(b.detail ? { detail: b.detail } : {}),
      })),
      signals: byWeek(signals, (s) => ({
        signal: s.signal,
        meaning: SIGNAL_MEANING[s.signal] ?? null,
        ...(s.pattern ? { also_last_week: true } : {}),
        ...(s.detail ? { detail: s.detail } : {}),
      })),
      from_what_the_user_said: byWeek(words, (w) => ({ signal: w.signal, meaning: WORD_MEANING[w.signal] ?? null })),
      cards: cards.filter((c) => c.kind !== "hold").map((c) => cardOut(c, nowIso)),
      maintenance: maint
        ? {
          kcal: maint.m_estimate_kcal,
          source: maint.m_source,
          meaning: maint.m_source === "measured"
            ? "Measured from weigh-ins and whole food days."
            : maint.m_source === "learning"
            ? "Being learned; still moving."
            : "A starting guess from the profile.",
          ...(maint.m_guess_kcal != null ? { profile_guess_kcal: maint.m_guess_kcal } : {}),
          ...(maint.m_trend_kg != null ? { weight_trend_kg: maint.m_trend_kg } : {}),
          ...(maint.m_trend_rate_kg_per_week != null ? { kg_per_week: maint.m_trend_rate_kg_per_week } : {}),
          data_weeks: maint.m_data_weeks,
          weigh_ins_28d: maint.m_readings_28,
          whole_food_days_28d: maint.m_whole_days_28,
          last_weigh_in: maint.m_last_weigh_in,
          as_of_week: maint.week_start,
        }
        : null,
      remembered: memory.map((m) => ({ category: m.category, key: m.key, value: m.value, updated: String(m.updated_at).slice(0, 10) })),
      plan_changes: changes.map((c) => ({
        when: String(c.occurred_at).slice(0, 10),
        what: c.entity,
        action: c.action,
        ...(c.label ? { name: c.label } : {}),
        by: c.source === "mcp" ? "assistant" : c.source,
        changes: c.changes,
      })),
    });
  },
};

// ── get_facts ───────────────────────────────────────────────────────────────

const KINDS: Record<string, { weekly: boolean; maxDays: number; label: string }> = {
  weeks: { weekly: true, maxDays: 182, label: "One row per week: weight (w_), food (f_), training (t_), recovery (r_), plan changes (p_), cards (c_), goal pace (g_), energy (e_), maintenance (m_), activity goals (a_)." },
  food_days: { weekly: false, maxDays: 92, label: "Per day: calories and macros logged, meals, target, where the entries came from." },
  training_days: { weekly: false, maxDays: 92, label: "Per day: sessions, minutes, working sets, volume, muscles, whether TODAY's pick was followed." },
  recovery_days: { weekly: false, maxDays: 92, label: "Per day: readiness, sleep minutes, steps, resting heart rate, HRV, active kcal." },
  exercises: { weekly: true, maxDays: 182, label: "Per week and exercise: sessions, working sets, top weight, best estimated 1RM, in the program or not." },
  muscles: { weekly: true, maxDays: 182, label: "Per week and muscle: working sets and volume, primary or secondary." },
  readiness: { weekly: false, maxDays: 92, label: "Per day: readiness score and its parts (sleep, resting HR, HRV, training load, food)." },
};

const DAY_TABLE = {
  food_days: "drona_day_facts",
  training_days: "drona_training_day_facts",
  recovery_days: "drona_recovery_day_facts",
} as const;

const getFacts: Tool = {
  name: "get_facts",
  title: "Get Drona's facts ledger",
  description: "The numbers Drona works from, per day or per week, as Overload computed them. kind: " +
    Object.entries(KINDS).map(([k, v]) => `${k} (${v.label})`).join(" ") +
    " Days are the user's local days; weeks start Monday. Day kinds take up to 92 days, week kinds up to 26 weeks.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: Object.keys(KINDS) },
      from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Default: 4 weeks ago (week kinds) or 14 days ago." },
      to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Default: today." },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(a, raw) {
    const ctx = raw as Ctx;
    const kind = String(a.kind ?? "");
    const k = KINDS[kind];
    if (!k) return refuse(`kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
    const today = todayIn(ctx.tz, ctx.now);
    const to = dayArg(a.to, today, "to");
    if (typeof to !== "string") return to;
    const from = dayArg(a.from, addDays(to, k.weekly ? -28 : -13), "from");
    if (typeof from !== "string") return from;
    if (from > to) return refuse("from must be on or before to.");
    if (addDays(from, k.maxDays) < to) return refuse(`That range is too long for ${kind}: at most ${k.maxDays} days.`);
    const u = ctx.userId;
    const wFrom = weekStart(from);
    const wTo = weekStart(to);
    let rows: Row[];
    switch (kind) {
      case "weeks": rows = await ctx.data.weekFacts(u, wFrom, wTo); break;
      case "exercises": rows = await ctx.data.exerciseWeekFacts(u, wFrom, wTo); break;
      case "muscles": rows = await ctx.data.muscleWeekFacts(u, wFrom, wTo); break;
      case "readiness": rows = await ctx.data.readiness(u, from, to); break;
      default: rows = await ctx.data.dayFacts(u, DAY_TABLE[kind as keyof typeof DAY_TABLE], from, to);
    }
    return answer({ kind, from: k.weekly ? wFrom : from, to: k.weekly ? wTo : to, about: k.label, rows: rows.map(cleanFacts) });
  },
};

// ── get_planning_guide ──────────────────────────────────────────────────────

const getPlanningGuide: Tool = {
  name: "get_planning_guide",
  title: "How to plan like Drona",
  description: "Overload's rules for building and editing a program the way its coach Drona does: diet targets, " +
    "fuel days, training blocks, activity goals, phase metrics, the goal label, and when to ask the user. Read it " +
    "once before create_program or update_program. Also served as the resource " + PLANNING_GUIDE_URI + ".",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  free: false,
  run: () => Promise.resolve({ text: PLANNING_GUIDE, data: { uri: PLANNING_GUIDE_URI } }),
};

export const INSIGHT_TOOLS: Tool[] = [getInsights, getFacts, getPlanningGuide];
