import { assertEquals } from "jsr:@std/assert@1";
import {
  asCopy,
  dishName,
  mayReplace,
  originOf,
  parseRecipe,
  recipePer100,
  statedPartGrams,
  withPartGrams,
  ORIGIN_RANK,
} from "./foodOrigin.ts";

Deno.test("originOf: a line's own origin wins", () => {
  assertEquals(originOf({ origin: "label", source: "manual" }), "label");
});

Deno.test("originOf: old 'manual' alone is never user_typed", () => {
  assertEquals(originOf({ source: "manual" }), "unknown");
  assertEquals(originOf({ source: "manual", assumption: "Same as you logged on Oct 30" }), "unknown");
});

Deno.test("originOf: the server's 'Your numbers' note proves user_typed", () => {
  assertEquals(originOf({ source: "manual", assumption: "Your numbers: 150 kcal" }), "user_typed");
});

Deno.test("originOf: old sources map to clear ones", () => {
  assertEquals(originOf({ source: "catalog" }), "catalog");
  assertEquals(originOf({ source: "web" }), "label");
  assertEquals(originOf({ source: "off" }), "label");
  assertEquals(originOf({ source: "fatsecret" }), "label");
  assertEquals(originOf({ source: "estimate" }), "guess");
  assertEquals(originOf({ source: null, food_id: "f1" }), "catalog");
  assertEquals(originOf({ source: null }), "unknown");
});

Deno.test("asCopy keeps the origin and says where from", () => {
  const c = asCopy({ source: "estimate", food_name: "Soyabean sabji" }, "diary");
  assertEquals([c.origin, c.copied_from], ["guess", "diary"]);
  const typed = asCopy({ origin: "user_typed", source: "manual" }, "card");
  assertEquals(typed.origin, "user_typed");
});

Deno.test("mayReplace: a guess never replaces user_typed or label; equal ranks replace", () => {
  assertEquals(mayReplace("user_typed", "guess"), false);
  assertEquals(mayReplace("label", "guess"), false);
  assertEquals(mayReplace("label", "unknown"), false);
  assertEquals(mayReplace("guess", "label"), true);
  assertEquals(mayReplace("unknown", "guess"), true);
  assertEquals(mayReplace("catalog", "user_typed"), true);
  assertEquals(mayReplace("unknown", "catalog"), true);
});

const SABJI = [
  { name: "Milky Mist low fat paneer", grams: 65, per100: { kcal: 180, protein_g: 25, carb_g: 5, fat_g: 6.5 } },
  { name: "onion", grams: 40, per100: { kcal: 40, protein_g: 1.1, carb_g: 9.3, fat_g: 0.1 } },
  { name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 } },
];

Deno.test("parseRecipe: keeps good parts, rejects bad shapes", () => {
  assertEquals(parseRecipe(SABJI)?.length, 3);
  assertEquals(parseRecipe([{ name: "oil" }]), null);
  assertEquals(parseRecipe([{ name: "", grams: 5 }]), null);
  assertEquals(parseRecipe("paneer"), null);
  assertEquals(parseRecipe([{ name: "oil", grams: 5, per100: { kcal: 2000, protein_g: 0, carb_g: 0, fat_g: 0 } }])?.[0].per100, null);
});

Deno.test("statedPartGrams: '60 g paneer' finds the paneer part", () => {
  assertEquals(statedPartGrams(SABJI, "milky mist paneer sabji made of 60g paneer, onion and oil"), { part: 0, grams: 60 });
  assertEquals(statedPartGrams(SABJI, "paneer sabji with paneer 80 g"), { part: 0, grams: 80 });
  // No part weight given: no answer.
  assertEquals(statedPartGrams(SABJI, "200 g paneer sabji"), null);
  assertEquals(statedPartGrams(SABJI, "my usual paneer sabji"), null);
});

Deno.test("withPartGrams scales the part, not the dish", () => {
  const { recipe, grams } = withPartGrams(SABJI, 0, 60);
  assertEquals(grams, 105);
  assertEquals(recipe[1].grams, 40);
  assertEquals(recipe[2].grams, 5);
  // Whole-dish scaling would have given 60/110 of every part.
  const per = recipePer100(recipe)!;
  const kcal = Math.round(per.kcal * grams / 100);
  assertEquals(kcal, Math.round(0.6 * 180 + 0.4 * 40 + 0.05 * 884));
});

Deno.test("dishName strips a recipe from the name, keeps other brackets", () => {
  assertEquals(dishName("Milky Mist low fat paneer sabji (20 g paneer, onion, oil)"), "Milky Mist low fat paneer sabji");
  assertEquals(dishName("Milky Mist low fat paneer sabji (65 g paneer, onion, tomato, little oil)"), "Milky Mist low fat paneer sabji");
  assertEquals(dishName("Milky Mist Paneer Sabji (paneer, onion, oil)"), "Milky Mist Paneer Sabji");
  assertEquals(dishName("Masoor dal (cooked)"), "Masoor dal (cooked)");
  assertEquals(dishName("Paneer momos (jhol, estimated)"), "Paneer momos (jhol, estimated)");
  assertEquals(dishName("Peri peri fries (10 pieces, estimated)"), "Peri peri fries (10 pieces, estimated)");
  assertEquals(dishName("Fats and carbs (unspecified, 200 kcal)"), "Fats and carbs (unspecified, 200 kcal)");
});

Deno.test("step 5's recipe lines: source 'recipe' reads as recipe; an assumed part stays assumed", () => {
  assertEquals(originOf({ source: "recipe" }), "recipe");
  assertEquals(parseRecipe([{ name: "oil", grams: 5, assumed: true }])?.[0].assumed, true);
});

Deno.test("the SQL mirrors keep the same ranks (migration 20261107120000 origin_rank)", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/20261107120000_food_memory_sources.sql", import.meta.url));
  const body = sql.slice(sql.indexOf("function food_memory_private.origin_rank"), sql.indexOf("function food_memory_private.legacy_origin"));
  for (const o of ["user_typed", "label", "catalog", "recipe"] as const) {
    assertEquals(body.includes(`'${o}' then ${ORIGIN_RANK[o]}`), true, o);
  }
  assertEquals(body.includes("else 1"), true);
  assertEquals(ORIGIN_RANK.guess, 1);
  assertEquals(ORIGIN_RANK.unknown, 1);
});
