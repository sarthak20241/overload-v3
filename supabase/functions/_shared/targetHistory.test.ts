import { assertEquals } from "jsr:@std/assert@1";
import { type DayTargetRow, historyRowOn, targetsForDay, type TargetHistoryRow } from "./targetHistory.ts";

const DEFAULTS = { kcal: 2000, protein: 125, carb: 250, fat: 56 };
const LIVE = { kcal: 1350, protein: 97, carb: 148, fat: 41 };
const TODAY = "2026-09-28";

// A user who cut from 1600 to 1300 on the 18th, then to 1350 today.
const HISTORY: TargetHistoryRow[] = [
  { effective_from: "1970-01-01", kcal: 1600, protein_g: 125, carb_g: 250, fat_g: 56 },
  { effective_from: "2026-09-18", kcal: "1300", protein_g: "94", carb_g: "150", fat_g: "36" },
  { effective_from: "2026-09-28", kcal: 1350, protein_g: 97, carb_g: 148, fat_g: 41 },
];

const on = (dayISO: string, dow = 1, history: TargetHistoryRow[] | null = HISTORY, liveFuel = []) =>
  targetsForDay({ dayISO, todayISO: TODAY, dow, live: LIVE, liveFuel, history, defaults: DEFAULTS });

Deno.test("a past day keeps the goal it had, not today's", () => {
  // Before the cut: 1600, even though the goal is 1350 now.
  assertEquals(on("2026-09-10").kcal, 1600);
  // Between the cut and today's edit: 1300 (numeric strings from PostgREST read fine).
  assertEquals(on("2026-09-20"), { kcal: 1300, protein: 94, carb: 150, fat: 36 });
  // The day of a change shows the new goal.
  assertEquals(on("2026-09-18").kcal, 1300);
});

Deno.test("today and later read the live goal", () => {
  assertEquals(on(TODAY), LIVE);
  assertEquals(on("2026-10-02"), LIVE);
});

Deno.test("no history to read falls back to the live goal, as before", () => {
  assertEquals(on("2026-09-10", 1, null), LIVE);
  assertEquals(on("2026-09-10", 1, []), LIVE);
  // Older than every row.
  assertEquals(on("2026-09-10", 1, [HISTORY[2]]), LIVE);
});

Deno.test("a target the snapshot never set falls back to the default", () => {
  const partial: TargetHistoryRow[] = [{ effective_from: "1970-01-01", kcal: 1800, protein_g: null, carb_g: null, fat_g: null }];
  assertEquals(on("2026-09-10", 1, partial), { kcal: 1800, protein: 125, carb: 250, fat: 56 });
});

Deno.test("a past day uses the fuel days of its own snapshot", () => {
  const fuel: TargetHistoryRow[] = [
    { effective_from: "1970-01-01", kcal: 2000, protein_g: 150, carb_g: 200, fat_g: 67 },
    { effective_from: "2026-09-26", kcal: 2000, protein_g: 150, carb_g: 200, fat_g: 67, calorie_day_boosts: [{ dow: 0, kcal: 300 }] },
  ];
  // Sunday the 20th: before the fuel days existed.
  assertEquals(on("2026-09-20", 0, fuel).kcal, 2000);
  // Sunday the 27th: a fuel day.
  assertEquals(on("2026-09-27", 0, fuel), { kcal: 2300, protein: 150, carb: 275, fat: 67 });
});

Deno.test("the row in force is the latest that started on or before the day", () => {
  assertEquals(historyRowOn(HISTORY, "2026-09-17")?.effective_from, "1970-01-01");
  assertEquals(historyRowOn(HISTORY, "2026-09-27")?.effective_from, "2026-09-18");
  // Order of the rows does not matter.
  assertEquals(historyRowOn([...HISTORY].reverse(), "2026-09-27")?.effective_from, "2026-09-18");
});

// "Today only" on the goal sheet: a goal for one day, the plan untouched.
const ONE_DAY: DayTargetRow[] = [{ day: TODAY, kcal: 1800, protein_g: 110, carb_g: 200, fat_g: 60 }];
const withOverride = (dayISO: string, dow = 1, liveFuel: { dow: number; kcal: number }[] = []) =>
  targetsForDay({ dayISO, todayISO: TODAY, dow, live: LIVE, liveFuel, history: HISTORY, defaults: DEFAULTS, overrides: ONE_DAY });

Deno.test("a one-day goal holds for its day and nowhere else", () => {
  assertEquals(withOverride(TODAY), { kcal: 1800, protein: 110, carb: 200, fat: 60 });
  // Tomorrow is back on the live goal (the plan).
  assertEquals(withOverride("2026-09-29"), LIVE);
  // Yesterday keeps its history.
  assertEquals(withOverride("2026-09-27").kcal, 1300);
});

Deno.test("a one-day goal on a past day wins over that day's history", () => {
  const past: DayTargetRow[] = [{ day: "2026-09-20", kcal: "1700", protein_g: null, carb_g: null, fat_g: null }];
  const t = targetsForDay({ dayISO: "2026-09-20", todayISO: TODAY, dow: 0, live: LIVE, liveFuel: [], history: HISTORY, defaults: DEFAULTS, overrides: past });
  // Calories from the one-day goal, macros it left empty from the day's history.
  assertEquals(t, { kcal: 1700, protein: 94, carb: 150, fat: 36 });
});

Deno.test("fuel days still add on top of a one-day goal", () => {
  // Today is a Sunday fuel day at +300.
  assertEquals(withOverride(TODAY, 0, [{ dow: 0, kcal: 300 }]), { kcal: 2100, protein: 110, carb: 275, fat: 60 });
});
