// Run with: deno test lib/programNarrative.test.ts
//
// The bug this pins: a starter program for a cut interpolated `dateLabel`
// unconditionally, but that label is null whenever no pace has been chosen.
// The onboarding screen seeds the weekly rate in an effect that runs one
// render AFTER the direction flips, so a fast tap through the target step
// could persist `coach_programs.objective` reading literally
// "Down 5 kg by null while your lifts keep climbing."

import { assert, assertEquals } from "jsr:@std/assert@1";
import { programNarrative } from "./programNarrative.ts";

Deno.test("a cut with no pace yet never prints the word null", () => {
  const n = programNarrative({
    direction: "loss", weeks: 12, diffLabel: "5", goalWeightKg: 67.5,
    dateLabel: null, goal: "fat_loss", frequency: 4,
  });
  assert(!n.objective.includes("null"), n.objective);
  assert(!n.title.includes("null"), n.title);
  assertEquals(n.objective, "Down 5 kg while your lifts keep climbing.");
});

Deno.test("a gain with no pace yet never prints the word null", () => {
  const n = programNarrative({
    direction: "gain", weeks: 10, diffLabel: "3.5", goalWeightKg: 80,
    dateLabel: null, goal: "hypertrophy", frequency: 4,
  });
  assert(!n.objective.includes("null"), n.objective);
  assertEquals(n.objective, "Up 3.5 kg, most of it muscle.");
});

Deno.test("an omitted dateLabel behaves the same as an explicit null", () => {
  const n = programNarrative({
    direction: "loss", weeks: 9, diffLabel: "4", goalWeightKg: 68, frequency: 4,
  });
  assert(!n.objective.includes("null") && !n.objective.includes("undefined"), n.objective);
});

Deno.test("with a pace, the date is carried into the objective", () => {
  const cut = programNarrative({
    direction: "loss", weeks: 8, diffLabel: "4.5", goalWeightKg: 68,
    dateLabel: "Nov 8", goal: "fat_loss", frequency: 4,
  });
  assertEquals(cut.title, "8-Week Cut to 68 kg");
  assertEquals(cut.objective, "Down 4.5 kg by Nov 8 while your lifts keep climbing.");

  const gain = programNarrative({
    direction: "gain", weeks: 12, diffLabel: "3", goalWeightKg: 78,
    dateLabel: "Dec 5", goal: "hypertrophy", frequency: 5,
  });
  assertEquals(gain.title, "12-Week Lean Gain to 78 kg");
  assertEquals(gain.objective, "Up 3 kg by Dec 5, most of it muscle.");
});

Deno.test("holding steady names the block by goal and never mentions a date", () => {
  assertEquals(
    programNarrative({ direction: null, weeks: 12, diffLabel: "0", dateLabel: null, goal: "strength", frequency: 3 }),
    { title: "12-Week Strength Block", objective: "Twelve weeks of steady progressive overload, 3 days a week." },
  );
  // An unknown or absent goal key falls back rather than rendering undefined.
  const unknown = programNarrative({ direction: null, weeks: 12, diffLabel: "0", goal: "power", frequency: 4 });
  assertEquals(unknown.title, "12-Week Foundation");
});

Deno.test("no em dash in any branch", () => {
  for (const dir of ["loss", "gain", null] as const) {
    for (const dateLabel of ["Nov 8", null]) {
      const n = programNarrative({
        direction: dir, weeks: 10, diffLabel: "4", goalWeightKg: 70, dateLabel, goal: "fat_loss", frequency: 4,
      });
      assert(!n.objective.includes("—") && !n.title.includes("—"), n.objective);
    }
  }
});
