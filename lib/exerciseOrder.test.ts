import { assertEquals } from "jsr:@std/assert@1";
import { moveExercise, pillKeys } from "./exerciseOrder.ts";

const ex = (name: string, supersetGroup: number | null = null) => ({ name, supersetGroup });
const names = (items: { name: string }[]) => items.map((e) => e.name).join(" ");
const groups = (items: { supersetGroup?: number | null }[]) => items.map((e) => e.supersetGroup ?? 0).join("");

Deno.test("a move puts the exercise at its new place and tells where each one went", () => {
  const res = moveExercise([ex("A"), ex("B"), ex("C"), ex("D")], 0, 2);
  assertEquals(names(res.items), "B C A D");
  // old index -> new index, so the started / finished flags can follow.
  assertEquals(res.indexMap, [2, 0, 1, 3]);
  assertEquals(res.groupsChanged, false);
});

Deno.test("a move to the same place, or a bad index, changes nothing", () => {
  const items = [ex("A"), ex("B")];
  assertEquals(moveExercise(items, 1, 1).items, items);
  assertEquals(moveExercise(items, 5, 0).items, items);
  assertEquals(moveExercise(items, 0, -1).items, items);
});

Deno.test("an exercise dropped inside a superset lands after it, and the superset stays whole", () => {
  const res = moveExercise([ex("A"), ex("B", 1), ex("C", 1), ex("D", 1), ex("E")], 0, 2);
  assertEquals(names(res.items), "B C D A E");
  assertEquals(groups(res.items), "11100");
  assertEquals(res.indexMap, [3, 0, 1, 2, 4]);
  assertEquals(res.groupsChanged, false);
});

Deno.test("members can change order inside their own superset", () => {
  const res = moveExercise([ex("A", 1), ex("B", 1), ex("C", 1), ex("D")], 0, 1);
  assertEquals(names(res.items), "B A C D");
  assertEquals(groups(res.items), "1110");
  assertEquals(res.groupsChanged, false);
});

Deno.test("a member dragged out leaves its superset", () => {
  const res = moveExercise([ex("A", 1), ex("B", 1), ex("C", 1), ex("D"), ex("E")], 0, 4);
  assertEquals(names(res.items), "B C D E A");
  assertEquals(groups(res.items), "11000");
  assertEquals(res.groupsChanged, true);
});

Deno.test("a pair that loses one member is not a superset any more", () => {
  const res = moveExercise([ex("A", 1), ex("B", 1), ex("C")], 0, 2);
  assertEquals(names(res.items), "B C A");
  assertEquals(groups(res.items), "000");
  assertEquals(res.groupsChanged, true);
});

Deno.test("a member dropped inside another superset lands after it and joins nothing", () => {
  const res = moveExercise([ex("A", 1), ex("B", 1), ex("C", 1), ex("X", 2), ex("Y", 2)], 0, 3);
  assertEquals(names(res.items), "B C X Y A");
  assertEquals(groups(res.items), "11220");
});

Deno.test("pill keys stay with their exercise through a reorder when the copies keep their order", () => {
  const a = { exercise: { id: "a" } }, b = { exercise: { id: "b" } }, a2 = { exercise: { id: "a" } };
  assertEquals(pillKeys([a, b, a2]), ["a#0", "b#0", "a#1"]);
  assertEquals(pillKeys([b, a, a2]), ["b#0", "a#0", "a#1"]);
});

Deno.test("two copies of one exercise that cross each other trade keys: a key is the copy's place, not the copy", () => {
  const a = { exercise: { id: "a" } }, b = { exercise: { id: "b" } }, a2 = { exercise: { id: "a" } };
  // a2 moved in front of a: it is now the first copy, so it takes a#0.
  assertEquals(pillKeys([a2, a, b]), ["a#0", "a#1", "b#0"]);
});
