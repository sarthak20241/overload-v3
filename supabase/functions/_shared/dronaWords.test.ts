import { assertEquals } from "jsr:@std/assert@1";
import {
  chooseTexts, MAX_TEXTS, questionKey, readText, stateFor, type TextReading, type WordFacts, wordBehaviours,
  wordSignals, type WordText, YES,
} from "./dronaWords.ts";

const text = (id: string, day: string, t: string, kind = "chat_message"): WordText => ({ id, kind, day, text: t });
const reading = (over: Partial<TextReading>): TextReading => ({
  id: "chat_message:1", day: "2026-10-14", pain: 0.02, area: null, life: 0.02, reason: null, trained: 0.02,
  ask: 0.02, change: null, ...over,
});
const facts = (over: Partial<WordFacts> = {}): WordFacts => ({
  week_start: "2026-10-12", session_days: ["2026-10-13"], sessions: 1, planned: 4, plan_changes: [], ...over,
});
const fired = (f: WordFacts, rs: TextReading[]) =>
  Object.fromEntries(wordSignals(f, rs).map((s) => [s.signal, s.fired]));

Deno.test("chooseTexts: never reads our own card opening lines back, and keeps the newest 20", () => {
  const ours = "I asked to change my training days and it has not happened yet. Can we do it now?";
  const f = facts({ texts: [text("a", "2026-10-13", ours), text("b", "2026-10-13", "my knee hurts")], prompts: [ours, null] });
  assertEquals(chooseTexts(f).map((t) => t.id), ["b"]);
  // Spacing and case do not hide our own line.
  assertEquals(chooseTexts(facts({ texts: [text("c", "2026-10-13", `  ${ours.toUpperCase()} `)], prompts: [ours] })), []);
  const many = Array.from({ length: 25 }, (_, i) => text(`t${i}`, "2026-10-14", `message ${i}`));
  const kept = chooseTexts(facts({ texts: many }));
  assertEquals([kept.length, kept[0].id, kept.at(-1)!.id], [MAX_TEXTS, "t5", "t24"]);
});

Deno.test("stateFor: the text, where, and up to two earlier texts from the same day only", () => {
  const all = [text("a", "2026-10-13", "yesterday"), text("b", "2026-10-14", "squats today"),
    text("c", "2026-10-14", "left knee"), text("d", "2026-10-14", "it still hurts")];
  const s = stateFor(all[3], all);
  assertEquals(s.text, "it still hurts");
  assertEquals(s.earlier_the_same_day, ["squats today", "left knee"]);
  assertEquals("earlier_the_same_day" in stateFor(all[1], all), false);
});

Deno.test("readText: noul scores and allowed choices only", () => {
  const t = text("x", "2026-10-14", "knee hurts");
  const r = readText(t, 3, {
    [questionKey(3, "pain")]: { type: "noul", noul: 0.91 },
    [questionKey(3, "area")]: { type: "choice", choice: "knee", confidence: 0.8 },
    [questionKey(3, "change")]: { type: "choice", choice: "teleport", confidence: 0.9 },
    [questionKey(3, "ask")]: { type: "choice", choice: "yes" },
  });
  assertEquals([r.pain, r.area, r.change, r.ask, r.life], [0.91, "knee", null, null, null]);
});

Deno.test("hurting: a yes at the line fires, just under it does not", () => {
  assertEquals(fired(facts(), [reading({ pain: YES })]).hurting, true);
  assertEquals(fired(facts(), [reading({ pain: YES - 0.01 })]).hurting, false);
  const s = wordSignals(facts(), [reading({ pain: 0.9, area: "knee", day: "2026-10-15" })]).find((x) => x.signal === "hurting")!;
  assertEquals([s.detail?.area, s.detail?.day], ["knee", "2026-10-15"]);
});

Deno.test("life got in the way: needs a reason AND under half the plan", () => {
  const why = reading({ life: 0.9, reason: "travel" });
  assertEquals(fired(facts({ sessions: 1, planned: 4 }), [why]).life_got_in_the_way, true);
  assertEquals(fired(facts({ sessions: 2, planned: 4 }), [why]).life_got_in_the_way, false);
  assertEquals(fired(facts({ sessions: 0, planned: 0 }), [why]).life_got_in_the_way, false);
  assertEquals(fired(facts({ sessions: 0, planned: 4 }), [reading({})]).life_got_in_the_way, false);
});

Deno.test("trains not logging: only on a day with no session logged", () => {
  assertEquals(fired(facts(), [reading({ trained: 0.9, day: "2026-10-16" })]).trains_not_logging, true);
  assertEquals(fired(facts(), [reading({ trained: 0.9, day: "2026-10-13" })]).trains_not_logging, false);
  // The morning after a logged session: soreness reads as "trained", and it is not a missing log.
  assertEquals(fired(facts({ session_days: ["2026-10-13"] }), [reading({ trained: 0.9, day: "2026-10-14" })]).trains_not_logging,
    false);
});

Deno.test("asked for a change: answered only by a matching change on or after the ask", () => {
  const ask = reading({ ask: 0.9, change: "training_days", day: "2026-10-14" });
  assertEquals(fired(facts(), [ask]).asked_for_a_change, true);
  assertEquals(fired(facts({ plan_changes: [{ entity: "program", day: "2026-10-16" }] }), [ask]).asked_for_a_change, false);
  // The same day counts; a change BEFORE the ask does not answer it.
  assertEquals(fired(facts({ plan_changes: [{ entity: "routine", day: "2026-10-14" }] }), [ask]).asked_for_a_change, false);
  assertEquals(fired(facts({ plan_changes: [{ entity: "routine", day: "2026-10-13" }] }), [ask]).asked_for_a_change, true);
  // A calorie change does not answer a training-days ask.
  assertEquals(fired(facts({ plan_changes: [{ entity: "targets", day: "2026-10-15" }] }), [ask]).asked_for_a_change, true);
  // "other" is answered by any change.
  assertEquals(fired(facts({ plan_changes: [{ entity: "targets", day: "2026-10-15" }] }),
    [reading({ ask: 0.9, change: null, day: "2026-10-14" })]).asked_for_a_change, false);
});

Deno.test("hurting: a later 'fine now' about the SAME place cancels it; another place does not", () => {
  const hurt = reading({ pain: 0.9, area: "knee", day: "2026-10-13" });
  assertEquals(fired(facts(), [hurt, reading({ pain: 0.05, area: "knee", day: "2026-10-15" })]).hurting, false);
  assertEquals(fired(facts(), [hurt, reading({ pain: 0.05, area: "shoulder", day: "2026-10-15" })]).hurting, true);
  assertEquals(fired(facts(), [hurt, reading({ pain: 0.05, area: "other", day: "2026-10-15" })]).hurting, true);
  // "Somewhere" is not a place: an unplaced pain is not cancelled by an unplaced "fine".
  assertEquals(fired(facts(), [reading({ pain: 0.9, area: "other" }), reading({ pain: 0.05, area: "other" })]).hurting, true);
  // Unsure is not "fine".
  assertEquals(fired(facts(), [hurt, reading({ pain: 0.5, area: "knee", day: "2026-10-15" })]).hurting, true);
  // An earlier "fine" does not cancel a later pain.
  assertEquals(fired(facts(), [reading({ pain: 0.05, area: "knee", day: "2026-10-12" }), hurt]).hurting, true);
});

Deno.test("the newest reading speaks for the week", () => {
  const s = wordSignals(facts(), [reading({ pain: 0.9, area: "back", day: "2026-10-13" }),
    reading({ pain: 0.9, area: "knee", day: "2026-10-16" })]).find((x) => x.signal === "hurting")!;
  assertEquals(s.detail?.area, "knee");
});

Deno.test("wordBehaviours: priorities, kinds and what each quiets", () => {
  const rows = wordBehaviours([
    { signal: "hurting", fired: true, detail: { area: "knee" } },
    { signal: "asked_for_a_change", fired: true, detail: { change: "training_days" } },
    { signal: "life_got_in_the_way", fired: true, detail: { reason: "illness" } },
    { signal: "trains_not_logging", fired: true, detail: { day: "2026-10-14" } },
    { signal: "hurting", fired: false, detail: {} },
  ]);
  assertEquals(rows.map((r) => [r.behaviour, r.priority, r.card_kind]), [
    ["hurting", 5, "talk"], ["asked_for_a_change", 15, "talk"], ["life_got_in_the_way", 18, "notice"],
    ["trains_not_logging", 19, "notice"]]);
  assertEquals(rows[0].mutes?.includes("topic:lift_stall"), true);
  assertEquals(rows[1].mutes, ["topic:plan_too_big"]);
  assertEquals(wordBehaviours([{ signal: "asked_for_a_change", fired: true, detail: { change: "goal_or_weight" } }])[0].mutes,
    ["topic:goals_unclear"]);
  assertEquals(wordBehaviours([{ signal: "life_got_in_the_way", fired: true, detail: { reason: "travel" } }])[0].card_kind, "talk");
  assertEquals(wordBehaviours(null), []);
});
