// deno test --allow-all scripts/food-box-eval/grade.test.ts
//
// The grader decides what "better" means for the food box, so it is pinned
// here: each rule on a tiny made-up card, the case file's own integrity, and a
// few facts about the recorded baseline that a broken check would hide.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { CASES } from "./cases.ts";
import { grade, inRange, nameKey } from "./grade.ts";
import type { FoodBoxCase, Line, Outcome } from "./types.ts";

const L = (name: string, kcal: number, more: Partial<Line> = {}): Line => ({ name, kcal, ...more });

const base = (expect: FoodBoxCase["expect"], card: Line[] | null = null): FoodBoxCase => ({
  id: "t",
  tags: [],
  origin: { date: "2026-11-06", who: "synthetic" },
  thread: { turns: [], card },
  message: "x",
  expect,
});

const out = (card: Line[] | null, actions: Outcome["actions"] = ["edit"], reply: string | null = null, savedMeal: Outcome["savedMeal"] = null): Outcome =>
  ({ card, actions, reply, savedMeal });

const failed = (c: FoodBoxCase, o: Outcome) => grade(c, o).checks.filter((k) => !k.pass).map((k) => k.name);

Deno.test("inRange: open ends and non-numbers", () => {
  assert(inRange(5, [null, 10]));
  assert(inRange(5, [5, 5]));
  assert(!inRange(11, [null, 10]));
  assert(!inRange(null, [0, 10]));
  assert(!inRange(Number.NaN, [null, null]));
});

Deno.test("nameKey folds case, brackets, punctuation and simple plurals", () => {
  assertEquals(nameKey("Boiled Eggs"), nameKey("boiled egg"));
  assertEquals(nameKey("Rice (cooked, 150 g)"), "rice");
  // "grass" keeps its double s.
  assertEquals(nameKey("grass"), "grass");
  // A name that is all brackets keeps its words, not an empty key.
  assertEquals(nameKey("(2 eggs)"), "2 egg");
  assert(nameKey("(2 eggs)") !== nameKey("(1 banana)"));
});

Deno.test("keepLines fails when a line the user did not remove is gone", () => {
  const c = base({ keepLines: ["^rice", "dal"] });
  assertEquals(failed(c, out([L("Dal (poured over rice)", 34)])), ["keep:^rice"]);
});

Deno.test("line spec checks kcal, grams, protein, source and meal", () => {
  const c = base({ lines: [{ match: "paneer", kcal: [130, 230], grams: [55, 65], protein_g: [10, null], source: ["recipe"], meal: "lunch" }] });
  assertEquals(failed(c, out([L("paneer sabji", 170, { grams: 60, protein_g: 14, source: "recipe", meal: "lunch" })])), []);
  const bad = grade(c, out([L("paneer sabji", 57, { grams: 60, protein_g: 3.6, source: "manual", meal: "lunch" })]));
  assert(!bad.pass);
  const detail = bad.checks[0].detail ?? "";
  assert(detail.includes("kcal 57") && detail.includes("protein 3.6") && detail.includes("source manual"), detail);
});

Deno.test("every line a spec matches is judged, so a stray duplicate with wrong numbers fails", () => {
  const c = base({ lines: [{ match: "paneer", kcal: [145, 155] }] });
  assertEquals(failed(c, out([L("paneer sabji", 150), L("paneer sabji (old)", 57)])), ["line:paneer"]);
  assertEquals(failed(c, out([L("paneer sabji", 150)])), []);
});

Deno.test("a line on the wrong meal fails its meal check", () => {
  const c = base({ lines: [{ match: "rajma", meal: "dinner" }] });
  assertEquals(failed(c, out([L("Rajma", 220, { meal: "lunch" })])), ["line:rajma"]);
  // A line that does not say its meal does not pass a meal check.
  assertEquals(failed(c, out([L("Rajma", 220)])), ["line:rajma"]);
  assertEquals(failed(c, out([L("Rajma", 220, { meal: "dinner" })])), []);
});

Deno.test("a line spec with no matching line fails", () => {
  assertEquals(failed(base({ lines: [{ match: "milk" }] }), out([L("oats", 180)])), ["line:milk"]);
});

Deno.test("noDuplicates catches the same name twice and one spec matched twice", () => {
  const c = base({ noDuplicates: true, lines: [{ match: "paneer" }] });
  assertEquals(failed(c, out([L("Paneer sabji", 150), L("paneer sabji", 57)])), ["noDuplicates"]);
  // Different names, same food: the spec catches it.
  assertEquals(failed(c, out([L("Milky Mist paneer sabji (60 g)", 190), L("Milky Mist low fat paneer sabji", 57)])), ["noDuplicates"]);
  assertEquals(failed(c, out([L("paneer sabji", 150), L("rice", 171)])), []);
});

Deno.test("does / mustNot read the outcome's actions", () => {
  const c = base({ does: ["save"], mustNot: ["log"] });
  assertEquals(failed(c, out(null, ["answer", "log"])), ["does:save", "mustNot:log"]);
});

Deno.test("a reply that claims a log with no log behind it fails; the same words after a log pass", () => {
  const c = base({ reply: { noFalseClaim: true } });
  const claim = "Got it - logging a standard casein shake for you now.";
  assertEquals(failed(c, out(null, ["answer"], claim)), ["reply makes no false claim"]);
  assertEquals(failed(c, out([L("casein", 75)], ["log"], claim)), []);
  // An offer is not a claim.
  assertEquals(failed(c, out(null, ["answer"], "Tell me the foods and I'll log them.")), []);
});

Deno.test("a claim must match the action it names: 'saved' after only an edit is false", () => {
  const c = base({ reply: { noFalseClaim: true } });
  assertEquals(failed(c, out([L("paneer sabji", 150)], ["edit"], "I've saved it as a meal.")), ["reply makes no false claim"]);
  assertEquals(failed(c, out([L("paneer sabji", 150)], ["edit", "save"], "I've saved it as a meal.")), []);
  // "logged" after only a save is false too.
  assertEquals(failed(c, out(null, ["save"], "I've logged your lunch.")), ["reply makes no false claim"]);
  assertEquals(failed(c, out([L("rice", 171)], ["log"], "I've logged your lunch.")), []);
});

Deno.test("reply mustMention / mustNotSay", () => {
  const c = base({ reply: { mustMention: ["paneer"], mustNotSay: ["the label says"] } });
  assertEquals(failed(c, out(null, ["answer"], "Rice: the label says 129 kcal per 100 g.")), ["reply mentions /paneer/", "reply avoids /the label says/"]);
});

Deno.test("cardUnchanged compares names, kcal and amounts, not order", () => {
  const card = [L("Roti", 240, { quantity: 2 }), L("Dal", 150)];
  const c = base({ cardUnchanged: true }, card);
  assertEquals(failed(c, out([L("dal", 150), L("roti", 240, { quantity: 2 })])), []);
  assertEquals(failed(c, out([L("Roti", 240, { quantity: 2 })])), ["cardUnchanged"]);
});

Deno.test("savedMeal needs a save with real macros", () => {
  const c = base({ savedMeal: { kcal: [130, 230], proteinMin: 8, nameMatch: "paneer" } });
  assertEquals(failed(c, out(null, ["save"])), ["savedMeal"]);
  const zeroMacros = { name: "Paneer sabji", kcal: 150, protein_g: 0, carb_g: 0, fat_g: 0 };
  assertEquals(failed(c, out(null, ["save"], null, zeroMacros)), ["savedMeal"]);
  assertEquals(failed(c, out(null, ["save"], null, { ...zeroMacros, protein_g: 11 })), []);
});

Deno.test("a case with no checks never passes", () => {
  assert(!grade(base({}), out([])).pass);
});

// ── The case file ───────────────────────────────────────────────────────────

Deno.test("cases: unique ids, valid regexes, at least one expectation each", () => {
  const ids = new Set<string>();
  for (const c of CASES) {
    assert(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    const e = c.expect;
    const sources = [
      ...(e.keepLines ?? []),
      ...(e.removeLines ?? []),
      ...(e.lines ?? []).map((l) => l.match),
      ...(e.reply?.mustMention ?? []),
      ...(e.reply?.mustNotSay ?? []),
      ...(e.savedMeal?.nameMatch ? [e.savedMeal.nameMatch] : []),
    ];
    for (const s of sources) new RegExp(s, "i");
    // A case that grades nothing would always fail, which hides real failures.
    assert(grade(c, { card: [], reply: null, actions: [] }).checks.length > 0, `${c.id} has no checks`);
  }
  assert(CASES.length >= 45, `only ${CASES.length} cases`);
});

// A guard, not a privacy proof: it catches the Clerk ids this app uses
// (user_...) and email addresses, in the cases and in the report made from them.
const PERSONAL = /user_[0-9A-Za-z]{6,}|[\w.+-]+@[\w-]+\.[\w.]{2,}/;

Deno.test("cases: other users' messages carry no account id or email", () => {
  for (const c of CASES) {
    assert(!PERSONAL.test(JSON.stringify(c)), `${c.id} contains an account id or email`);
  }
});

Deno.test("BASELINE.md carries no account id or email", async () => {
  const text = await Deno.readTextFile(new URL("./BASELINE.md", import.meta.url));
  assert(!PERSONAL.test(text));
});

// ── Facts about the recorded baseline ───────────────────────────────────────

const recordedGrade = (id: string) => {
  const c = CASES.find((x) => x.id === id);
  assert(c?.recorded, `${id} has no recording`);
  return grade(c, c.recorded);
};

Deno.test("baseline: the Nov 5 bring-back request did not restore the card", () => {
  const g = recordedGrade("nov5-bring-back-card");
  assert(!g.pass);
  assert(g.checks.some((k) => k.name === "does:restore" && !k.pass));
});

Deno.test("baseline: the Nov 2 correction lost the rice (the dal line named 'over rice' does not count)", () => {
  const g = recordedGrade("nov2-dal-and-oil-keeps-rice");
  assert(g.checks.some((k) => k.name === "keep:^rice" && !k.pass));
});

Deno.test("baseline: the saved meal had calories and no macros", () => {
  const g = recordedGrade("nov5-save-sabji-keeps-lunch");
  assert(g.checks.some((k) => k.name === "savedMeal" && !k.pass && (k.detail ?? "").includes("protein 0")));
});

Deno.test("baseline: a plain greeting passed", () => {
  assert(recordedGrade("greeting").pass);
});
