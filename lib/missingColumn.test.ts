import { assertEquals } from "jsr:@std/assert@1";
import { missingColumn, missingTable, nextColumnSet, withoutColumns } from "./missingColumn.ts";

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

// loadActiveProgram selects diet_fuel_days BEFORE the activity columns, and
// Postgres names only the first missing column. These pin the two cases.
Deno.test("both missing: the activity fallback passes, the fuel-days fallback catches it", () => {
  const err = { code: "42703", message: "column coach_program_phases.diet_fuel_days does not exist" };
  assertEquals(missingColumn(err, COLS), false);
  assertEquals(missingColumn(err, ["diet_fuel_days"]), true);
});

Deno.test("only activity missing: the activity fallback catches it, fuel days stay", () => {
  const err = { code: "42703", message: "column coach_program_phases.activity_steps_target does not exist" };
  assertEquals(missingColumn(err, COLS), true);
  assertEquals(missingColumn(err, ["diet_fuel_days"]), false);
});

// The phase metrics tables (migration 20261021120000): the app ships before
// the migration, so a read of a table that is not there yet falls back.
Deno.test("a read of a table the database does not have yet falls back", () => {
  // PostgREST: the table is not in its schema cache (also what a table created
  // without a schema reload answers).
  assertEquals(missingTable({ code: "PGRST205", message: "Could not find the table 'public.coach_program_phase_metrics' in the schema cache" }, "coach_program_phase_metrics"), true);
  // Postgres: undefined table.
  assertEquals(missingTable({ code: "42P01", message: "relation \"public.coach_program_phase_metrics\" does not exist" }, "coach_program_phase_metrics"), true);
});

Deno.test("an unrelated failure is never swallowed as a missing table", () => {
  // A different table.
  assertEquals(missingTable({ code: "PGRST205", message: "Could not find the table 'public.other' in the schema cache" }, "coach_program_phase_metrics"), false);
  // Our table named, but not a missing-table error.
  assertEquals(missingTable({ code: "42501", message: "permission denied for table coach_program_phase_metrics" }, "coach_program_phase_metrics"), false);
  // A missing COLUMN on the table is the column fallback's job.
  assertEquals(missingTable({ code: "42703", message: "column coach_program_phases.job_text does not exist" }, "coach_program_phases"), false);
  assertEquals(missingTable(null, "coach_program_phase_metrics"), false);
});

Deno.test("nextColumnSet skips straight to the first set without the column the database named", () => {
  // Widest first, as the program read uses them.
  const sets = [
    ["id", "diet_fuel_days", "activity_steps_target", "job_text"],
    ["id", "diet_fuel_days", "activity_steps_target"],
    ["id", "diet_fuel_days"],
    ["id"],
  ];
  const err = (col: string) => ({ code: "42703", message: `column coach_program_phases_1.${col} does not exist` });
  // Only the newest columns missing: one step.
  assertEquals(nextColumnSet(err("job_text"), sets, 0), 1);
  // Activity and job both missing: Postgres names the activity column first,
  // so it goes straight to the set without activity (and without job).
  assertEquals(nextColumnSet(err("activity_steps_target"), sets, 0), 2);
  // Older still: no fuel days.
  assertEquals(nextColumnSet(err("diet_fuel_days"), sets, 0), 3);
  // A column no set drops, or not a missing-column error: nothing to retry.
  assertEquals(nextColumnSet(err("id"), sets, 0), null);
  assertEquals(nextColumnSet({ code: "57014", message: "timeout" }, sets, 0), null);
  assertEquals(nextColumnSet(err("job_text"), sets, 3), null);
  // Exact names: a missing routine_id is not the 'id' column, and PGRST204's wording is read too.
  const withRoutine = [["id", "routine_id", "job_text"], ["id", "routine_id"], ["id"]];
  assertEquals(nextColumnSet(err("routine_id"), withRoutine, 0), 2);
  assertEquals(nextColumnSet({ code: "PGRST204", message: "Could not find the 'job_text' column of 'coach_program_phases' in the schema cache" }, withRoutine, 0), 1);
});
