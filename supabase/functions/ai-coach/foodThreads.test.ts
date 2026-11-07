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
  INDEX_MAX_NAMES,
  threadForAgent,
  threadIndex,
  threadIndexLine,
  threadIsOpen,
  THREAD_IDLE_GRACE_MS,
  THREAD_IDLE_MS,
  withLineIds,
  itemsAsLines,
  lineAsItem,
  rowAsLine,
} from "./foodThreads.ts";
import type { CardLine } from "./foodContext.ts";
import { THREAD_IDLE_MS as APP_THREAD_IDLE_MS } from "../../../lib/foodThread.ts";
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
  // The server gives the app's own 30-minute rule a few minutes of slack.
  assert(threadIsOpen({ status: "open", last_at: new Date(now - THREAD_IDLE_MS - 1000).toISOString() }, now));
  assert(!threadIsOpen({ status: "open", last_at: new Date(now - THREAD_IDLE_MS - THREAD_IDLE_GRACE_MS - 1000).toISOString() }, now));
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
  assert(index.includes("[C1 v2] lunch card: L1 Jeera Rice, L2 Paneer sabji, L3 Soya curry, L4 Methi aloo"), index);
  assert(!index.includes("C2"), index);
  assertEquals(threadIndexLine(t, MEAL), null);
});

Deno.test("a retried message writes nothing; a stale base is written on top", async () => {
  const s = memoryThreadStore();
  const base = { userId: "u1", userText: "x", dronaText: null, mealType: "lunch" as const, card: [] as CardLine[] };
  await recordThreadMessage(s, { ...base, req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1", served: { kind: "meal", items: [item("Rice", 200)], corrects: false } });
  const ok = await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "meal", items: [item("Dal", 120)], corrects: false } });
  assertEquals(ok, { ok: true, card_version: 2 });
  // The same message again (a retry): no third version.
  const retry = await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 2, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "meal", items: [item("Dal", 120)], corrects: false } });
  assertEquals(retry.card_version, 2);
  // Another device on the old base (or an answer the app never counted): the
  // app's card goes on top of the server's version, so the copy keeps moving.
  const stale = await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m3", served: { kind: "meal", items: [item("Curd", 60)], corrects: false } });
  assertEquals(stale, { ok: true, card_version: 3 });
  const t = await s.load("u1", T);
  // v3 is the app's card (Rice) plus Curd; v2 (Rice, Dal) is still stored.
  assertEquals(t!.cards[0].lines.map((l) => [l.line_id, l.name]), [["L1", "Rice"], ["L3", "Curd"]]);
  assertEquals((await s.cardAt(MEAL, 2))?.map((l) => l.name), ["Rice", "Dal"]);
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
  assert(th!.index!.includes("[C1 v1] lunch card: L1 Rice."), th!.index!);
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
  // The copy is the one card listed (C2); the source keeps its number but is gone.
  const line = threadIndexLine(t, null)!;
  assert(line.includes("[C2 v1]") && !line.includes("[C1"), line);
});

Deno.test("a late message on the app's thread id keeps the chat open; a long-idle thread reads as closed", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  s.dump().threads.get(T)!.turns.push({ seq: 1, role: "user", text: "lunch" });
  // A minute past 30: the app still sent this id, so it is the same chat.
  s.dump().threads.get(T)!.last_at = new Date(Date.now() - THREAD_IDLE_MS - 60_000).toISOString();
  await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: null, base_version: null, next_card_id: SAVE, closed: null }, clientId: "m2",
    userText: "hi", dronaText: "Hello.", card: [], served: { kind: "reply" }, mealType: null,
  });
  assertEquals(s.dump().threads.get(T)!.status, "open");
  assertEquals(s.dump().threads.get(T)!.turns.length, 3);
  assert(await threadForAgent(s, "u1", { id: T, card_id: null, base_version: null, next_card_id: null, closed: null }));
  // Left alone for an hour: reads treat it as closed.
  s.dump().threads.get(T)!.last_at = new Date(Date.now() - 60 * 60_000).toISOString();
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

Deno.test("card refs stay the same after a restore: a replaced card keeps its number", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  const A = "55555555-5555-4555-8555-555555555555";
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  await s.createCard(T, A, "meal", cardAsLines(card([["Poha", 250]])), null, "breakfast");
  await s.setCardStatus(T, MEAL, "replaced");
  const t = await s.load("u1", T);
  const index = threadIndexLine(t, null)!;
  assert(index.includes("[C2 v1] breakfast card"), index);
  assert(!index.includes("[C1"), index);
});

Deno.test("a restore whose copy fails to save leaves its source card listed", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  const broken = { ...s, createCard: async () => { throw new Error("db down"); } };
  const r = await recordThreadMessage(broken, {
    userId: "u1", req: { id: T, card_id: null, base_version: null, next_card_id: SAVE, closed: null }, clientId: "m9",
    userText: "bring it back", dronaText: null, card: [], served: { kind: "meal", items: [item("Rice", 171)], corrects: true },
    mealType: "lunch", restoredFrom: MEAL,
  });
  assertEquals(r.ok, false);
  assertEquals(s.dump().cards.get(MEAL)!.status, "open");
});

Deno.test("a restore onto a card emptied on screen marks its source too", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  const OLD = "66666666-6666-4666-8666-666666666666";
  await s.createCard(T, OLD, "meal", cardAsLines(LUNCH), null, "lunch");
  await s.createCard(T, MEAL, "meal", cardAsLines(card([["Poha", 250]])), null, "breakfast");
  const r = await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: MEAL, base_version: 1, next_card_id: SAVE, closed: null }, clientId: "m9",
    userText: "bring back lunch", dronaText: null, card: [], served: { kind: "meal", items: [item("Jeera Rice", 171)], corrects: true },
    mealType: "lunch", restoredFrom: OLD,
  });
  assertEquals(r.ok, true);
  assertEquals(s.dump().cards.get(OLD)!.status, "replaced");
  assertEquals((await s.load("u1", T))!.cards.find((c) => c.id === MEAL)!.lines.map((l) => l.name), ["Jeera Rice"]);
});

Deno.test("a card cleared on screen can be brought back: its last lines come back", async () => {
  const s = memoryThreadStore();
  const base = { userId: "u1", userText: "x", dronaText: null, mealType: "lunch" as const };
  await recordThreadMessage(s, { ...base, card: [], req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1", served: { kind: "meal", items: [item("Rice", 200), item("Dal", 120)], corrects: false } });
  await recordThreadMessage(s, { ...base, card: card([["Rice", 200], ["Dal", 120]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "cleared" } });
  const th = await threadForAgent(s, "u1", { id: T, card_id: null, base_version: null, next_card_id: null, closed: null });
  assert(th!.index!.includes("cleared"), th!.index!);
  assertEquals((await th!.restore("C1", null))!.items.map((i) => i.food_name), ["Rice", "Dal"]);
});

Deno.test("the app and the server use the same 30-minute idle rule", () => {
  assertEquals(THREAD_IDLE_MS, APP_THREAD_IDLE_MS);
});

Deno.test("clearing a card on an older base is written on top, so it reads as cleared", async () => {
  const s = memoryThreadStore();
  const base = { userId: "u1", userText: "x", dronaText: null, mealType: "lunch" as const };
  await recordThreadMessage(s, { ...base, card: [], req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1", served: { kind: "meal", items: [item("Rice", 200)], corrects: false } });
  await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m2", served: { kind: "meal", items: [item("Dal", 120)], corrects: false } });
  // The app still thinks v1, and clears the card.
  const r = await recordThreadMessage(s, { ...base, card: card([["Rice", 200]]), req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m3", served: { kind: "cleared" } });
  assertEquals(r, { ok: true, card_version: 3 });
  assertEquals(s.dump().cards.get(MEAL)!.status, "discarded");
});

Deno.test("a retried send that makes the same new card again is done, not an error", async () => {
  const s = memoryThreadStore();
  const send = {
    userId: "u1", req: { id: T, card_id: null, base_version: null, next_card_id: MEAL, closed: null }, clientId: "m1",
    userText: "rice", dronaText: null, card: [], served: { kind: "meal" as const, items: [item("Rice", 200)], corrects: false }, mealType: "lunch" as const,
  };
  assertEquals((await recordThreadMessage(s, send)).ok, true);
  assertEquals(await recordThreadMessage(s, send), { ok: true, card_version: 1 });
  assertEquals(s.dump().cards.size, 1);
  assertEquals(s.dump().threads.get(T)!.turns.length, 1);
});

Deno.test("new lines joining a card keep the card's own lines exactly, unknown macros included", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  const line = { ...cardAsLines(card([["Chai", 90]]))[0], protein_g: null, carb_g: null, fat_g: null, grams: null };
  await s.createCard(T, MEAL, "meal", [line], null, "snack");
  await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: MEAL, base_version: 1, next_card_id: null, closed: null }, clientId: "m2",
    userText: "and a rusk", dronaText: null,
    // The app sends the card it shows: the chai line with no macros known.
    card: [{ food_name: "Chai", quantity: 1, serving_label: "cup", grams: 0, kcal: 90 }],
    served: { kind: "meal", items: [item("Rusk", 40)], corrects: false }, mealType: "snack",
  });
  const t = await s.load("u1", T);
  const [chai, rusk] = t!.cards[0].lines;
  assertEquals([chai.line_id, chai.protein_g, chai.carb_g, chai.fat_g], ["L1", null, null, null]);
  assertEquals([rusk.line_id, rusk.name], ["L2", "Rusk"]);
});

// ── Index with food names, within its budget (owner, 2026-11-06) ────────────

const U = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const foods = (prefix: string, n: number) => card(Array.from({ length: n }, (_, i) => [`${prefix} ${i + 1}`, 100 + i] as [string, number]));

Deno.test("index: the newest earlier card lists every food, others 8 then +N more, at most 3 cards", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  // Five earlier cards, oldest first; the newest has 12 lines.
  for (let i = 1; i <= 4; i++) await s.createCard(T, U(i), "meal", cardAsLines(foods(`food${i}`, 10)), null, "lunch");
  await s.createCard(T, U(5), "meal", cardAsLines(foods("newest", 12)), null, "dinner");
  const idx = threadIndex(await s.load("u1", T), null)!;
  // Newest first: C5 whole, then C4 and C3 with 8 names each. C1 and C2 not listed.
  assert(idx.text.startsWith("index: earlier cards in this thread, newest first: [C5 v1] dinner card: L1 newest 1,"), idx.text);
  assert(idx.text.includes("L12 newest 12;"), idx.text);
  assert(idx.text.includes("[C4 v1] lunch card: L1 food4 1,") && idx.text.includes("L8 food4 8, +2 more;"), idx.text);
  assert(idx.text.includes("L8 food3 8, +2 more."), idx.text);
  assert(!idx.text.includes("[C2") && !idx.text.includes("[C1"), idx.text);
  assert(idx.text.includes("2 older cards not listed"), idx.text);
  assertEquals([idx.names, idx.cards_listed, idx.cards_total, idx.chars], [28, 3, 5, idx.text.length]);
  // Names only: no calories, no grams.
  assert(!/kcal|\b1\d\d\b/.test(idx.text), idx.text);
});

Deno.test("index: a hard cap on names overall, and bracketed detail (with its numbers) dropped", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, U(1), "meal", cardAsLines(foods("older", 10)), null, "lunch");
  await s.createCard(T, U(2), "meal", cardAsLines(card([["Paneer sabji (60 g paneer, oil)", 150], ...foods("big", 44).map((l) => [l.food_name, l.kcal] as [string, number])])), null, "lunch");
  const idx = threadIndex(await s.load("u1", T), null)!;
  assertEquals(idx.names, INDEX_MAX_NAMES);
  assert(idx.text.includes("L1 Paneer sabji,") && !idx.text.includes("60 g"), idx.text);
  // 45 lines on the newest card: 40 shown, 5 more. Nothing left for the older card.
  assert(idx.text.includes("+5 more;"), idx.text);
  assert(idx.text.includes("[C1 v1] lunch card: +10 more."), idx.text);
});

Deno.test("index: a card cleared on screen is listed at its last version WITH lines, never the empty one", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  await s.writeCard(MEAL, 1, [], "m2", "discarded");
  const t = await s.load("u1", T);
  assertEquals([t!.cards[0].version, t!.cards[0].last_version], [2, 1]);
  const line = threadIndexLine(t, null)!;
  assert(line.includes("[C1 v1] lunch card (cleared on screen): L1 Jeera Rice"), line);
  assert(!line.includes("v2"), line);
  const th = await threadForAgent(s, "u1", { id: T, card_id: null, base_version: null, next_card_id: null, closed: null });
  assertEquals((await th!.lines!("C1", null))?.version, 1);
  assertEquals((await th!.restore("C1", null))?.items.length, 4);
});

Deno.test("thread lines: an older version by number, never the card on screen", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  await s.writeCard(MEAL, 1, cardAsLines(LUNCH.slice(0, 2)), "m2");
  await s.createCard(T, SAVE, "meal", cardAsLines(card([["Dal", 120]])), null, "dinner");
  const th = await threadForAgent(s, "u1", { id: T, card_id: SAVE, base_version: 1, next_card_id: null, closed: null });
  // The index names only the earlier card, at its latest version.
  assert(th!.index!.includes("[C1 v2] lunch card: L1 Jeera Rice, L2 Paneer sabji."), th!.index!);
  assertEquals((await th!.lines!("C1", 1))?.lines.length, 4);
  assertEquals((await th!.lines!("c1", null))?.lines.map((l) => l.line_id), ["L1", "L2"]);
  assertEquals(await th!.lines!("C1", 7), null);
  // C2 is on screen: not an earlier card, and the agent is told its ref.
  assertEquals(await th!.lines!("C2", null), null);
  assertEquals(th!.onScreenRef, "C2");
});

Deno.test("a message on a thread the nightly job already closed: no earlier cards, and the card is still written", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  // food_threads_retention(): idle > 30 min is closed by the cron.
  await s.close("u1", T, "idle");
  const req = { id: T, card_id: MEAL, base_version: 1, next_card_id: SAVE, closed: null };
  assertEquals(await threadForAgent(s, "u1", req), null);
  const r = await recordThreadMessage(s, {
    userId: "u1", req, clientId: "late-1", userText: "and a roti", dronaText: "Added.", card: LUNCH,
    served: { kind: "meal", items: [item("Roti", 120)], corrects: false }, mealType: "lunch",
  });
  assertEquals(r, { ok: true, card_version: 2 });
  assertEquals(s.dump().cards.get(MEAL)!.versions.get(2)!.map((l) => l.name).at(-1), "Roti");
  assertEquals(s.dump().threads.get(T)!.turns.length, 2);
});

Deno.test("copied lines join the open card as new lines with new ids; the card's own lines are untouched", async () => {
  const s = memoryThreadStore();
  await s.ensure("u1", T);
  await s.createCard(T, MEAL, "meal", cardAsLines(LUNCH), null, "lunch");
  // A second portion of a food already on the card is its own line.
  const r = await recordThreadMessage(s, {
    userId: "u1", req: { id: T, card_id: MEAL, base_version: 1, next_card_id: SAVE, closed: null }, clientId: "c1",
    userText: "add the sabji again", dronaText: "Added.", card: LUNCH,
    served: { kind: "meal", items: [{ ...item("Paneer sabji", 150), source: "estimate" }], corrects: false }, mealType: "lunch",
  });
  assertEquals(r.ok, true);
  const v2 = s.dump().cards.get(MEAL)!.versions.get(2)!;
  assertEquals(v2.map((l) => [l.line_id, l.name]), [
    ["L1", "Jeera Rice"], ["L2", "Paneer sabji"], ["L3", "Soya curry"], ["L4", "Methi aloo"], ["L5", "Paneer sabji"],
  ]);
  assertEquals(v2[4].source, "estimate");
});

// ── A dish built from its parts keeps its parts (step 5 follow-up) ──────────

const SABJI_PARTS = [
  { name: "low fat paneer", grams: 60, per100: { kcal: 254, protein_g: 25, carb_g: 4, fat_g: 15 }, source: "catalog" as const },
  { name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }, source: "catalog" as const, assumed: true },
];

Deno.test("recipe: a dish line keeps its parts and source through the store", () => {
  const dish: ParsedItem = {
    food_id: null, food_name: "Paneer sabji", quantity: 1, serving_label: "serving", grams: 65, kcal: 196.6,
    protein_g: 15, carb_g: 2.4, fat_g: 14, fiber_g: null, source: "recipe", assumption: "Assumed 1 tsp oil. Parts: 60 g low fat paneer, 5 g oil.",
    confidence: "medium", meal_type: "lunch", recipe: SABJI_PARTS,
  };
  const [line] = itemsAsLines([dish], null);
  assertEquals(line.recipe, SABJI_PARTS);
  const back = lineAsItem(line, "lunch");
  assertEquals(back.source, "recipe");
  assertEquals(back.recipe, SABJI_PARTS);
  // The card the app sent, stored for a thread that had no copy yet.
  const [fromCard] = cardAsLines([{ food_name: "Paneer sabji", quantity: 1, serving_label: "serving", grams: 65, kcal: 196.6, source: "recipe", recipe: SABJI_PARTS }]);
  assertEquals(fromCard.recipe, SABJI_PARTS);
});

Deno.test("recipe: a stored row's recipe is read back, checked; an old row has none", () => {
  const row = { line_id: "L1", name: "Paneer sabji", kcal: 197, source: "recipe", recipe: SABJI_PARTS };
  assertEquals(rowAsLine(row).recipe, SABJI_PARTS);
  assertEquals(rowAsLine({ line_id: "L1", name: "Rice", kcal: 195, source: "catalog" }).recipe ?? null, null);
  // Junk in the column is dropped, not passed on.
  assertEquals(rowAsLine({ ...row, recipe: [{ name: "", grams: -1 }] }).recipe ?? null, null);
  // Parts on a line that is no longer a recipe are not handed back.
  assertEquals(lineAsItem({ ...rowAsLine(row), source: "catalog" }, "lunch").recipe, undefined);
});
