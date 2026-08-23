// Run with: deno test supabase/functions/ai-coach/textMatch.test.ts
//
// The I17 benchmark corpus, frozen as tests. Every pair here came from a real
// mis-match or a real typo seen in logs, and each one is a regression the old
// 4-char-prefix rule either caused or missed. A future tweak to MAX_TYPO_RATIO
// has to keep all of them green.

import { assertEquals } from "jsr:@std/assert@1";
import { damerau, nearWord } from "./textMatch.ts";

Deno.test("damerau counts a transposition as one edit", () => {
  // The whole reason for Damerau over plain Levenshtein: this is one swap.
  assertEquals(damerau("panner", "paneer"), 1);
  assertEquals(damerau("edamame", "edamame"), 0);
  assertEquals(damerau("", "abc"), 3);
});

Deno.test("damerau stops once the budget is blown", () => {
  // Bounded: the exact value past the budget does not matter, only that it is
  // over. A wildly different word must not cost a full matrix walk.
  const d = damerau("paneer", "chocolatechipcookie", 2);
  assertEquals(d > 2, true);
});

Deno.test("MATCHES: real typos of the same food", () => {
  assertEquals(nearWord("panner", "paneer"), true, "commonest Indian food typo");
  assertEquals(nearWord("edameme", "edamame"), true, "the case the old rule existed for");
  assertEquals(nearWord("optimumnutriton", "optimumnutrition"), true, "long brand, dropped letter");
  assertEquals(nearWord("chiken", "chicken"), true);
  assertEquals(nearWord("eggs", "egg"), true, "plural is the same food");
});

Deno.test("REJECTS: different foods that merely look alike", () => {
  // Both of these were FALSE POSITIVES under the 4-char-prefix rule.
  assertEquals(nearWord("bikano", "bikaji"), false, "rival snack brands, both named for Bikaner");
  assertEquals(nearWord("creatine", "creatinine"), false, "supplement vs metabolic waste");
  assertEquals(nearWord("dal", "dalia"), false, "short words must match outright");
  assertEquals(nearWord("egg", "eggplant"), false);
  assertEquals(nearWord("milk", "milkshake"), false);
});

Deno.test("short words never get typo slack", () => {
  // A 20% budget on a 4-letter word rounds to 0 edits, and that is deliberate:
  // at that length the near-misses are real, different foods.
  assertEquals(nearWord("ghee", "ghe"), false);
  assertEquals(nearWord("rice", "ric"), false);
  assertEquals(nearWord("oats", "oat"), true, "plural, not a typo");
});

Deno.test("the slack scales with word length", () => {
  // Same single edit, opposite verdicts by length - the point of proportional.
  assertEquals(nearWord("bhakarwadi", "bhakarwadii"), true);
  assertEquals(nearWord("soya", "soyi"), false);
});
