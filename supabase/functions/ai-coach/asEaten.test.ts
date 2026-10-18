// The web judges see the food as it was eaten, and the Precise cache keeps a
// cooked serving apart from the dry product (live, 2026-10-18: a cooked katori
// of dal was logged from a raw-dal panel, and that panel was cached under the
// bare name for every later cooked katori).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { eatenLabel, itemCacheKey } from "./parseMeal.ts";
import { pieceQuestions, relevanceQuestions, searchQueries } from "./tavilyLookup.ts";

Deno.test("the line as eaten carries amount, unit and preparation", () => {
  assertEquals(
    eatenLabel({ name: "Arhar dal", quantity: 1, unit: "katori", prep: "cooked" }),
    "1 katori cooked Arhar dal",
  );
  // A preparation already in the name is not said twice.
  assertEquals(eatenLabel({ name: "boiled chana", quantity: 100, unit: "g", prep: "boiled" }), "100 g boiled chana");
  assertEquals(eatenLabel({ name: "ramen", quantity: 3, unit: "fork", prep: null }), "3 fork ramen");
});

Deno.test("a cooked serving and the dry product are different cache rows", () => {
  const cooked = itemCacheKey({ name: "Arhar dal", brand: null, prep: "cooked" });
  const plain = itemCacheKey({ name: "Arhar dal", brand: null, prep: null });
  assert(cooked !== plain, `${cooked} should differ from ${plain}`);
  assertEquals(cooked, itemCacheKey({ name: "cooked arhar dal", brand: null, prep: "cooked" }));
});

Deno.test("the search names the preparation", () => {
  const qs = searchQueries({ name: "Arhar dal", brand: null, prep: "cooked" });
  assert(qs.every((q) => q.toLowerCase().startsWith("cooked arhar dal")), qs.join(" | "));
  // No preparation: the queries are as before.
  assert(searchQueries({ name: "Arhar dal", brand: null }).every((q) => q.startsWith("Arhar dal")));
});

Deno.test("Jev judges pages against the food as eaten, and only when it is known", () => {
  const eaten = { name: "Arhar dal", brand: null, eaten: "1 katori cooked Arhar dal" };
  const withIt = String(relevanceQuestions(eaten, ["r1"]).r1.instructions);
  assert(/as_eaten/.test(withIt) && /dry or raw/.test(withIt), withIt);
  const without = String(relevanceQuestions({ name: "Arhar dal", brand: null }, ["r1"]).r1.instructions);
  assert(!/as_eaten/.test(without), without);

  const piece = String(pieceQuestions(["r1"], [2], eaten.eaten).r1_piece.instructions);
  assert(/as_eaten/.test(piece) && /numbers as well as the words/.test(piece), piece);
  assert(!/as_eaten/.test(String(pieceQuestions(["r1"], [2]).r1_piece.instructions)));
});
