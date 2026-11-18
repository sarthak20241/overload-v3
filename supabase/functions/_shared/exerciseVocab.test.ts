import { assertEquals } from "jsr:@std/assert@1";
import {
  ALL_MUSCLE_GROUPS,
  CATEGORIES,
  CUSTOM_MUSCLE_GROUPS,
  DEFAULT_METRIC_TYPE,
  METRIC_TYPE_VALUES,
  MUSCLE_GROUP_REFINEMENTS,
  normalizeNewExercise,
  SWAP_PATTERN_VALUES,
} from "./exerciseVocab.ts";
import * as app from "../../../lib/exercises.ts";

// exerciseVocab.ts is a copy of the app's lists. If one side gains a value the
// other lacks, Drona describes new exercises in words the app does not store.
Deno.test("the template matches the app's custom exercise form, value for value", () => {
  assertEquals([...METRIC_TYPE_VALUES], app.METRIC_TYPES.map((m) => m.value));
  assertEquals(DEFAULT_METRIC_TYPE, app.DEFAULT_METRIC_TYPE);
  assertEquals([...CUSTOM_MUSCLE_GROUPS], [...app.CUSTOM_MUSCLE_GROUPS]);
  assertEquals(MUSCLE_GROUP_REFINEMENTS, app.MUSCLE_GROUP_REFINEMENTS);
  assertEquals(ALL_MUSCLE_GROUPS, app.ALL_MUSCLE_GROUPS);
  assertEquals([...CATEGORIES], [...app.CATEGORIES]);
});

Deno.test("loose matching keeps the app's spelling", () => {
  assertEquals(normalizeNewExercise("hip flexors", "BODYWEIGHT", "distance-duration"), {
    muscle_group: "Hip Flexors",
    category: "Bodyweight",
    metric_type: "distance_duration",
  });
});

// The swap tags (migration 20261117120000) are data in a SQL file. A tag the
// app does not know would rank an exercise under a muscle no screen shows, or
// fail the column's check and stop the whole migration.
Deno.test("every swap tag in the migration is a word the app knows", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20261117120000_exercise_swap_tags.sql", import.meta.url),
  );
  const check = sql.match(/swap_pattern in \(([^)]+)\)/)?.[1] ?? "";
  assertEquals([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...SWAP_PATTERN_VALUES]);

  const rows = [...sql.matchAll(/^  \('((?:[^']|'')+)', '([^']+)', '([a-z_]+)'\),?$/gm)];
  assertEquals(rows.length > 700, true, "tag rows found");
  const names = rows.map((r) => r[1]);
  assertEquals(new Set(names).size, names.length, "one row per name");
  assertEquals(names.filter((n) => n !== n.toLowerCase()), [], "names are name_lower");
  assertEquals([...new Set(rows.map((r) => r[2]))].filter((m) => !ALL_MUSCLE_GROUPS.includes(m)), []);
  const known: readonly string[] = SWAP_PATTERN_VALUES;
  assertEquals([...new Set(rows.map((r) => r[3]))].filter((p) => !known.includes(p)), []);
});
