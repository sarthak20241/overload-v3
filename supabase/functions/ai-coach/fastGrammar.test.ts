// Run with: deno test supabase/functions/ai-coach/fastGrammar.test.ts
//
// Every REJECT case below is something the first version of this grammar
// happily accepted, measured against 107 real production inputs. Lane A has no
// model anywhere in its path, so a mis-parse logs a wrong food with nothing to
// catch it. These are the cases that make refusing worth more than covering.

import { assertEquals } from "jsr:@std/assert@1";
import { parseFastGrammar } from "./fastGrammar.ts";

const one = (t: string) => {
  const g = parseFastGrammar(t);
  assertEquals(g?.length, 1, `expected 1 item from "${t}"`);
  return g![0];
};

Deno.test("amount before the name", () => {
  assertEquals(one("100g paneer"), { name: "paneer", quantity: 100, unit: "g", prep: null });
  assertEquals(one("250ml toned milk"), { name: "toned milk", quantity: 250, unit: "ml", prep: null });
  assertEquals(one("1 katori dal"), { name: "dal", quantity: 1, unit: "katori", prep: null });
});

Deno.test("name before the amount, which real logs do constantly", () => {
  // The first version read this as ONE SERVING of a food called "paneer 100g".
  assertEquals(one("Paneer 100g"), { name: "paneer", quantity: 100, unit: "g", prep: null });
  assertEquals(one("Curd 1 katori"), { name: "curd", quantity: 1, unit: "katori", prep: null });
});

Deno.test("counted nouns and articles", () => {
  assertEquals(one("2 eggs").quantity, 2);
  assertEquals(one("a samosa"), { name: "samosa", quantity: 1, unit: "serving", prep: null });
  assertEquals(one("a bowl of dal"), { name: "dal", quantity: 1, unit: "bowl", prep: null });
  assertEquals(one("chole salad").name, "chole salad");
});

Deno.test("prep words survive into the name's query", () => {
  const g = one("2 boiled eggs");
  assertEquals(g.prep, "boiled");
  assertEquals(g.name, "eggs");
});

Deno.test("splits on connectives without leaking them", () => {
  // "Ram papad, and bhel puri" produced a food called "and bhel puri".
  const g = parseFastGrammar("Ram papad, and bhel puri")!;
  assertEquals(g.map((i) => i.name), ["ram papad", "bhel puri"]);
  assertEquals(parseFastGrammar("100g paneer and 50g tofu")!.length, 2);
});

Deno.test("REFUSES a metrics log", () => {
  // Read "water", "sleep" and "weight" as three foods.
  assertEquals(parseFastGrammar("Water: 2500 ml, Sleep: 600 min, Weight: 70.45 kg"), null);
});

Deno.test("REFUSES a trailing clause rather than eating it", () => {
  // Became a food called "peanuts for snacks".
  assertEquals(parseFastGrammar("8gm peanuts for snacks"), null);
  assertEquals(parseFastGrammar("a samosa from haldiram"), null);
});

Deno.test("REFUSES spelled-out numbers", () => {
  // Became a food called "two rotis".
  assertEquals(parseFastGrammar("Two rotis and dal"), null);
});

Deno.test("REFUSES an unparsed unit left in the name", () => {
  // "tblspn" is a unit the grammar cannot read, so the amount was missed.
  assertEquals(parseFastGrammar("2 tblspn roasted edameme"), null);
  assertEquals(parseFastGrammar("60 cals veggies"), null);
  assertEquals(parseFastGrammar("Tea half cup"), null);
});

Deno.test("REFUSES corrections, removals and questions", () => {
  for (const t of ["Make the roti 3", "Remove the tofu", "Actually i had a small one",
                   "is that right?", "Yes please", "i ate 2 roties and chole i katori"]) {
    assertEquals(parseFastGrammar(t), null, `should refuse: ${t}`);
  }
});

Deno.test("REFUSES a whole-day dump", () => {
  assertEquals(parseFastGrammar("Breakfast: eggs\nLunch: dal chawal"), null);
});
