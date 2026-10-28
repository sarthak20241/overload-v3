import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import {
  landed, pendingRows, prunePending, settlePending, withPending, type PendingGroup,
} from "./pendingEntries.ts";

type Row = { id: string; meal_type: "breakfast" | "lunch"; food_name: string; pending?: boolean };
const day = (breakfast: Row[] = [], lunch: Row[] = []) => ({ breakfast, lunch });
const real = (id: string, food_name = id): Row => ({ id, meal_type: "breakfast", food_name });
const group = (over: Partial<PendingGroup<Row>> = {}): PendingGroup<Row> => ({
  id: "g1", dayIso: "2026-10-27", realIds: null,
  entries: [
    { id: "pending:g1:0", meal_type: "breakfast", food_name: "eggs", pending: true },
    { id: "pending:g1:1", meal_type: "breakfast", food_name: "toast", pending: true },
  ],
  ...over,
});

Deno.test("a tapped line shows at once, under the meal it was added to", () => {
  const shown = withPending(day([real("a")]), "2026-10-27", [group()]);
  assertEquals(shown.breakfast.map((e) => e.food_name), ["a", "eggs", "toast"]);
  assertEquals(shown.lunch, []);
});

Deno.test("a line added to another day stays off this one", () => {
  const byMeal = day([real("a")]);
  assertStrictEquals(withPending(byMeal, "2026-10-28", [group()]), byMeal);
});

Deno.test("nothing pending: the day comes back as the same object", () => {
  const byMeal = day([real("a")]);
  assertStrictEquals(withPending(byMeal, "2026-10-27", []), byMeal);
});

Deno.test("saved: the lines take the real ids, so the rows do not remount", () => {
  const [g] = settlePending([group()], "g1", ["r1", "r2"]);
  assertEquals(g.realIds, ["r1", "r2"]);
  assertEquals(g.entries.map((e) => e.id), ["r1", "r2"]);
  // Still shown as pending until the day is read back.
  assertEquals(g.entries.every((e) => e.pending), true);
});

Deno.test("saved with a different count: ids stay, the group still knows its rows", () => {
  const [g] = settlePending([group()], "g1", ["r1"]);
  assertEquals(g.realIds, ["r1"]);
  assertEquals(g.entries.map((e) => e.id), ["pending:g1:0", "pending:g1:1"]);
});

Deno.test("read back: the real rows replace the pending ones, never both", () => {
  const groups = settlePending([group()], "g1", ["r1", "r2"]);
  const fetched = day([real("a"), real("r1", "eggs"), real("r2", "toast")]);
  const shown = withPending(fetched, "2026-10-27", groups);
  assertStrictEquals(shown, fetched);
  assertEquals(prunePending(groups, fetched, "2026-10-27"), []);
});

Deno.test("a read that started before the save keeps the lines shown", () => {
  const groups = settlePending([group()], "g1", ["r1", "r2"]);
  const stale = day([real("a")]);
  assertEquals(withPending(stale, "2026-10-27", groups).breakfast.length, 3);
  assertStrictEquals(prunePending(groups, stale, "2026-10-27"), groups);
});

Deno.test("a read with only some of the saved rows: each row shows once", () => {
  const groups = settlePending([group()], "g1", ["r1", "r2"]);
  const partial = day([real("a"), real("r1", "eggs")]);
  const shown = withPending(partial, "2026-10-27", groups);
  assertEquals(shown.breakfast.map((e) => e.id), ["a", "r1", "r2"]);
  assertEquals(shown.breakfast.map((e) => !!e.pending), [false, false, true]);
});

Deno.test("still saving: a read never drops the lines", () => {
  const groups = [group()];
  assertStrictEquals(prunePending(groups, day([real("a")]), "2026-10-27"), groups);
});

Deno.test("a read of another day leaves this day's lines alone", () => {
  const groups = settlePending([group()], "g1", ["r1", "r2"]);
  const other = day([real("r1"), real("r2")]);
  assertStrictEquals(prunePending(groups, other, "2026-10-28"), groups);
});

Deno.test("landed needs every row the save wrote", () => {
  const g = settlePending([group()], "g1", ["r1", "r2"])[0];
  assertEquals(landed(g, day([real("r1")])), false);
  assertEquals(landed(g, day([real("r1")], [{ ...real("r2"), meal_type: "lunch" }])), true);
  assertEquals(landed(group(), day([real("r1"), real("r2")])), false);
});

Deno.test("pending rows carry the numbers the save will store", () => {
  const rows = pendingRows("g7", [
    { food_id: "f", food_name: "oats", quantity: 1.5, serving_unit: "cup", grams_logged: 120.04,
      kcal: 301.6, protein_g: 10.04, carb_g: 54.36, fat_g: 5.55, source: "catalog" },
    { food_name: "chai", quantity: 1, serving_unit: "cup", grams_logged: 0,
      kcal: 90, protein_g: 3, carb_g: 12, fat_g: 3 },
  ], "breakfast");
  assertEquals(rows[0], {
    id: "pending:g7:0", meal_id: "", meal_type: "breakfast", food_id: "f", source: "catalog",
    food_name: "oats", serving_unit: "cup", quantity: 1.5, grams_logged: 120,
    kcal: 302, protein_g: 10, carb_g: 54.4, fat_g: 5.6, pending: true,
  });
  // 0 grams is "no weight known", stored as null.
  assertEquals(rows[1].grams_logged, null);
  assertEquals(rows[1].food_id, null);
  assertEquals(rows[1].source, null);
});
