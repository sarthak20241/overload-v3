// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Tool } from "./protocol.ts";
import type { Ctx } from "./tools.ts";
import { TOOLS } from "./tools.ts";
import { cleanFacts, INSIGHT_TOOLS, SIGNAL_MEANING } from "./insightTools.ts";
import { PLAN_TOOLS } from "./planTools.ts";
import { PROGRAM_TOOLS } from "./programTools.ts";
import { FOOD_WRITE_TOOLS } from "./foodWrites.ts";
import { WORKOUT_WRITE_TOOLS } from "./workoutWrites.ts";
import { PLANNING_GUIDE } from "./planningGuide.ts";

const U = "user_1";
const NOW = new Date("2026-11-12T12:00:00Z"); // Thursday; week starts 2026-11-09
const tool = (n: string) => INSIGHT_TOOLS.find((t) => t.name === n) as Tool;
const body = (r: any) => JSON.parse(r.text);

function ctxWith(data: Record<string, unknown> = {}): { ctx: Ctx; asked: Record<string, unknown[]> } {
  const asked: Record<string, unknown[]> = {};
  const rec = (name: string, rows: unknown) => (...a: unknown[]) => { asked[name] = a; return Promise.resolve(rows); };
  const ctx = {
    userId: U, email: null, tz: "UTC", now: NOW, profile: {},
    data: {
      behaviourPick: rec("behaviourPick", [{ week_start: "2026-11-02", behaviour: "off_pace", card_kind: "talk", mutes: ["topic:steps"] }]),
      behaviours: rec("behaviours", [
        { week_start: "2026-11-02", behaviour: "off_pace", priority: 15, card_kind: "talk", meta: false, mutes: [], detail: { kg_to_go: 3 } },
        { week_start: "2026-11-02", behaviour: "fixed_days", priority: 82, card_kind: "steer", meta: false, mutes: [] },
      ]),
      signals: rec("signals", [{ week_start: "2026-11-02", signal: "off_pace", fired: true, pattern: true, detail: { eta: "2027-03-01" } }]),
      wordSignals: rec("wordSignals", [{ week_start: "2026-11-02", signal: "hurting", fired: true }]),
      cards: rec("cards", [
        { week_start: "2026-11-09", slot: "weekly", kind: "act", title: "Drop to 2100", body: "Pace is slow.", status: "pending",
          expires_at: "2026-11-15T00:00:00Z", created_at: "2026-11-09T08:00:00Z", payload: { calories: 2100 } },
        { week_start: "2026-11-02", slot: "weekly", kind: "hold", title: "held", body: "", status: "held", created_at: "2026-11-02T08:00:00Z" },
        { week_start: "2026-11-02", slot: "moment", kind: "talk", title: "Nice week", body: "b", status: "pending",
          expires_at: "2026-11-05T00:00:00Z", created_at: "2026-11-03T08:00:00Z" },
      ]),
      maintenance: rec("maintenance", { week_start: "2026-11-02", m_estimate_kcal: 2550, m_source: "measured", m_data_weeks: 6,
        m_readings_28: 20, m_whole_days_28: 22, m_last_weigh_in: "2026-11-11" }),
      memory: rec("memory", [{ category: "injury", key: "left_knee", value: "No deep lunges", updated_at: "2026-10-01T00:00:00Z" }]),
      planChanges: rec("planChanges", [{ occurred_at: "2026-11-05T10:00:00Z", entity: "targets", action: "changed", source: "mcp",
        changes: { daily_calorie_target: { from: 2200, to: 2100 } } }]),
      weekFacts: rec("weekFacts", [{ user_id: U, week_start: "2026-11-02", w_avg_kg: 80.123, wd_texts: ["my knee hurts"],
        wd_injury_notes: "knee", f_days_logged: 6, f_computed_at: "x", source_version: 3, t_muscles: [], g_eta_date: null }]),
      dayFacts: rec("dayFacts", [{ user_id: U, day: "2026-11-10", kcal: 2050 }]),
      exerciseWeekFacts: rec("exerciseWeekFacts", []),
      muscleWeekFacts: rec("muscleWeekFacts", []),
      readiness: rec("readiness", []),
      ...data,
    } as any,
  } as Ctx;
  return { ctx, asked };
}

Deno.test("get_insights: focus, behaviours, signals with meanings, cards without holds, maintenance, memory, changes", async () => {
  const { ctx, asked } = ctxWith();
  const r = body(await tool("get_insights").run({}, ctx));
  assertEquals(asked.cards, [U, "2026-10-12"], "4 weeks back from this Monday");
  assertEquals(r.focus.behaviour, "off_pace");
  assertEquals(r.focus.mutes, ["topic:steps"]);
  assertEquals(r.behaviours["2026-11-02"].map((b: any) => b.behaviour), ["off_pace", "fixed_days"]);
  assertEquals(r.signals["2026-11-02"][0].also_last_week, true);
  assert(r.signals["2026-11-02"][0].meaning);
  assertEquals(r.from_what_the_user_said["2026-11-02"][0].signal, "hurting");
  assertEquals(r.cards.map((c: any) => [c.title, c.waiting]), [["Drop to 2100", true], ["Nice week", false]]);
  assertEquals(r.cards[0].proposal, { calories: 2100 });
  assertEquals(r.maintenance.kcal, 2550);
  assertEquals(r.remembered[0].category, "injury");
  assertEquals(r.plan_changes[0].by, "assistant");
});

Deno.test("get_insights: nothing yet is empty, not an error", async () => {
  const empty = () => Promise.resolve([]);
  const { ctx } = ctxWith({ behaviourPick: empty, behaviours: empty, signals: empty, wordSignals: empty, cards: empty,
    maintenance: () => Promise.resolve(null), memory: empty, planChanges: empty });
  const res = await tool("get_insights").run({ weeks: 99 }, ctx);
  assert(!res.isError);
  const r = body(res);
  assertEquals([r.focus, r.maintenance, r.cards.length], [null, null, 0]);
});

Deno.test("get_facts: the user's own words never leave; bookkeeping and empty values are dropped", async () => {
  const { ctx } = ctxWith();
  const r = body(await tool("get_facts").run({ kind: "weeks" }, ctx));
  assertEquals(r.rows, [{ week_start: "2026-11-02", w_avg_kg: 80.12, f_days_logged: 6 }]);
  assert(!JSON.stringify(r).includes("knee"));
  assertEquals(cleanFacts({ wd_texts: ["x"], wd_training_prefs: "x", p_change_list: [1], a_computed_at: "x" }), {});
  // Fail safe: a text or JSON column nobody has looked at stays in.
  assertEquals(cleanFacts({ new_note: "my words", new_json: { a: 1 }, day: "2026-11-10", ok: true, m_source: "measured" }),
    { day: "2026-11-10", ok: true, m_source: "measured" });
});

Deno.test("get_facts: each kind reads its own table and range; long ranges are refused", async () => {
  const { ctx, asked } = ctxWith();
  await tool("get_facts").run({ kind: "food_days", from: "2026-11-01", to: "2026-11-10" }, ctx);
  assertEquals(asked.dayFacts, [U, "drona_day_facts", "2026-11-01", "2026-11-10"]);
  await tool("get_facts").run({ kind: "recovery_days" }, ctx);
  assertEquals(asked.dayFacts, [U, "drona_recovery_day_facts", "2026-10-30", "2026-11-12"]);
  await tool("get_facts").run({ kind: "exercises", from: "2026-10-15", to: "2026-11-12" }, ctx);
  assertEquals(asked.exerciseWeekFacts, [U, "2026-10-12", "2026-11-09"]);
  for (const args of [{ kind: "nope" }, { kind: "food_days", from: "2026-01-01", to: "2026-11-01" }, { kind: "weeks", from: "2026-11-10", to: "2026-11-01" }]) {
    assert((await tool("get_facts").run(args, ctx)).isError, JSON.stringify(args));
  }
});

Deno.test("signal meanings cover every signal the database writes", async () => {
  // Every signal name the rebuild functions write, read from the migrations.
  const names = new Set<string>();
  for await (const f of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (!f.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(`../../migrations/${f.name}`, import.meta.url));
    for (const m of sql.matchAll(/'([a-z_]+)'::text as signal|signal = '([a-z_]+)'|'([a-z_]+)' as signal|\('([a-z_]+)', *[a-z_]+\.fired/g)) {
      names.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
    }
  }
  assert(names.size >= 19, `found ${names.size}`);
  for (const n of names) assert(SIGNAL_MEANING[n], `no meaning for ${n}`);
});

Deno.test("planning guide: no em dashes, and every tool it names exists", () => {
  assert(!PLANNING_GUIDE.includes("—"));
  const names = new Set([...TOOLS, ...PLAN_TOOLS, ...INSIGHT_TOOLS, ...PROGRAM_TOOLS, ...FOOD_WRITE_TOOLS, ...WORKOUT_WRITE_TOOLS].map((t) => t.name));
  const named = PLANNING_GUIDE.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
  const toolish = named.filter((n) => /^(get|list|create|update|end|delete|save|search|log)_/.test(n));
  for (const n of toolish) assert(names.has(n), `guide names ${n}, which is not a tool`);
});
