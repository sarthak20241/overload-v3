// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FOOD_WRITE_TOOLS, planUpdate } from "./foodWrites.ts";
import type { Tool } from "./protocol.ts";
import type { Ctx } from "./tools.ts";
import { WriteRefused } from "./writes.ts";

const U = "user_1";
const ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-10T12:00:00Z"); // 17:30 on Nov 10 in Kolkata
const tool = (n: string) => FOOD_WRITE_TOOLS.find((t) => t.name === n) as Tool;

function ctxWith(writes: Record<string, unknown> = {}, data: Record<string, unknown> = {}): Ctx {
  return {
    userId: U,
    email: null,
    tz: "Asia/Kolkata",
    now: NOW,
    profile: { daily_calorie_target: 2000 },
    data: {
      meals: () => Promise.resolve([]),
      targetHistory: () => Promise.resolve([]),
      dayTargets: () => Promise.resolve([]),
      foodEntry: () => Promise.resolve(null),
      ...data,
    } as any,
    writes: {
      logFood: () => Promise.resolve({ lines: [] }),
      updateFoodEntry: () => Promise.resolve({ before: null, after: null }),
      deleteFoodEntries: () => Promise.resolve({ deleted: [], not_deleted: [] }),
      ...writes,
    } as any,
  };
}

const egg = { name: "Boiled egg", quantity: 2, unit: "egg", grams: 100, kcal: 155, protein_g: 13, carb_g: 1, fat_g: 11 };

// ── log_food ────────────────────────────────────────────────────────────────

Deno.test("log_food: today lands now; another day lands at local noon of that day", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({ logFood: (...a: any[]) => { calls.push(a); return Promise.resolve({ lines: [] }); } });
  await tool("log_food").run({ meal: "breakfast", items: [egg] }, ctx);
  await tool("log_food").run({ meal: "dinner", date: "2026-11-08", items: [egg] }, ctx);
  assertEquals(calls[0][1], {
    meal: "breakfast", start: "2026-11-09T18:30:00.000Z", end: "2026-11-10T18:30:00.000Z", loggedAt: "2026-11-10T12:00:00.000Z",
  });
  assertEquals(calls[1][1].loggedAt, "2026-11-08T06:30:00.000Z"); // 12:00 in Kolkata
  assertEquals(calls[0][2][0], { ...egg, fiber_g: null });
});

Deno.test("log_food: macros worth far more than the calories are refused, alcohol is not", async () => {
  let wrote = 0;
  const ctx = ctxWith({ logFood: () => { wrote++; return Promise.resolve({ lines: [] }); } });
  const bad = await tool("log_food").run({ meal: "lunch", items: [{ name: "Rice", kcal: 100, protein_g: 4, carb_g: 80, fat_g: 1 }] }, ctx);
  assert(bad.isError && bad.text.includes("Rice"));
  const beer = await tool("log_food").run({ meal: "dinner", items: [{ name: "Beer", unit: "can", kcal: 150, protein_g: 1.6, carb_g: 13, fat_g: 0 }] }, ctx);
  assert(!beer.isError);
  const dense = await tool("log_food").run({ meal: "snack", items: [{ name: "Ghee", grams: 10, kcal: 120, protein_g: 0, carb_g: 0, fat_g: 13 }] }, ctx);
  assert(dense.isError, "1200 kcal per 100 g is more than fat");
  assertEquals(wrote, 1);
});

Deno.test("log_food: missing numbers, a bad meal, too far ahead, a bad request id: refused, nothing written", async () => {
  let wrote = 0;
  const ctx = ctxWith({ logFood: () => { wrote++; return Promise.resolve({ lines: [] }); } });
  const cases = [
    { meal: "lunch", items: [{ name: "Rice", kcal: 200 }] },
    { meal: "brunch", items: [egg] },
    { meal: "lunch", date: "2026-12-11", items: [egg] },
    { meal: "lunch", items: [egg], request_id: "has spaces" },
    { meal: "lunch", items: [] },
    { meal: "lunch", items: [{ ...egg, quantity: 0 }] },
  ];
  for (const c of cases) assert((await tool("log_food").run(c, ctx)).isError, JSON.stringify(c));
  assertEquals(wrote, 0);
});

Deno.test("log_food: a replayed request says so; the day's totals come back", async () => {
  const ctx = ctxWith(
    { logFood: () => Promise.resolve({ replayed: true, lines: [{ id: ID, name: "Boiled egg", quantity: 2, unit: "egg", kcal: 155 }] }) },
    { meals: () => Promise.resolve([{ meal_type: "breakfast", meal_entries: [{ id: ID, food_name: "Boiled egg", quantity: 2, kcal: 155, protein_g: 13, carb_g: 1, fat_g: 11, logged_via: "mcp" }] }]) },
  );
  const r = await tool("log_food").run({ meal: "breakfast", items: [egg], request_id: "r-1" }, ctx);
  const j = JSON.parse(r.text);
  assert(j.note.includes("already logged"));
  assertEquals(j.day.totals.kcal, 155);
  assertEquals(j.day.left.kcal, 1845);
  assertEquals(j.day.meals[0].lines[0].logged_by_assistant, true);
});

Deno.test("a refusal from the database reaches the assistant as a tool error", async () => {
  const ctx = ctxWith({ logFood: () => Promise.reject(new WriteRefused("Overload refused a value: x")) });
  const r = await tool("log_food").run({ meal: "lunch", items: [egg] }, ctx);
  assertEquals(r, { text: "Overload refused a value: x", isError: true });
});

// ── update_food_entry ───────────────────────────────────────────────────────

const rice = { food_name: "Rice", quantity: 150, serving_unit: "g", grams_logged: 150, kcal: 195, protein_g: 4, carb_g: 42, fat_g: 0.4, fiber_g: 0.6, origin: "catalog" };

Deno.test("planUpdate: a new amount scales every number and keeps the grade", () => {
  const r = planUpdate(rice, { grams: 300 }) as any;
  assertEquals(r.set, { quantity: 300, grams: 300, kcal: 390, protein_g: 8, carb_g: 84, fat_g: 0.8, fiber_g: 1.2 });
  const byQty = planUpdate({ ...rice, quantity: 1, serving_unit: "bowl" }, { quantity: 2 }) as any;
  assertEquals([byQty.set.kcal, byQty.set.grams], [390, 300]);
});

Deno.test("planUpdate: kcal alone scales the macros; given numbers are a guess", () => {
  const r = planUpdate(rice, { kcal: 390 }) as any;
  assertEquals([r.set.kcal, r.set.protein_g, r.set.carb_g, r.set.origin, r.set.source], [390, 8, 84, "guess", "estimate"]);
  const p = planUpdate(rice, { protein_g: 5 }) as any;
  assertEquals([p.set.kcal, p.set.protein_g, p.set.carb_g], [195, 5, 42]);
});

Deno.test("planUpdate: a new unit with no grams or numbers is refused; a name alone changes only the name", () => {
  const noGrams = { ...rice, grams_logged: null, serving_unit: "bowl", quantity: 1 };
  assert((planUpdate(noGrams, { unit: "cup" }) as any).isError);
  assertEquals((planUpdate(rice, { name: "Basmati rice" }) as any).set, { name: "Basmati rice" });
  assert((planUpdate(rice, { kcal: 10, carb_g: 42 }) as any).isError, "42 g carbs is not 10 kcal");
  assert((planUpdate(rice, { fiber_g: 1e9 }) as any).isError, "fiber has the same 300 g cap as log_food");
  assert((planUpdate({ ...rice, fiber_g: 250 }, { grams: 300 }) as any).isError, "scaling may not push fiber past 300 g");
});

Deno.test("update_food_entry: a move to another meal sends the place; nothing to change is refused", async () => {
  const calls: any[] = [];
  const ctx = ctxWith(
    { updateFoodEntry: (...a: any[]) => { calls.push(a); return Promise.resolve({ before: {}, after: {} }); } },
    { foodEntry: () => Promise.resolve({ ...rice, id: ID, meals: { meal_type: "lunch", logged_at: "2026-11-10T07:00:00Z" } }) },
  );
  assert((await tool("update_food_entry").run({ entry_id: ID }, ctx)).isError);
  assert((await tool("update_food_entry").run({ entry_id: ID, meal: "lunch" }, ctx)).isError, "same meal, same day");
  await tool("update_food_entry").run({ entry_id: ID, meal: "dinner" }, ctx);
  assertEquals(calls[0][2], {});
  assertEquals(calls[0][3].meal, "dinner");
  assertEquals(calls[0][3].start, "2026-11-09T18:30:00.000Z");
});

Deno.test("update_food_entry: another user's line (not found) is refused before any write", async () => {
  let wrote = 0;
  const ctx = ctxWith({ updateFoodEntry: () => { wrote++; return Promise.resolve({}); } });
  const r = await tool("update_food_entry").run({ entry_id: ID, kcal: 100 }, ctx);
  assert(r.isError);
  assertEquals(wrote, 0);
});

// ── delete_food_entries ─────────────────────────────────────────────────────

Deno.test("delete_food_entries: ids checked, sent once each, app lines reported back", async () => {
  const calls: any[] = [];
  const ctx = ctxWith({
    deleteFoodEntries: (...a: any[]) => {
      calls.push(a);
      return Promise.resolve({ deleted: [{ id: ID, name: "Egg", kcal: 155, meal: "breakfast", logged_at: "2026-11-10T03:00:00Z" }], not_deleted: ["x"] });
    },
  });
  assert((await tool("delete_food_entries").run({ entry_ids: ["nope"] }, ctx)).isError);
  const r = await tool("delete_food_entries").run({ entry_ids: [ID, ID] }, ctx);
  assertEquals(calls[0][1], [ID]);
  const j = JSON.parse(r.text);
  assertEquals(j.deleted[0].name, "Egg");
  assert(j.note.includes("logged in the app"));
});

Deno.test("write tools say they write", () => {
  for (const t of FOOD_WRITE_TOOLS) assertEquals(t.annotations?.readOnlyHint, false, t.name);
  assertEquals(FOOD_WRITE_TOOLS.filter((t) => t.free).length, 0);
});
