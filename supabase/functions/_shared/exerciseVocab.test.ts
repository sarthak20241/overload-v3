import { assertEquals } from "jsr:@std/assert@1";
import {
  ALL_MUSCLE_GROUPS,
  CATEGORIES,
  CUSTOM_MUSCLE_GROUPS,
  DEFAULT_METRIC_TYPE,
  METRIC_TYPE_VALUES,
  MUSCLE_GROUP_REFINEMENTS,
  normalizeNewExercise,
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
