// deno test --allow-all scripts/voice-eval/score.test.ts
import { assert, assertAlmostEquals, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { costUsd, isLatin, scoreClip, termRecall, wer } from "./score.ts";

Deno.test("wer: perfect, one swap, case and punctuation ignored", () => {
  assertEquals(wer("do roti aur dal", "Do roti, aur dal."), 0);
  assertEquals(wer("do roti aur dal", "do roti aur daal"), 0.25);
  assertEquals(wer("two roti", ""), 1);
  assertEquals(wer("", ""), 0);
});

Deno.test("term recall: whole words, multi-word terms", () => {
  assertEquals(termRecall(["paneer", "dal makhani"], "200 g paneer and dal makhani"), 1);
  assertEquals(termRecall(["paneer", "dal makhani"], "200 g panir and dal makani"), 0);
  assertEquals(termRecall(["dal"], "dalia"), 0);
  assertEquals(termRecall([], "anything"), 1);
});

Deno.test("latin: Devanagari in the output is flagged", () => {
  assert(isLatin("do roti aur dal"));
  assertFalse(isLatin("दो रोटी aur dal"));
  assertEquals(scoreClip("do roti", ["roti"], "दो रोटी").latin, false);
});

Deno.test("cost: by the minute", () => {
  assertAlmostEquals(costUsd(600, 0.0045), 0.045, 1e-9);
});
