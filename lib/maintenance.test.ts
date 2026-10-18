import { assertEquals } from "jsr:@std/assert@1";
import { maintenanceView, type MaintenanceFacts } from "./maintenance.ts";

const TODAY = "2026-10-18";
const facts = (over: Partial<MaintenanceFacts> = {}): MaintenanceFacts => ({
  m_estimate_kcal: 2294, m_source: "learning", m_data_weeks: 1.5, m_readings_28: 5, m_whole_days_28: 9,
  m_last_weigh_in: "2026-10-16", ...over,
});

Deno.test("nothing honest to say: no line", () => {
  assertEquals(maintenanceView(null, TODAY), null);
  assertEquals(maintenanceView(facts({ m_estimate_kcal: null }), TODAY), null);
  assertEquals(maintenanceView(facts({ m_source: "no_body" }), TODAY), null);
});

Deno.test("the number is about, on tens, with a thousands comma", () => {
  assertEquals(maintenanceView(facts(), TODAY)?.headline, "Maintenance about 2,290 kcal");
  assertEquals(maintenanceView(facts({ m_estimate_kcal: 995 }), TODAY)?.headline, "Maintenance about 1,000 kcal");
});

Deno.test("a first guess says where it comes from, and shows no progress", () => {
  const v = maintenanceView(facts({ m_source: "guess", m_data_weeks: 0 }), TODAY)!;
  assertEquals([v.label, v.progress], ["First guess", 0]);
  assertEquals(v.detail.startsWith("From your stats."), true);
});

Deno.test("learning counts what it has against what a read needs, capped", () => {
  const v = maintenanceView(facts(), TODAY)!;
  assertEquals(v.label, "Learning");
  assertEquals(v.progress, 0.5);
  assertEquals(v.detail, "Learning from your body: 5 of 8 weigh-ins and 9 of 14 whole food days in the last 4 weeks.");
  const full = maintenanceView(facts({ m_readings_28: 20, m_whole_days_28: 28, m_data_weeks: "2.95" }), TODAY)!;
  assertEquals(full.detail.includes("8 of 8 weigh-ins and 14 of 14"), true);
  assertEquals(Math.round(full.progress * 100), 98);
});

Deno.test("measured, fresh and stale (the engine's 10-day line)", () => {
  assertEquals(maintenanceView(facts({ m_source: "measured", m_last_weigh_in: "2026-10-08" }), TODAY)?.detail,
    "Measured from your own weigh-ins and food.");
  assertEquals(maintenanceView(facts({ m_source: "measured", m_last_weigh_in: "2026-10-07" }), TODAY)?.detail,
    "Measured from your own weigh-ins and food. Your last weigh-in was 11 days ago.");
  assertEquals(maintenanceView(facts({ m_source: "measured", m_last_weigh_in: null }), TODAY)?.progress, 1);
});

Deno.test("no line uses an em dash", () => {
  for (const f of [facts({ m_source: "guess" }), facts(), facts({ m_source: "measured", m_last_weigh_in: null })]) {
    const v = maintenanceView(f, TODAY)!;
    assertEquals(/—/.test(`${v.headline} ${v.label} ${v.detail}`), false);
  }
});
