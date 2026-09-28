// Run with: deno test --allow-all supabase/functions/ai-coach/statedNumbers.test.ts
//
// Numbers the user wrote themselves win over every source (owner decision
// 2026-09-28). The case that drove it: "62 g raw, skinless chicken breast.
// Per 100 g: 130 kcal, 22.5 g protein" logged 114.7 in Precise (web) and 106 in
// Thorough (USDA); only Quick kept her 130.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { readStated, statedPer100 } from "./statedNumbers.ts";
import { type ParseMealDeps, runParseMeal, statedFor } from "./parseMeal.ts";

// ── Reading and per-100 ─────────────────────────────────────────────────────

Deno.test("a per-100 g panel is kept as written", () => {
  const s = statedPer100(readStated({ basis: "per_100g", kcal: 130, protein_g: 22.5, carb_g: 0, fat_g: 4.2 })!, null)!;
  assertEquals([s.kcal, s.protein_g, s.carb_g, s.fat_g, s.complete], [130, 22.5, 0, 4.2, true]);
  assertEquals(s.label, "130 kcal per 100 g");
});

Deno.test("a per-serving panel converts in code from the printed weight", () => {
  const s = statedPer100(readStated({ basis: "per_serving", serving_g: 30, kcal: 120, protein_g: 24, carb_g: 3, fat_g: 1.5 })!, null)!;
  assertEquals([s.kcal, s.protein_g, s.serving_g], [400, 80, 30]);
});

Deno.test("a per-serving panel with no weight is not guessed", () => {
  assertEquals(statedPer100(readStated({ basis: "per_serving", kcal: 120 })!, null), null);
});

Deno.test("only kcal and protein given: a partial panel, the rest left null", () => {
  const s = statedPer100(readStated({ basis: "per_100g", kcal: 130, protein_g: 22.5 })!, null)!;
  assertEquals([s.carb_g, s.fat_g, s.complete], [null, null, false]);
});

Deno.test("no kcal, no stated numbers", () => {
  assertEquals(readStated({ basis: "per_100g", protein_g: 22.5 }), null);
  assertEquals(readStated(null), null);
});

Deno.test("a per-pack number taken as per 100 g is refused, not logged", () => {
  assertEquals(statedPer100(readStated({ basis: "per_100g", kcal: 1800 })!, null), null);
  // The parser's own ceiling, not a looser one: 930 is past pure fat.
  assertEquals(statedPer100(readStated({ basis: "per_100g", kcal: 930 })!, null), null);
});

Deno.test("a line total converts against a typed weight", () => {
  const s = statedPer100(readStated({ basis: "total", kcal: 200, protein_g: 20, carb_g: 20, fat_g: 4 })!, 50)!;
  assertEquals([s.kcal, s.label], [400, "200 kcal for 50 g"]);
});

// ── End to end ──────────────────────────────────────────────────────────────

const FULL = { basis: "per_100g", kcal: 130, protein_g: 22.5, carb_g: 0, fat_g: 4.2 };
const LINE = { name: "raw skinless chicken breast", brand: null, quantity: 62, unit: "g", prep: null };
const EST = {
  label_applies: false, label_serving_g: null, label_serving_kcal: null, label_pieces_per_serving: null,
  est_kcal: 80, est_protein_g: 14, est_carb_g: 0, est_fat_g: 2.6, est_total_g: 62,
};
const BASE = { localHour: 20, mealHint: null, recentFoods: [], todayTotals: null, targets: null };

function deps(line: Record<string, unknown>, calls: string[], lookups: string[], catalogRow = true): ParseMealDeps {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.includes("typesafe.ai")) {
      calls.push("jev");
      const answers: Record<string, unknown> = {};
      for (const k of Object.keys(body.questions ?? {})) answers[k] = { type: "score", probabilities: { "2": 0.99 } };
      return Response.json({ model: "x", answers, usage: {} });
    }
    const name: string = (body.tools ?? [])[0]?.name ?? "";
    calls.push(name);
    if (name === "estimate_meal" || name === "extract_meal") {
      return Response.json({
        stop_reason: "tool_use", usage: {},
        content: [{ type: "tool_use", name, input: { declined: false, meal_type_from_text: "dinner", items: [line] } }],
      });
    }
    if (name === "report_sources" || name === "report_page_panels") {
      return Response.json({ stop_reason: "tool_use", usage: {}, content: [{ type: "tool_use", name, input: { results: [], pages: [] } }] });
    }
    // decide: pick the first candidate id shown.
    const text = JSON.stringify(body.messages ?? []);
    const id = /"food_id\\?":\\?"([^"\\]+)/.exec(text)?.[1] ?? null;
    return Response.json({
      stop_reason: "tool_use", usage: {},
      content: [{ type: "tool_use", name, input: {
        meal_type: "dinner", drona_line: "ok",
        items: [{ food_name: "raw skinless chicken breast", food_id: id, quantity: 62, serving_label: "g", grams: 62, kcal: 1, protein_g: 1, carb_g: 0, fat_g: 0, source: id ? "catalog" : "estimate", confidence: "high", assumption: null }],
      } }],
    });
  }) as typeof fetch;
  return {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async (q) => {
      lookups.push(`search:${q}`);
      return catalogRow
        ? [{ food_id: "usda-1", name: "Chicken, breast, raw", brand: null, base_unit: "g", kcal: 106, protein_g: 20, carb_g: 0, fat_g: 1.9, fiber_g: null, servings: [], source: "catalog" }]
        : [];
    },
    backfillOffFood: async () => null,
    getFoodPer100: async (id) => { lookups.push(`per100:${id}`); return null; },
    preciseCacheGet: async (k) => { lookups.push(`precise:${k}`); return null; },
    jev: { apiKey: "jev", timeoutMs: 1000, fetchFn },
    userMemory: {
      load: () => Promise.resolve({
        entries: [{
          food_name: "raw skinless chicken breast", food_id: null, kcal: 71, protein_g: 13.9, carb_g: 0, fat_g: 1.5, fiber_g: null,
          grams: 62, quantity: 62, serving_unit: "g", source: "catalog", logged_via: "ai", tier: "precise",
          logged_at: new Date(Date.now() - 86_400_000).toISOString(),
        }],
        timeZone: null,
      }),
    },
    fetchFn,
  };
}

const TEXT = "62 g raw, skinless chicken breast for dinner. Per 100 g: 130 kcal, 22.5 g protein, 0 carbs, 4.2 g fat";

Deno.test("the failure this prevents: Precise replaces the user's label with a lookup", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(deps({ ...LINE, stated: FULL }, calls, lookups), { ...BASE, text: TEXT, mode: "super" });
  const it = r.parsed!.items[0];
  assertEquals(Math.round(it.kcal), 81); // 62 g x 130/100
  assertEquals(it.source, "manual");
  assertEquals(it.assumption, "Your numbers: 130 kcal per 100 g");
  assertEquals(lookups, []);
  assert(!calls.includes("jev"), "the memory is not asked about a line with the user's numbers");
});

Deno.test("Thorough keeps the user's full panel with no lookup", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(deps({ ...LINE, stated: FULL }, calls, lookups), { ...BASE, text: TEXT, mode: null });
  assertEquals(Math.round(r.parsed!.items[0].kcal), 81);
  assertEquals(lookups, []);
});

Deno.test("a partial panel keeps the user's numbers and fills only the rest", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps({ ...LINE, stated: { basis: "per_100g", kcal: 130, protein_g: 22.5 } }, calls, lookups),
    { ...BASE, text: "62 g raw chicken breast, 130 kcal and 22.5 g protein per 100 g", mode: null },
  );
  const it = r.parsed!.items[0];
  assertEquals(Math.round(it.kcal), 81);
  assertEquals(it.protein_g, 14); // 22.5 x 0.62, hers
  assertEquals(it.fat_g, 1.2); // 1.9 x 0.62, from the catalog row
  assertEquals(it.assumption, "Your numbers: 130 kcal per 100 g, the rest looked up");
  assert(lookups.some((l) => l.startsWith("search:")));
});

Deno.test("Quick uses the user's numbers over its own estimate and over the memory", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(deps({ ...LINE, ...EST, stated: FULL }, calls, lookups), { ...BASE, text: TEXT, mode: "fast" });
  const it = r.parsed!.items[0];
  assertEquals(Math.round(it.kcal), 81);
  assertEquals(it.source, "manual");
  assert(!calls.includes("jev"));
});

Deno.test("with no numbers written, the line runs exactly as before", async () => {
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(deps({ ...LINE, ...EST }, calls, lookups), { ...BASE, text: "62 g raw skinless chicken breast", mode: "fast" });
  // Memory answers (the remembered Precise line), not a stated panel.
  assertEquals(r.parsed!.items[0].source, "catalog");
  assert(calls.includes("jev"));
});

Deno.test("a partial panel with nothing to fill from never invents zeros under the user's name", async () => {
  // Only kcal and protein written, and the lookup found no row: claiming "your
  // numbers" with 0 g carbs and fat would be a number nobody gave.
  const calls: string[] = [], lookups: string[] = [];
  const r = await runParseMeal(
    deps({ ...LINE, stated: { basis: "per_100g", kcal: 130, protein_g: 22.5 } }, calls, lookups, false),
    { ...BASE, text: "62 g raw chicken breast, 130 kcal and 22.5 g protein per 100 g", mode: null },
  );
  assert(r.parsed!.items[0].source !== "manual");
});

Deno.test("a line total with no typed weight is not turned into 'your numbers' on a guessed weight", () => {
  // Reviewer on #223: "1 bar, 200 kcal" would have been divided by the model's
  // own gram guess and labelled as the user's.
  assertEquals(statedFor({ name: "protein bar", brand: null, quantity: 1, unit: "bar", prep: null, stated: readStated({ basis: "total", kcal: 200 }), est: { kcal: 200, protein_g: 20, carb_g: 20, fat_g: 7, total_g: 60 } } as never), null);
});
