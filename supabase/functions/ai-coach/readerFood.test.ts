// Run with: deno test --allow-all supabase/functions/ai-coach/readerFood.test.ts
//
// The page reader read "brand": null as "a food with no brand" and turned down
// every branded label for it (atta bread, 2026-11-08). With no brand named,
// the reader gets no brand key; Jev's input keeps its old shape.

import { assertEquals } from "jsr:@std/assert@1";
import { readerFoodState } from "./tavilyLookup.ts";

Deno.test("the reader gets no brand key when the user named none", () => {
  assertEquals(readerFoodState({ name: "atta bread", brand: null }), { name: "atta bread" });
  assertEquals(readerFoodState({ name: "atta bread", brand: "" } as never), { name: "atta bread" });
});

Deno.test("a brand the user named reaches the reader", () => {
  assertEquals(readerFoodState({ name: "protein bread", brand: "Health Factory" }), { name: "protein bread", brand: "Health Factory" });
});

Deno.test("how it was eaten still reaches the reader", () => {
  assertEquals(readerFoodState({ name: "rice", brand: null, eaten: "cooked" }), { name: "rice", as_eaten: "cooked" });
});
