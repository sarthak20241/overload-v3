// Run with: deno test lib/weekPattern.test.ts
//
// The phase card used to say "Push/Pull/Legs, 5 days a week" and stop there,
// so the reader had to invent the week themselves. These pin the day-by-day
// line that replaces that guess, and the guard that stops a coach-emitted
// pattern from contradicting the day count printed right next to it.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildWeekPattern,
  normalizeWeekPattern,
  REST,
  shortDayLabel,
  splitCycle,
  weekPatternFor,
  weekPatternText,
} from "./weekPattern.ts";

const training = (p: string[]) => p.filter((l) => l !== REST).length;

Deno.test("every built week is 7 days and trains exactly the promised count", () => {
  for (let d = 1; d <= 7; d += 1) {
    const p = buildWeekPattern("Push/Pull/Legs", d);
    assertEquals(p.length, 7, `days=${d}`);
    assertEquals(training(p), d, `days=${d} -> ${p.join(",")}`);
  }
});

Deno.test("a week never opens on a rest day", () => {
  for (let d = 1; d <= 7; d += 1) {
    assert(buildWeekPattern("Upper/Lower", d)[0] !== REST, `days=${d}`);
  }
});

Deno.test("the split names the days, not the day count", () => {
  assertEquals(
    buildWeekPattern("Push/Pull/Legs", 6),
    ["Push", "Pull", "Legs", "Push", "Pull", "Legs", REST],
  );
  assertEquals(buildWeekPattern("Upper/Lower", 4), ["Upper", REST, "Lower", "Upper", REST, "Lower", REST]);
  assertEquals(buildWeekPattern("Full Body x3", 3), ["Full Body", REST, "Full Body", REST, REST, "Full Body", REST]);
});

Deno.test("an unknown split still gets a sensible cycle for the day count", () => {
  assertEquals(splitCycle("", 3), ["Full Body"]);
  assertEquals(splitCycle("something the coach invented", 4), ["Upper", "Lower"]);
  assertEquals(splitCycle(null, 5), ["Push", "Pull", "Legs"]);
  // "PPL" must win over the bare "pull" rule.
  assertEquals(splitCycle("PPL", 6), ["Push", "Pull", "Legs"]);
});

Deno.test("a coach pattern that contradicts days_per_week is refused", () => {
  // 5 training days listed, but the phase header says 4. Showing both would
  // put two different answers on the same card.
  const bad = ["Push", "Pull", "Legs", "Upper", "Lower", REST, REST];
  assertEquals(normalizeWeekPattern(bad, 4), undefined);
  // Same list, and now the header agrees, so it is kept.
  assertEquals(normalizeWeekPattern(bad, 5), bad);
});

Deno.test("a coach pattern that is not 7 days is refused", () => {
  assertEquals(normalizeWeekPattern(["Push", "Pull", "Legs"], 3), undefined);
  assertEquals(normalizeWeekPattern([], 3), undefined);
  assertEquals(normalizeWeekPattern("Push, Pull, Legs", 3), undefined);
  assertEquals(normalizeWeekPattern([1, 2, 3, 4, 5, 6, 7], 7), undefined);
});

Deno.test("rest days are spelled one way however the coach wrote them", () => {
  const p = normalizeWeekPattern(["Push", "off", "Pull", "-", "Legs", "REST DAY", "  "], 3);
  assertEquals(p, ["Push", REST, "Pull", REST, "Legs", REST, REST]);
});

Deno.test("weekPatternFor falls back when the coach pattern is unusable", () => {
  const built = buildWeekPattern("Upper/Lower", 4);
  assertEquals(
    weekPatternFor({ split_type: "Upper/Lower", days_per_week: 4, week_pattern: ["nope"] }),
    built,
  );
  // No day count at all: nothing honest to draw, so draw nothing.
  assertEquals(weekPatternFor({ split_type: "Upper/Lower" }), undefined);
  assertEquals(weekPatternFor(null), undefined);
  assertEquals(weekPatternFor({ days_per_week: 0 }), undefined);
});

Deno.test("a good coach pattern is kept as the coach wrote it", () => {
  const good = ["Push", "Pull", REST, "Legs", "Upper", REST, REST];
  assertEquals(
    weekPatternFor({ split_type: "Push/Pull/Legs", days_per_week: 4, week_pattern: good }),
    good,
  );
});

Deno.test("no em dash in any generated label", () => {
  for (let d = 1; d <= 7; d += 1) {
    for (const s of ["Push/Pull/Legs", "Upper/Lower", "Full Body", "Arnold", "Bro split", ""]) {
      assert(!buildWeekPattern(s, d).join("").includes("—"));
    }
  }
});

Deno.test("long labels are cut at a word, short ones are left alone", () => {
  assertEquals(shortDayLabel("Push"), "Push");
  assertEquals(shortDayLabel("Full Body"), "Full Body");
  assertEquals(shortDayLabel("Chest + Back"), "Chest");
  assertEquals(shortDayLabel("Shoulders + Arms"), "Shoulders");
  assertEquals(shortDayLabel("Antagonistic"), "Antagoni");
  assertEquals(shortDayLabel("Upper/Lower body"), "Upper");
});

Deno.test("the refine recap spells the week out so the coach can keep it", () => {
  // Review finding on #163: week_pattern is required in generate_program, but
  // the refine recap never showed the model the current week, so ANY refine
  // (even one only about calories) made it invent a new schedule. The recap
  // line has to carry every day, in order, rest days included.
  assertEquals(
    weekPatternText(["Push", "Rest", "Pull", "Legs", "Rest", "Upper", "Rest"]),
    "Day 1 Push, Day 2 Rest, Day 3 Pull, Day 4 Legs, Day 5 Rest, Day 6 Upper, Day 7 Rest",
  );
});
