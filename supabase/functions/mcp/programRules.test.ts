// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { programGoalFor as appGoalFor } from "../../../lib/fitnessGoals.ts";
import {
  ADD_UP_SLACK,
  dietFor,
  type Diet,
  fillMissingMacros,
  GOALS,
  macroKcal,
  mirrorOf,
  offsetsOf,
  phaseRow,
  type PhaseRow,
  programGoalFor,
  targetsChanged,
} from "./programRules.ts";

const BASE: Diet = { kcal: 2400, protein: 160, carb: 270, fat: 75 };
const WEEK = ["Upper", "Lower", "Rest", "Upper", "Lower", "Rest", "Rest"];
const BLOCK = { split_type: "Upper/Lower", days_per_week: 4, week_pattern: WEEK };

Deno.test("goal label: the copy agrees with the app's programGoalFor on every case", () => {
  const goals = [...GOALS, "nonsense", null];
  const weights = [null, 60, 79.5, 80, 80.5, 81, 95];
  for (const g of goals) for (const t of weights) for (const cur of [null, 0, 80]) {
    assertEquals(programGoalFor(g, t, cur), appGoalFor(g, t, cur), JSON.stringify([g, t, cur]));
  }
});

Deno.test("goal label: a cut is fat_loss whatever it was called; a gain is never fat_loss", () => {
  assertEquals(programGoalFor("hypertrophy", 75, 80), "fat_loss");
  assertEquals(programGoalFor("fat_loss", 85, 80), "hypertrophy");
  assertEquals(programGoalFor("strength", 80.5, 80), "strength");
});

Deno.test("diet: left-out carbs and fat are filled so the four add up", () => {
  const d = dietFor({ calories: 2000, protein_g: 170 }, BASE) as Diet;
  assertEquals(d.protein, 170);
  assert(Math.abs(macroKcal(d) - 2000) <= 9, JSON.stringify(d));
  const onlyFat = dietFor({ calories: 2000, protein_g: 170, fat_g: 60 }, BASE) as Diet;
  assertEquals(onlyFat.fat, 60);
  assert(Math.abs(macroKcal(onlyFat) - 2000) <= 4, JSON.stringify(onlyFat));
});

Deno.test("diet: four given that do not add up are refused; within the slack they save as given", () => {
  const bad = dietFor({ calories: 2000, protein_g: 150, carb_g: 300, fat_g: 80 }, BASE);
  assert(typeof bad === "string" && bad.includes("add up"), String(bad));
  const ok = dietFor({ calories: 2000, protein_g: 150, carb_g: 200, fat_g: 69 }, BASE) as Diet; // 2021 kcal
  assertEquals(ok, { kcal: 2000, protein: 150, carb: 200, fat: 69 });
  assertEquals(ADD_UP_SLACK(1000), 50);
});

Deno.test("diet: out of range is refused, never clamped quietly", () => {
  assert(typeof dietFor({ calories: 600, protein_g: 100 }, BASE) === "string");
  assert(typeof dietFor({ calories: 2000, protein_g: 600 }, BASE) === "string");
  // Protein that eats every calorie leaves nothing; still adds up, carbs and fat 0.
  const all = dietFor({ calories: 1200, protein_g: 300 }, BASE) as Diet;
  assertEquals([all.carb, all.fat], [0, 0]);
});

Deno.test("diet: an edit that moves only calories keeps protein and refills carbs and fat", () => {
  const d = dietFor({ calories: 2100 }, BASE) as Diet;
  assertEquals(d.protein, 160);
  assert(Math.abs(macroKcal(d) - 2100) <= 9);
});

Deno.test("fillMissingMacros: what the caller gives is kept exactly", () => {
  assertEquals(fillMissingMacros(2000, { protein: 150, carb: 200, fat: 60 }, { protein: 1, carb: 1, fat: 1 }),
    { protein: 150, carb: 200, fat: 60 });
});

Deno.test("phaseRow: a new phase needs a name, weeks, calories + protein and a training block", () => {
  const good = { name: "Cut", duration_weeks: 6, diet: { calories: 2000, protein_g: 170 }, training_block: BLOCK };
  assert(typeof phaseRow(good, "P1", BASE) === "object");
  for (const [k, v] of [["name", ""], ["duration_weeks", 30], ["diet", { calories: 2000 }], ["training_block", undefined]] as const) {
    const r = phaseRow({ ...good, [k]: v }, "P1", BASE);
    assert(typeof r === "string" && r.startsWith("P1:"), `${k}: ${JSON.stringify(r)}`);
  }
});

Deno.test("phaseRow: a week pattern that disagrees with days_per_week is refused", () => {
  const r = phaseRow({ name: "A", duration_weeks: 4, diet: { calories: 2000, protein_g: 150 },
    training_block: { ...BLOCK, days_per_week: 3 } }, "P1", BASE);
  assert(typeof r === "string" && r.includes("week_pattern"), String(r));
});

Deno.test("phaseRow: fuel days by weekday name; [] clears; a list with nothing readable is refused", () => {
  const base = { name: "A", duration_weeks: 4, diet: { calories: 2000, protein_g: 150 }, training_block: BLOCK };
  const r = phaseRow({ ...base, fuel_days: [{ day: "Sunday", extra_kcal: 310, label: "Long run" }] }, "P", BASE) as PhaseRow;
  assertEquals(r.diet_fuel_days, [{ dow: 0, kcal: 300, label: "Long run" }]);
  assertEquals((phaseRow({ ...base, fuel_days: [] }, "P", BASE) as PhaseRow).diet_fuel_days, []);
  assert(typeof phaseRow({ ...base, fuel_days: [{ day: "Funday", extra_kcal: 300 }] }, "P", BASE) === "string");
});

Deno.test("phaseRow: activity clamps to the app's grid; null clears; metrics need one hero", () => {
  const base = { name: "A", duration_weeks: 4, diet: { calories: 2000, protein_g: 150 }, training_block: BLOCK };
  const r = phaseRow({
    ...base,
    activity: { steps_per_day: 8240, cardio_sessions_per_week: 9 },
    metrics: [{ kind: "bodyweight", target: 78, direction: "down" }, { kind: "steps", target: 8000, hero: false }],
  }, "P", BASE) as PhaseRow;
  assertEquals([r.activity_steps_target, r.cardio_sessions_per_week], [8000, 7]);
  assertEquals(r.metrics!.map((m) => m.is_hero), [true, false]);
  const before = { ...r, id: "x", diet_fuel_days: null };
  const cleared = phaseRow({ activity: null }, "P", BASE, before) as PhaseRow;
  assertEquals([cleared.activity_steps_target, cleared.cardio_sessions_per_week], [null, null]);
  const oneOff = phaseRow({ activity: { cardio_sessions_per_week: null } }, "P", BASE, before) as PhaseRow;
  assertEquals([oneOff.activity_steps_target, oneOff.cardio_sessions_per_week], [8000, null]);
  assert(typeof phaseRow({ ...base, metrics: [{ kind: "lift_e1rm", target: 100 }] }, "P", BASE) === "string",
    "a lift with no exercise is not a metric");
});

Deno.test("phaseRow edit: fields left out keep the stored phase; metrics stay unless sent", () => {
  const stored = {
    id: "ph1", name: "Cut", duration_weeks: 6, diet_calorie_target: 2000, diet_protein_g: 170, diet_carb_g: 180, diet_fat_g: 64,
    diet_directive: "High protein", training_block: BLOCK, diet_fuel_days: [{ dow: 0, kcal: 300 }],
    activity_steps_target: 9000, cardio_sessions_per_week: null, job_text: "Bring weight 80 to 77 kg",
  };
  const r = phaseRow({ duration_weeks: 8 }, "Cut", BASE, stored) as PhaseRow;
  assertEquals(r.id, "ph1");
  assertEquals(r.duration_weeks, 8);
  assertEquals([r.diet_calorie_target, r.diet_protein_g, r.diet_carb_g, r.diet_fat_g], [2000, 170, 180, 64]);
  assertEquals(r.diet_fuel_days, [{ dow: 0, kcal: 300 }]);
  assertEquals(r.job_text, "Bring weight 80 to 77 kg");
  assertEquals(r.metrics, undefined);
  assertEquals(targetsChanged(stored, r), false);
  const moved = phaseRow({ diet: { calories: 1900 } }, "Cut", BASE, stored) as PhaseRow;
  assertEquals(moved.diet_protein_g, 170);
  assertEquals(targetsChanged(stored, moved), true);
});

Deno.test("offsets and the live-target copy", () => {
  assertEquals(offsetsOf([{ duration_weeks: 4 }, { duration_weeks: 1 }, { duration_weeks: 6 }]), [0, 4, 5]);
  const p = phaseRow({ name: "A", duration_weeks: 4, diet: { calories: 2000, protein_g: 150 }, training_block: BLOCK }, "P", BASE) as PhaseRow;
  assertEquals(Object.hasOwn(mirrorOf(0, { ...p, diet_fuel_days: null }), "fuel_days"), false, "no plan = live fuel days kept");
  assertEquals(mirrorOf(1, { ...p, diet_fuel_days: [] }).fuel_days, []);
});
