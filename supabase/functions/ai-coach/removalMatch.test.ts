// Run with: deno test supabase/functions/ai-coach/removalMatch.test.ts
//
// The case that slipped through review round 3 and was caught in round 4:
// migration 0106 added multi-word graded names, and matching a short removal
// phrase against a longer row name failed, so the no-drop guard resurrected
// the line the user had just removed.

import { assertEquals } from "jsr:@std/assert@1";
import { removalNames } from "./parseMeal.ts";

Deno.test("a vague phrase removes a more specific row", () => {
  // THE REGRESSION. The row is more specific than the user bothered to be.
  assertEquals(removalNames("remove the milk", "Toned Milk"), true);
  assertEquals(removalNames("remove the milk", "Double Toned Milk"), true);
  assertEquals(removalNames("drop the paneer", "Low Fat Paneer"), true);
  assertEquals(removalNames("I did not have the rice", "Rice (cooked)"), true);
});

Deno.test("the bare name still works", () => {
  // What the schema now asks the model to send.
  assertEquals(removalNames("Tofu", "Tofu nature, preemballe"), true);
  assertEquals(removalNames("Toned Milk", "Toned Milk"), true);
});

Deno.test("a specific phrase does NOT remove a different food", () => {
  assertEquals(removalNames("remove the milk", "Roti / Chapati"), false);
  assertEquals(removalNames("drop the paneer", "Toned Milk"), false);
  // More specific than the row: asking for low fat paneer must not delete the
  // plain paneer line, since that is not what they named.
  assertEquals(removalNames("remove the low fat paneer", "Paneer"), false);
});

Deno.test("a phrase of pure filler removes nothing", () => {
  // "remove that" names no food; deleting on it would be a guess.
  assertEquals(removalNames("remove that", "Toned Milk"), false);
  assertEquals(removalNames("delete the one", "Paneer"), false);
});

Deno.test("typos still resolve", () => {
  assertEquals(removalNames("remove the panner", "Paneer"), true);
});
