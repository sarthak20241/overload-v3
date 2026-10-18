import { assertEquals } from "jsr:@std/assert@1";
import { missingColumn, withoutColumns } from "./missingColumn.ts";

const COLS = ["activity_steps_target", "cardio_sessions_per_week"];

Deno.test("a select on a database without the column falls back", () => {
  // The Postgres message, passed through by PostgREST.
  const err = { code: "42703", message: "column coach_program_phases.activity_steps_target does not exist" };
  assertEquals(missingColumn(err, COLS), true);
});

Deno.test("an insert on a database without the column falls back", () => {
  const err = { code: "PGRST204", message: "Could not find the 'cardio_sessions_per_week' column of 'coach_program_phases' in the schema cache" };
  assertEquals(missingColumn(err, COLS), true);
});

Deno.test("an unrelated failure is never swallowed as a missing column", () => {
  // A different missing column: another fallback's job, not this one's.
  assertEquals(missingColumn({ code: "42703", message: "column coach_program_phases.diet_fuel_days does not exist" }, COLS), false);
  // Our column named, but not a missing-column error.
  assertEquals(missingColumn({ code: "23514", message: "violates check constraint coach_program_phases_activity_steps_target_range" }, COLS), false);
  assertEquals(missingColumn({ code: "42501", message: "permission denied" }, COLS), false);
  assertEquals(missingColumn(null, COLS), false);
  assertEquals(missingColumn(new Error("network"), COLS), false);
});

Deno.test("the retry rows drop only the named columns", () => {
  const rows = [
    { seq: 0, name: "Deficit", activity_steps_target: 10000, cardio_sessions_per_week: 3 },
    { seq: 1, name: "Break" },
  ];
  assertEquals(withoutColumns(rows, COLS), [{ seq: 0, name: "Deficit" }, { seq: 1, name: "Break" }]);
  // The originals are untouched: the first attempt's rows are not mutated.
  assertEquals(rows[0].activity_steps_target, 10000);
});
