import { assertEquals } from "jsr:@std/assert@1";
import {
  dowOfISO,
  fuelDaysFromCoach,
  fuelDaysText,
  fuelDayText,
  kcalOnDow,
  normalizeFuelDays,
  targetsOnDow,
  weekKcal,
} from "./fuelDays.ts";

const BASE = { kcal: 2000, protein: 150, carb: 200, fat: 67 };
const LONG_RUN = { dow: 0, kcal: 300, label: "Long run" };
const LEGS = { dow: 6, kcal: 300, label: "Heavy legs" };

Deno.test("a fuel day adds its calories as carbs, protein and fat hold", () => {
  const sun = targetsOnDow(BASE, [LONG_RUN], 0);
  assertEquals(sun, { kcal: 2300, protein: 150, carb: 275, fat: 67 });
  // The four still add up: the extra 300 kcal is exactly 75 g of carbs.
  assertEquals(sun.carb * 4 - BASE.carb * 4, 300);
});

Deno.test("every other day keeps the base target", () => {
  for (const dow of [1, 2, 3, 4, 5]) {
    assertEquals(targetsOnDow(BASE, [LONG_RUN, LEGS], dow), BASE);
  }
  assertEquals(kcalOnDow(2000, [LONG_RUN, LEGS], 6), 2300);
  assertEquals(kcalOnDow(2000, [], 6), 2000);
});

Deno.test("the week adds the fuel on top, it does not shift it", () => {
  assertEquals(weekKcal(2000, [LONG_RUN, LEGS]), 14600);
  assertEquals(weekKcal(2000, []), 14000);
});

Deno.test("weekday comes from the calendar date, not the clock", () => {
  assertEquals(dowOfISO("2026-09-27"), 0); // a Sunday
  assertEquals(dowOfISO("2026-09-26"), 6); // a Saturday
  assertEquals(dowOfISO("2026-09-28"), 1);
});

Deno.test("normalize keeps one entry per day, Monday first, on the 50 grid", () => {
  const out = normalizeFuelDays([
    { dow: 0, kcal: 310, label: "  Long   run " },
    { dow: 6, kcal: 300 },
    { dow: 0, kcal: 400, label: "later wins" },
    { dow: 3, kcal: 5000 },
  ]);
  assertEquals(out, [
    { dow: 3, kcal: 1000 },
    { dow: 6, kcal: 300 },
    { dow: 0, kcal: 400, label: "later wins" },
  ]);
});

Deno.test("normalize drops what the app could not have written", () => {
  assertEquals(normalizeFuelDays(null), []);
  assertEquals(normalizeFuelDays({ dow: 0, kcal: 300 }), []);
  assertEquals(
    normalizeFuelDays([
      { dow: 7, kcal: 300 },
      { dow: 1.5, kcal: 300 },
      { dow: 2, kcal: 20 },
      { dow: 4, kcal: -300 },
      { dow: 5, kcal: "300" },
      "Sunday",
    ]),
    [],
  );
});

Deno.test("a label is cut short enough for one line", () => {
  const [d] = normalizeFuelDays([{ dow: 6, kcal: 300, label: "Heavy leg day with the long walk home" }]);
  assertEquals(d.label!.length <= 24, true);
});

Deno.test("text line reads day, reason, amount", () => {
  assertEquals(fuelDayText(LONG_RUN), "Sun Long run +300");
  assertEquals(fuelDayText({ dow: 6, kcal: 250 }), "Sat +250");
});

Deno.test("the coach names days; they become weekday numbers, Monday first", () => {
  const out = fuelDaysFromCoach([
    { day: "Sunday", extra_kcal: 300, label: "Long run" },
    { day: "saturday", extra_kcal: 300, label: "Heavy legs" },
    { day: "Wed", extra_kcal: 200 },
  ]);
  assertEquals(out, [
    { dow: 3, kcal: 200 },
    { dow: 6, kcal: 300, label: "Heavy legs" },
    { dow: 0, kcal: 300, label: "Long run" },
  ]);
  assertEquals(fuelDaysText(out!), "Wed +200, Sat Heavy legs +300, Sun Long run +300");
});

Deno.test("silence keeps the live fuel days; an empty list clears them", () => {
  assertEquals(fuelDaysFromCoach(undefined), undefined);
  assertEquals(fuelDaysFromCoach("Sunday +300"), undefined);
  assertEquals(fuelDaysFromCoach([]), []);
  assertEquals(fuelDaysText([]), "none");
});

Deno.test("a day the coach misnamed is dropped, not guessed", () => {
  assertEquals(
    fuelDaysFromCoach([{ day: "Funday", extra_kcal: 300 }, { day: "Sunday", extra_kcal: 300 }]),
    [{ dow: 0, kcal: 300 }],
  );
});

Deno.test("a list with nothing valid in it keeps the live fuel days, it does not clear them", () => {
  // Only a truly empty list means "none". A garbled one means nothing.
  assertEquals(fuelDaysFromCoach([{ day: "Funday", extra_kcal: 300 }, { day: "Sunday", extra_kcal: 20 }]), undefined);
});
