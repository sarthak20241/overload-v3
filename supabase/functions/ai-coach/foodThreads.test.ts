// Run with: deno test --allow-all supabase/functions/ai-coach/foodThreads.test.ts
//
// The thread store's rules, against the in-memory store that keeps the same
// one-conditional-write rule as food_card_write (migration 20261106120000):
//   - a line keeps its id across versions; a removal never renumbers the rest
//   - a write on a stale base, or a retry of the same message, writes nothing
//   - a save card is a second card beside the meal card, never a replacement
//   - the index line names what exists, not what is in it

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cardAsLines,
  memoryThreadStore,
  readThreadRequest,
  recordThreadMessage,
  threadForAgent,
  threadIndexLine,
  threadIsOpen,
  THREAD_IDLE_MS,
  withLineIds,
} from "./foodThreads.ts";
import type { CardLine } from "./foodContext.ts";
import type { ParsedItem } from "./parseMeal.ts";

const T = "11111111-1111-4111-8111-111111111111";
const MEAL = "22222222-2222-4222-8222-222222222222";
const SAVE = "33333333-3333-4333-8333-333333333333";

const card = (n: [string, number][]): CardLine[] =>
  n.map(([food_name, kcal]) => ({ food_name, kcal, quantity: 1, serving_label: "serving", grams: 100, protein_g: 5, carb_g: 10, fat_g: 2, meal_type: "lunch" }));
const item = (food_name: string, kcal: number): ParsedItem => ({
  food_id: null, food_name, quantity: 1, serving_label: "serving", grams: 100, kcal, protein_g: 5, carb_g: 10, fat_g: 2,
  fiber_g: null, source: "catalog", assumption: null, confidence: "medium", meal_type: "lunch",
});
const LUNCH = card([["Jeera Rice", 171], ["Paneer sabji", 150], ["Soya curry", 18], ["Methi aloo", 20]]);

Deno.test("line ids: an edit keeps the id, a removal renumbers nothing, a new line gets a new id", () => {
  const v1 = cardAsLines(LUNCH);
  assertEquals(v1.map((l) => l.line_id), ["L1", "L2", "L3", "L4"]);
  const v2 = withLineIds(v1, [{ name: "Jeera Rice" }, { name: "Soya curry" }, { name: "Methi aloo" }]);
  assertEquals(v2.map((l) => l.line_id), ["L1", "L3", "L4"]);
  const v3 = withLineIds(v2.map((l) => ({ ...l, kcal: 1, grams: 1, quantity: 1, unit: null, protein_g: null, carb_g: null, fat_g: null })), [{ name: "Jeera rice (cooked)" }, { name: "Dal" }]);
  assertEquals(v3.map((l) => l.line_id), ["L1", "L5"]);
});

Deno.test("readThreadRequest: ids must be uuids; a base needs a card", () => {
  assertEquals(readThreadRequest({ id: "nope" }), null);
  assertEquals(readThreadRequest(null), null);
  const r = readThreadRequest({ id: T, card_id: MEAL, base_version: 3, next_card_id: SAVE });
  assertEquals([r?.card_id, r?.base_version, r?.next_card_id], [MEAL, 3, SAVE]);
  assertEquals(readThreadRequest({ id: T, base_version: 3 })?.base_version, null);
});

Deno.test("threads close after 30 idle minutes", () => {
  const now = Date.parse("2026-11-05T15:00:00Z");
  assert(threadIsOpen({ status: "open", last_at: new Date(now - THREAD_IDLE_MS + 1000).toISOString() }, now));
  assert(!threadIsOpen({ status: "open", last_at: new Date(now - THREAD_IDLE_MS - 1000).toISOString() }, now));
  assert(!threadIsOpen({ status: "closed", last_at: new Date(now).toISOString() }, now));
});

Deno.test("Nov 5: a save card is a second card; the lunch card and its versions stay", async () => {
  const s = memoryThreadStore();
  // First message: lunch logged, the app made the card id.
  await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1",
    userText: "lunch: rice, paneer sabji, soya, methi", dronaText: "Good lunch.", card: [],
    served: { kind: "meal", items: LUNCH.map((l) => item(l.food_name, l.kcal)), corrects: false }, mealType: "lunch",
  });
  // A correction: the sabji is 150 (v1 -> v2).
  const w = await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: MEAL, base_version: 1, next_card_id: SAVE, closed: null }, clientId: "m2",
    userText: "the sabji is 150", dronaText: "Changed.", card: LUNCH,
    served: { kind: "meal", items: [item("Jeera Rice", 171), item("Paneer sabji", 150), item("Soya curry", 18), item("Methi aloo", 20)], corrects: true }, mealType: "lunch",
  });
  assertEquals(w.card_version, 2);
  // "save this sabji as a meal": a save card beside it.
  await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: MEAL, base_version: 2, next_card_id: SAVE, closed: null }, clientId: "m3",
    userText: "save this sabji as a meal", dronaText: "Want it in My Meals?", card: LUNCH,
    served: { kind: "save", name: "Paneer sabji", lines: cardAsLines(card([["Paneer sabji", 150]])) }, mealType: "lunch",
  });
  const t = await s.load("u1", T);
  assertEquals(t!.cards.map((c) => [c.kind, c.version, c.lines.length]), [["meal", 2, 4], ["save", 1, 1]]);
  assertEquals(t!.last_seq, 6);
  assertEquals((await s.cardAt(MEAL, 1))?.length, 4);
  // The index lists meal cards to bring back; a save card is not one.
  const index = threadIndexLine(t, SAVE)!;
  assert(index.includes("[C1 v2] lunch card, 4 lines, 359 kcal"), index);
  assertEquals(threadIndexLine(t, null)?.startsWith("index: 1 earlier card"), true);
  assertEquals(threadIndexLine(t, MEAL), null);
});

Deno.test("a stale base or a retried message writes nothing", async () => {
  const s = memoryThreadStore();
  const base = { userId: "u1", userText: "x", dronaText: null, mealType: "lunch" as const, card: [] as CardLine[] };
  await recordThreadMessage(s, { ...base, req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1", served: { kind: "meal", items: [item("Rice", 200)], corrects: false } });
  const ok = await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "meal", items: [item("Dal", 120)], corrects: false } });
  assertEquals(ok, { ok: true, card_version: 2 });
  // The same message again (a retry): no third version.
  const retry = await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 2, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "meal", items: [item("Dal", 120)], corrects: false } });
  assertEquals(retry.card_version, 2);
  // Another device on the old base: nothing written, the server's version comes back.
  const stale = await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m3", served: { kind: "meal", items: [item("Curd", 60)], corrects: false } });
  assertEquals(stale, { ok: false, card_version: 2 });
  const t = await s.load("u1", T);
  assertEquals(t!.cards[0].lines.map((l) => [l.line_id, l.name]), [["L1", "Rice"], ["L2", "Dal"]]);
});

Deno.test("another user's thread id is never written to", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  const r = await recordThreadMessage(s, {
    userId: "u2", req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1",
    userText: "hi", dronaText: null, card: [], served: { kind: "reply" }, mealType: null,
  });
  assertEquals(r.ok, false);
  assertEquals(s.dump().threads.get(T)!.turns.length, 0);
});

Deno.test("a card the server never saw is stored as the base first", async () => {
  const s = memoryThreadStore();
  const r = await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: MEAL, base_version: 4, next_card_id: null, closed: null }, clientId: "m9",
    userText: "and a dosa", dronaText: null, card: card([["Samosa", 260]]),
    served: { kind: "meal", items: [item("Dosa", 170)], corrects: false }, mealType: "snack",
  });
  // Adopted at the app's v4, so the change lands as v5 on both sides.
  assertEquals(r, { ok: true, card_version: 5 });
  const t = await s.load("u1", T);
  assertEquals(t!.cards[0].lines.map((l) => l.name), ["Samosa", "Dosa"]);
  assertEquals((await s.cardAt(MEAL, 4))?.map((l) => l.name), ["Samosa"]);
});

Deno.test("the server behind the app (a missed write) takes the app's copy and count", async () => {
  const s = memoryThreadStore();
  const base = { userId: "u1", userText: "x", dronaText: null, mealType: "lunch" as const };
  await recordThreadMessage(s, { ...base, card: [], req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1", served: { kind: "meal", items: [item("Rice", 200)], corrects: false } });
  // The app counted v2 (an edit the server never got) and sends its card at v2.
  const r = await recordThreadMessage(s, { ...base, card: card([["Rice", 180], ["Dal", 120]]), req: { id: T, card_id: MEAL, base_version: 2, next_card_id: null, closed: null }, clientId: "m3", served: { kind: "meal", items: [item("Curd", 60)], corrects: false } });
  assertEquals(r, { ok: true, card_version: 3 });
  const t = await s.load("u1", T);
  assertEquals(t!.cards[0].lines.map((l) => [l.line_id, l.name, l.kcal]), [["L1", "Rice", 180], ["L2", "Dal", 120], ["L3", "Curd", 60]]);
});

Deno.test("the app's card is the base: a line removed on screen with no message stays removed", async () => {
  const s = memoryThreadStore();
  const base = { userId: "u1", userText: "x", dronaText: null, mealType: "lunch" as const };
  await recordThreadMessage(s, { ...base, card: [], req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1", served: { kind: "meal", items: [item("Rice", 200), item("Dal", 120)], corrects: false } });
  // The user swiped Dal off the card (no message), then typed "and curd".
  await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "meal", items: [item("Curd", 60)], corrects: false } });
  const t = await s.load("u1", T);
  assertEquals(t!.cards[0].lines.map((l) => [l.line_id, l.name]), [["L1", "Rice"], ["L3", "Curd"]]);
});

Deno.test("restore lists meal cards with lines only, and a restored line keeps its catalog id", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", [{ ...cardAsLines(card([["Rice", 200]]))[0], source_ref: "food-123" }], null, "lunch");
  await s.createCard(T, SAVE, "save", cardAsLines(card([["Sabji", 150]])), null, null);
  const th = await threadForAgent(s, "u1", { id: T, card_id: null, base_version: null, next_card_id: null, closed: null });
  assert(th!.index!.includes("1 earlier card"), th!.index!);
  assertEquals((await th!.restore("C1", null))!.items[0].food_id, "food-123");
  assertEquals(await th!.restore("C2", null), null);
});

Deno.test("closing a thread needs its owner", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.close("u2", T, "added");
  assertEquals(s.dump().threads.get(T)!.status, "open");
  await s.close("u1", T, "added");
  assertEquals(s.dump().threads.get(T)!.status, "closed");
});

Deno.test("a retried send adds its turns once", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.addTurns(T, 1, [{ role: "user", text: "rice" }, { role: "drona", text: "ok" }], "m1");
  await s.addTurns(T, 3, [{ role: "user", text: "rice" }, { role: "drona", text: "ok" }], "m1");
  assertEquals(s.dump().threads.get(T)!.turns.length, 2);
});

Deno.test("a base_version past the cap is no base", () => {
  assertEquals(readThreadRequest({ id: T, card_id: MEAL, base_version: 2 ** 40 })?.base_version, null);
});

Deno.test("a restored card's source is marked replaced, so the index lists the copy once", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  const th = await threadForAgent(s, "u1", { id: T, card_id: null, base_version: null, next_card_id: SAVE, closed: null });
  const got = await th!.restore("C1", null);
  assertEquals(th!.restoredFrom, MEAL);
  await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: null, base_version: null, next_card_id: SAVE, closed: null }, clientId: "m9",
    userText: "bring it back", dronaText: "Here it is.", card: [], served: { kind: "meal", items: got!.items, corrects: true },
    mealType: "lunch", restoredFrom: th!.restoredFrom,
  });
  const t = await s.load("u1", T);
  assertEquals(t!.cards.map((c) => [c.id, c.status]), [[MEAL, "replaced"], [SAVE, "open"]]);
  assertEquals(threadIndexLine(t, null)?.startsWith("index: 1 earlier card"), true);
});

Deno.test("a message after 30 idle minutes is kept, closes the thread, and the agent then gets no thread", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  s.dump().threads.get(T)!.last_at = new Date(Date.now() - THREAD_IDLE_MS - 60_000).toISOString();
  s.dump().threads.get(T)!.turns.push({ seq: 1, role: "user", text: "lunch" });
  await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: null, base_version: null, next_card_id: SAVE, closed: null }, clientId: "m2",
    userText: "hi", dronaText: "Hello.", card: [], served: { kind: "reply" }, mealType: null,
  });
  assertEquals(s.dump().threads.get(T)!.status, "closed");
  assertEquals(s.dump().threads.get(T)!.turns.length, 3);
  assertEquals(await threadForAgent(s, "u1", { id: T, card_id: null, base_version: null, next_card_id: null, closed: null }), null);
});

Deno.test("removing the highest line never hands its id to the next new line", async () => {
  const s = memoryThreadStore();
  const base = { userId: "u1", userText: "x", dronaText: null, mealType: "lunch" as const };
  await recordThreadMessage(s, { ...base, card: [], req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1", served: { kind: "meal", items: [item("Rice", 200), item("Dal", 120), item("Curd", 60)], corrects: false } });
  // Curd (L3) is removed by a correction, then a new line comes.
  await recordThreadMessage(s, { ...base, card: card([["Rice", 200], ["Dal", 120], ["Curd", 60]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "meal", items: [item("Rice", 200), item("Dal", 120)], corrects: true } });
  await recordThreadMessage(s, { ...base, card: card([["Rice", 200], ["Dal", 120]]), req: { id: T, card_id: MEAL, base_version: 2, next_card_id: null, closed: null }, clientId: "m3", served: { kind: "meal", items: [item("Salad", 40)], corrects: false } });
  const t = await s.load("u1", T);
  assertEquals(t!.cards[0].lines.map((l) => [l.line_id, l.name]), [["L1", "Rice"], ["L2", "Dal"], ["L4", "Salad"]]);
});

Deno.test("a restore that finds no lines marks nothing", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  const th = await threadForAgent(s, "u1", { id: T, card_id: null, base_version: null, next_card_id: null, closed: null });
  assertEquals(await th!.restore("C1", 9), null);
  assertEquals(th!.restoredFrom, null);
});

Deno.test("two lines that differ only in brackets keep their own ids", () => {
  const v1 = cardAsLines(card([["Rice (raw)", 100], ["Rice (cooked)", 200]]));
  const v2 = withLineIds(v1, [{ name: "Rice (cooked)" }, { name: "Rice (raw)" }]);
  assertEquals(v2.map((l) => [l.name, l.line_id]), [["Rice (cooked)", "L2"], ["Rice (raw)", "L1"]]);
  // An edit to the bracket text still keeps the id.
  assertEquals(withLineIds(v1, [{ name: "Rice (cooked, 150 g)" }, { name: "Rice (raw)" }]).map((l) => l.line_id), ["L2", "L1"]);
});
