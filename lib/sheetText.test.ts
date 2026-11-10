// Run with: deno test --allow-all lib/sheetText.test.ts
//
// SheetTextInput's text model: what a box inside <Portal> shows when its
// owner's value reaches it late.

import { assertEquals } from "jsr:@std/assert@1";
import {
  SHEET_TEXT_MAX_PENDING,
  type SheetText,
  sheetTextCommitted,
  sheetTextInit,
  sheetTextOwnerRendered,
  sheetTextTyped,
} from "./sheetText.ts";

// One keystroke as the box sees it: the handler runs, then the box commits.
function key(s: SheetText, t: string): SheetText {
  return sheetTextCommitted(sheetTextTyped(s, t));
}

Deno.test("echoes of what was typed never move the text back", () => {
  let s = sheetTextInit("");
  for (const t of ["r", "ro", "rop", "rope"]) s = key(s, t);
  // The owner catches up one value at a time, late.
  for (const t of ["r", "ro", "rop"]) {
    s = sheetTextOwnerRendered(s, t);
    assertEquals(s.text, "rope");
  }
  s = sheetTextOwnerRendered(s, "rope");
  assertEquals(s, { ...s, text: "rope", pending: [] });
});

Deno.test("an owner render older than the keystroke in this commit is ignored", () => {
  let s = key(sheetTextInit(""), "ab");
  s = sheetTextOwnerRendered(s, "ab"); // caught up
  // The user types "c". In the same commit the owner's earlier render (a timer
  // tick, still holding "ab") reaches the box.
  s = sheetTextTyped(s, "abc");
  s = sheetTextOwnerRendered(s, "ab");
  assertEquals(s.text, "abc");
  s = sheetTextCommitted(s);
  s = sheetTextOwnerRendered(s, "abc");
  assertEquals(s.text, "abc");
  assertEquals(s.pending, []);
});

Deno.test("a filter back to the value the owner already had is shown", () => {
  // NutritionGoalSheet keeps digits only: "12" + "a" stays "12".
  let s = key(sheetTextInit("12"), "12a");
  s = sheetTextOwnerRendered(s, "12");
  assertEquals(s.text, "12");
  assertEquals(s.pending, []);
});

Deno.test("a filter to a new value is shown", () => {
  let s = key(sheetTextInit("1"), "1x2");
  s = sheetTextOwnerRendered(s, "12");
  assertEquals(s.text, "12");
});

Deno.test("a reset to empty after typing is shown, even if empty was typed before", () => {
  let s = sheetTextInit("");
  for (const t of ["a", "", "h", "hi"]) s = key(s, t);
  s = sheetTextOwnerRendered(s, "hi"); // caught up to the end
  s = sheetTextOwnerRendered(s, ""); // sent: the owner clears the box
  assertEquals(s.text, "");
});

Deno.test("a value typed twice matches its newest echo", () => {
  let s = sheetTextInit("");
  for (const t of ["a", "", "a"]) s = key(s, t);
  s = sheetTextOwnerRendered(s, "a");
  assertEquals(s.pending, []);
  assertEquals(s.text, "a");
});

Deno.test("an owner render with no change keeps the text", () => {
  let s = key(sheetTextInit(""), "x");
  s = sheetTextOwnerRendered(s, "x");
  const before = s;
  s = sheetTextOwnerRendered(s, "x"); // a re-render for something else
  assertEquals(s, before);
});

Deno.test("a seed from the owner is shown", () => {
  let s = sheetTextInit("");
  s = sheetTextOwnerRendered(s, "Push day");
  assertEquals(s.text, "Push day");
});

Deno.test("pending stays capped", () => {
  let s = sheetTextInit("");
  let t = "";
  for (let i = 0; i < SHEET_TEXT_MAX_PENDING + 10; i++) s = key(s, t += "a");
  assertEquals(s.pending.length, SHEET_TEXT_MAX_PENDING);
});
