// Run with: deno test lib/logDay.test.ts
//
// lib/logDay.ts has no imports, so Deno can test it directly. Every case pins
// "now" to Sunday 11 Oct 2026, 21:40 local.

import { assertEquals } from "jsr:@std/assert@1";
import { latestLogDay, MAX_FUTURE_LOG_DAYS, readLogDayPhrase } from "./logDay.ts";

const NOW = new Date(2026, 9, 11, 21, 40); // Sun 11 Oct 2026
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const read = (text: string) => {
  const r = readLogDayPhrase(text, NOW);
  return r ? { day: ymd(r.date), rest: r.rest } : null;
};

Deno.test("tomorrow moves the log one day ahead and leaves the food", () => {
  assertEquals(read("2 eggs for tomorrow"), { day: "2026-10-12", rest: "2 eggs" });
  assertEquals(read("Tomorrow: 75g raw prawns, 140g button mushroom"), { day: "2026-10-12", rest: "75g raw prawns, 140g button mushroom" });
  assertEquals(read("tomorrow's breakfast 40g oats"), { day: "2026-10-12", rest: "breakfast 40g oats" });
  assertEquals(read("log 2 rotis for dinner tmrw"), { day: "2026-10-12", rest: "log 2 rotis for dinner" });
  assertEquals(read("1 apple, tommorow"), { day: "2026-10-12", rest: "1 apple" });
});

Deno.test("day after tomorrow is two days, not tomorrow", () => {
  assertEquals(read("paneer 100g day after tomorrow"), { day: "2026-10-13", rest: "paneer 100g" });
  assertEquals(read("for the day after tomorrow, 2 eggs"), { day: "2026-10-13", rest: "2 eggs" });
});

Deno.test("a weekday with a lead-in is the coming one", () => {
  assertEquals(read("oats for monday"), { day: "2026-10-12", rest: "oats" });
  assertEquals(read("on friday lunch: rice and dal"), { day: "2026-10-16", rest: "lunch: rice and dal" });
  assertEquals(read("next Wednesday 2 eggs"), { day: "2026-10-14", rest: "2 eggs" });
  // Said on a Sunday: "for sunday" is next week, "this sunday" is today.
  assertEquals(read("for sunday 2 eggs")?.day, "2026-10-18");
  assertEquals(read("this sunday 2 eggs")?.day, "2026-10-11");
});

Deno.test("a weekday is not read without a lead-in or in the past tense", () => {
  assertEquals(read("chicken from sunday's batch, 150g"), null);
  assertEquals(read("monday leftovers 200g rice"), null);
  assertEquals(read("had this on monday, 2 eggs"), null);
  assertEquals(read("ate 2 eggs on friday"), null);
});

Deno.test("a day and month name are read either way round", () => {
  assertEquals(read("2 eggs on 14 oct"), { day: "2026-10-14", rest: "2 eggs" });
  assertEquals(read("for oct 20th: 100g paneer"), { day: "2026-10-20", rest: "100g paneer" });
  assertEquals(read("on the 1st of november 1 banana"), { day: "2026-11-01", rest: "1 banana" });
  assertEquals(read("12 Oct oats 40g"), { day: "2026-10-12", rest: "oats 40g" });
});

Deno.test("a date outside today..latest is not read, so the food stays put", () => {
  assertEquals(read("2 eggs on 9 oct"), null); // two days ago
  assertEquals(read("2 eggs on 25 dec"), null); // past the window
  assertEquals(read("2 eggs on 31 feb"), null); // no such day
});

Deno.test("food words that look like dates are left alone", () => {
  assertEquals(read("2/3 cup rice"), null);
  assertEquals(read("sun dried tomatoes 20g"), null);
  assertEquals(read("i may have 2 eggs"), null);
  assertEquals(read("100g march mango"), null);
});

Deno.test("a message that is only the day has nothing left to parse", () => {
  assertEquals(read("for tomorrow"), { day: "2026-10-12", rest: "" });
  assertEquals(read("Tomorrow."), { day: "2026-10-12", rest: "" });
});

Deno.test("the window ends MAX_FUTURE_LOG_DAYS after today", () => {
  assertEquals(ymd(latestLogDay(NOW)), "2026-11-10");
  assertEquals(MAX_FUTURE_LOG_DAYS, 30);
  assertEquals(read("on 10 nov 2 eggs")?.day, "2026-11-10");
  assertEquals(read("on 11 nov 2 eggs"), null);
});
