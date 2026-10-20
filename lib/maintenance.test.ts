import { assertEquals } from "jsr:@std/assert@1";
import { maintenanceView, type MaintenanceFacts } from "./maintenance.ts";

const TODAY = "2026-10-18";
const facts = (over: Partial<MaintenanceFacts> = {}): MaintenanceFacts => ({
  m_estimate_kcal: 2294, m_guess_kcal: 2375, m_source: "learning", m_data_weeks: 1.5, m_readings_28: 5,
  m_whole_days_28: 9, m_last_weigh_in: "2026-10-16", ...over,
});

Deno.test("nothing honest to say: no row", () => {
  assertEquals(maintenanceView(null, TODAY), null);
  assertEquals(maintenanceView(facts({ m_estimate_kcal: null }), TODAY), null);
  assertEquals(maintenanceView(facts({ m_source: "no_body" }), TODAY), null);
});

Deno.test("the number is about, on tens, with a thousands comma; so is the formula's", () => {
  const v = maintenanceView(facts(), TODAY)!;
  assertEquals([v.headline, v.kcal, v.guess], ["Maintenance about 2,290 kcal", "2,290", "2,380"]);
  assertEquals(maintenanceView(facts({ m_estimate_kcal: 995, m_guess_kcal: null }), TODAY)?.guess, null);
});

Deno.test("a first guess says where it comes from, and shows no progress", () => {
  const v = maintenanceView(facts({ m_source: "guess", m_data_weeks: 0 }), TODAY)!;
  assertEquals([v.label, v.progress], ["First guess", 0]);
  assertEquals(v.detail.startsWith("A first guess from your stats."), true);
});

Deno.test("learning: what it has, and exactly what would sharpen it", () => {
  const v = maintenanceView(facts(), TODAY)!;
  assertEquals([v.label, v.progress, v.readings, v.wholeDays], ["Learning", 0.5, 5, 9]);
  assertEquals(v.next, "Next: 3 more weigh-ins and 5 more full days of food in the next few weeks.");
  assertEquals(maintenanceView(facts({ m_readings_28: 7, m_whole_days_28: 20 }), TODAY)?.next,
    "Next: 1 more weigh-in in the next few weeks.");
  const full = maintenanceView(facts({ m_readings_28: 20, m_whole_days_28: 28, m_data_weeks: "2.95" }), TODAY)!;
  assertEquals([full.readings, full.wholeDays], [8, 14]);
  assertEquals(full.next, "Keep weighing in and logging full days. A few more weeks and it is measured.");
  assertEquals(Math.round(full.progress * 100), 98);
});

Deno.test("the counters: have over need, capped; the row drops them once measured, the sheet keeps them", () => {
  const v = maintenanceView(facts(), TODAY)!;
  assertEquals(v.counters.map((c) => `${c.have}/${c.need} ${c.label}`), ["5/8 weigh-ins", "9/14 full days logged"]);
  const full = maintenanceView(facts({ m_readings_28: 20, m_whole_days_28: 28 }), TODAY)!;
  assertEquals(full.counters.map((c) => c.have), [8, 14]);
  assertEquals(maintenanceView(facts({ m_source: "guess", m_readings_28: 0, m_whole_days_28: 0 }), TODAY)!
    .counters.map((c) => c.have), [0, 0]);
  assertEquals(v.rowCounters, true);
  const measured = maintenanceView(facts({ m_source: "measured" }), TODAY)!;
  assertEquals(measured.rowCounters, false);
  assertEquals(measured.counters.map((c) => `${c.have}/${c.need}`), ["5/8", "9/14"]);
});

Deno.test("measured, fresh and stale (the engine's 10-day line)", () => {
  assertEquals(maintenanceView(facts({ m_source: "measured", m_last_weigh_in: "2026-10-08" }), TODAY)?.next,
    "Keep weighing in now and then to keep it current.");
  assertEquals(maintenanceView(facts({ m_source: "measured", m_last_weigh_in: "2026-10-07" }), TODAY)?.next,
    "Your last weigh-in was 11 days ago. A weigh-in this week keeps it current.");
  assertEquals(maintenanceView(facts({ m_source: "measured", m_last_weigh_in: null }), TODAY)?.progress, 1);
});

Deno.test("no words use an em dash", () => {
  for (const f of [facts({ m_source: "guess" }), facts(), facts({ m_source: "measured", m_last_weigh_in: null })]) {
    const v = maintenanceView(f, TODAY)!;
    assertEquals(/—/.test(`${v.headline} ${v.label} ${v.detail} ${v.next}`), false);
  }
});
