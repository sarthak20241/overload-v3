// Run with: deno test --allow-all supabase/functions/ai-coach/searchCountry.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { countryForTimezone } from "./searchCountry.ts";

Deno.test("India, and its old zone name", () => {
  assertEquals(countryForTimezone("Asia/Kolkata", null), "india");
  assertEquals(countryForTimezone("Asia/Calcutta", null), "india");
});

Deno.test("US and Canada are told apart even though both are America/*", () => {
  assertEquals(countryForTimezone("America/New_York", "india"), "united states");
  assertEquals(countryForTimezone("America/Indiana/Indianapolis", "india"), "united states");
  assertEquals(countryForTimezone("America/Toronto", "india"), "canada");
});

Deno.test("no stored zone takes the fallback; an unknown zone gets no boost", () => {
  assertEquals(countryForTimezone(null, "india"), "india");
  assertEquals(countryForTimezone("", "india"), "india");
  assertEquals(countryForTimezone("Antarctica/Troll", "india"), null);
});

Deno.test("Australia and the UK", () => {
  assertEquals(countryForTimezone("Australia/Sydney", null), "australia");
  assertEquals(countryForTimezone("Europe/London", null), "united kingdom");
});

Deno.test("a zone named like an Object property is not a country", () => {
  assertEquals(countryForTimezone("constructor", "india"), null);
  assertEquals(countryForTimezone("toString", "india"), null);
});
