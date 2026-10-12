// Run with: deno test supabase/functions/ai-coach/memory.test.ts
//
// The shapes below are real rows from the live plan_changes / drona_cards /
// body_measurements tables (2026-09-18), trimmed.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  cardsForContext,
  formatPlanChange,
  memoryForContext,
  memoryRefusalOf,
  planChangesForContext,
  summarizeMeasurements,
} from "./memory.ts";

// ── plan changes ─────────────────────────────────────────────────────────────

Deno.test("targets changed reads as before→after per field", () => {
  const line = formatPlanChange({
    occurred_at: "2026-09-18T10:00:00+00:00",
    entity: "targets",
    action: "changed",
    source: "auto",
    label: null,
    changes: {
      fat_target_g: { to: 53, from: 55 },
      carb_target_g: { to: 190, from: 200 },
      protein_target_g: { to: 135, from: 130 },
      daily_calorie_target: { to: 1750, from: 1800 },
    },
  });
  assertEquals(
    line,
    "2026-09-18 (auto) targets: fat g 55→53, carbs g 200→190, protein g 130→135, calories 1800→1750",
  );
});

Deno.test("a phase created line is a short descriptor, not the whole directive", () => {
  const line = formatPlanChange({
    occurred_at: "2026-09-18T09:00:00Z",
    entity: "phase",
    action: "created",
    source: "manual",
    label: "Phase 1: Foundation Cut",
    changes: {
      seq: 0,
      name: "Phase 1: Foundation Cut",
      diet_fat_g: 60,
      diet_carb_g: 285,
      diet_directive: "Hit your 2150 kcal target daily, keep protein at 120g minimum, and spread meals across 3-4 sittings.",
      diet_protein_g: 120,
      duration_weeks: 4,
      training_block: { split_type: "Upper/Lower", days_per_week: 4, week_pattern: ["Upper A", "Lower A", "Rest", "Upper B", "Lower B", "Rest", "Rest"] },
      start_offset_weeks: 0,
      training_directive: "RIR 2-3 on all working sets.",
      diet_calorie_target: 2150,
      readiness_directive: "On low-readiness days, drop the top set.",
    },
  });
  assertEquals(
    line,
    "2026-09-18 (manual) phase 'Phase 1: Foundation Cut' created: 4 wk, 2150 kcal / 120 g protein, Upper/Lower 4 days",
  );
});

Deno.test("a program created line names the target and horizon", () => {
  const line = formatPlanChange({
    occurred_at: "2026-09-18T09:00:00Z",
    entity: "program",
    action: "created",
    source: "manual",
    label: "13-Week General Fitness Cut",
    changes: {
      goal: "general",
      title: "13-Week General Fitness Cut",
      status: "active",
      objective: "Strip roughly 5kg of fat over 13 weeks.",
      start_date: "2026-09-18",
      target_date: "2026-12-18",
      total_weeks: 13,
      target_weight_kg: 70,
    },
  });
  assertEquals(
    line,
    "2026-09-18 (manual) program '13-Week General Fitness Cut' created: 13 weeks, goal general, target 70 kg by 2026-12-18",
  );
});

Deno.test("routine exercise edits name the exercises and the changed fields", () => {
  const line = formatPlanChange({
    occurred_at: "2026-09-14T18:30:00Z",
    entity: "routine_exercises",
    action: "changed",
    source: "chat",
    label: "Push",
    changes: {
      added: [{ exercise_id: "a", name: "Cable Fly", sets: 3 }],
      removed: [{ exercise_id: "b", name: "Pec Deck", sets: 3 }],
      changed: [{ exercise_id: "c", name: "Bench Press", fields: { sets: { from: 3, to: 4 } } }],
      reordered: true,
    },
  });
  assertEquals(
    line,
    "2026-09-14 (chat) routine 'Push': added Cable Fly; removed Pec Deck; changed Bench Press (sets 3→4); reordered",
  );
});

Deno.test("directive rewrites are named, never pasted", () => {
  const line = formatPlanChange({
    occurred_at: "2026-09-15T09:00:00Z",
    entity: "phase",
    action: "changed",
    source: "chat",
    label: "Deload",
    changes: {
      diet_calorie_target: { from: 2400, to: 2300 },
      training_directive: { from: "long text", to: "other long text" },
    },
  });
  assertEquals(line, "2026-09-15 (chat) phase 'Deload': calories 2400→2300, training directive rewritten");
});

Deno.test("removed and empty rows", () => {
  assertEquals(
    formatPlanChange({
      occurred_at: "2026-09-10T00:00:00Z", entity: "routine", action: "removed",
      source: "manual", label: "Old Legs", changes: { name: "Old Legs" },
    }),
    "2026-09-10 (manual) routine 'Old Legs' removed",
  );
  assertEquals(
    formatPlanChange({
      occurred_at: "2026-09-10T00:00:00Z", entity: "targets", action: "changed",
      source: "manual", label: null, changes: {},
    }),
    "2026-09-10 (manual) targets",
  );
});

Deno.test("planChangesForContext keeps order and honours the cap", () => {
  const row = (d: string) => ({
    occurred_at: d, entity: "targets", action: "changed", source: "manual", label: null,
    changes: { daily_calorie_target: { from: 1, to: 2 } },
  });
  const lines = planChangesForContext([row("2026-09-18"), row("2026-09-17"), row("2026-09-16")], 2);
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0], "2026-09-18");
  assertStringIncludes(lines[1], "2026-09-17");
  assertEquals(planChangesForContext(null), []);
});

Deno.test("a very long line is cut", () => {
  const line = formatPlanChange({
    occurred_at: "2026-09-14T18:30:00Z", entity: "routine_exercises", action: "changed",
    source: "chat", label: "Push",
    changes: { added: Array.from({ length: 30 }, (_, i) => ({ name: `Exercise Number ${i} With A Long Name` })) },
  })!;
  assertEquals(line.length <= 240, true);
  assertEquals(line.endsWith("..."), true);
});

// ── memory + cards ───────────────────────────────────────────────────────────

Deno.test("memory facts carry the day they were last noted", () => {
  const facts = memoryForContext([
    { category: "constraint", key: "session length", value: "Under 45 minutes.", updated_at: "2026-09-12T08:00:00Z" },
  ]);
  assertEquals(facts, [{ category: "constraint", key: "session length", value: "Under 45 minutes.", noted: "2026-09-12" }]);
  assertEquals(memoryForContext(undefined), []);
});

Deno.test("cards keep the decision and drop an empty summary", () => {
  const cards = cardsForContext([
    { week_start: "2026-09-14", kind: "request", topic: "weigh_in", title: "Step on the scale", status: "dismissed", summary: "  " },
    { week_start: "2026-09-07", kind: "talk", topic: "adherence", title: "Two of four", status: "done", summary: "Travel week." },
  ]);
  assertEquals(cards[0], { week: "2026-09-14", kind: "request", topic: "weigh_in", title: "Step on the scale", status: "dismissed" });
  assertEquals(cards[1].summary, "Travel week.");
});

// ── measurements ─────────────────────────────────────────────────────────────

Deno.test("latest per site with the oldest reading as the comparison", () => {
  const s = summarizeMeasurements([
    { measured_on: "2026-09-10", site: "waist", value_cm: "82.50" },
    { measured_on: "2026-07-01", site: "waist", value_cm: "84.00" },
    { measured_on: "2026-08-05", site: "waist", value_cm: "83.20" },
    { measured_on: "2026-09-10", site: "chest", value_cm: 101 },
  ])!;
  assertEquals(s.latest_on, "2026-09-10");
  assertEquals(s.days_logged, 3);
  assertEquals(s.sites, [
    { site: "chest", cm: 101, on: "2026-09-10" },
    { site: "waist", cm: 82.5, on: "2026-09-10", prev_cm: 84, prev_on: "2026-07-01" },
  ]);
});

Deno.test("no readings means no block", () => {
  assertEquals(summarizeMeasurements([]), null);
  assertEquals(summarizeMeasurements(null), null);
  assertEquals(summarizeMeasurements([{ measured_on: "x", site: "waist", value_cm: "nope" }]), null);
});

// ── memory tool outcomes on the trace ────────────────────────────────────────

Deno.test("a refused save is a refusal, with the database's reason", () => {
  assertEquals(
    memoryRefusalOf("remember_fact", { saved: false, reason: "value must be 1 to 300 characters" }),
    "value must be 1 to 300 characters",
  );
  assertEquals(memoryRefusalOf("forget_fact", { forgotten: 0 }), "nothing changed");
});

Deno.test("a kept save and other tools are not refusals", () => {
  assertEquals(memoryRefusalOf("remember_fact", { saved: true, updated: false, id: "x" }), null);
  assertEquals(memoryRefusalOf("forget_fact", { forgotten: 1 }), null);
  assertEquals(memoryRefusalOf("coach_get_body_log", { saved: false }), null);
});
