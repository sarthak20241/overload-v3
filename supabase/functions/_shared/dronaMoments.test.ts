import { assertEquals } from "jsr:@std/assert@1";
import { decideMoment, type MomentCandidate, type MomentCardRow, type MomentPerson, momentWords } from "./dronaMoments.ts";

const TODAY = "2026-10-19";
const missed: MomentCandidate = { type: "missed_sessions", detail: { gap_days: 5, planned_per_week: 4, last_session_day: "2026-10-14" } };
const food: MomentCandidate = { type: "food_off", detail: { direction: "over", avg_pct: 134, days: [] } };
const ask: MomentCandidate = { type: "asked_for_a_change", detail: { change: "training_days", day: "2026-10-18" } };
const pr: MomentCandidate = {
  type: "pr",
  detail: { workout_id: "w1", prs: [{ exercise: "Bench Press", weight_kg: 80, reps: 6, prev_best_kg: 77.5 }] },
};
const pain: MomentCandidate = { type: "hurting", detail: { area: "knee", day: TODAY } };
const person = (candidates: MomentCandidate[], cards: MomentCardRow[] = [], over: Partial<MomentPerson> = {}): MomentPerson => ({
  user_id: "u1", today: TODAY, candidates, cards, mutes: [], hushed: false, ...over,
});
const moment = (topic: string, day: string, status = "pending"): MomentCardRow =>
  ({ slot: "moment", topic, status, moment_day: day, created_day: day });

Deno.test("the most important moment wins", () => {
  assertEquals(decideMoment(person([pr, food, missed, ask]))?.topic, "asked_for_a_change");
  assertEquals(decideMoment(person([pr, food, missed]))?.topic, "missed_sessions");
  assertEquals(decideMoment(person([pr, food]))?.topic, "food_off");
  assertEquals(decideMoment(person([])), null);
});

Deno.test("one moment a day, three a week; pain is never held back", () => {
  assertEquals(decideMoment(person([missed], [moment("pr", TODAY)])), null);
  assertEquals(decideMoment(person([missed], [moment("pr", "2026-10-18")]))?.topic, "missed_sessions");
  const three = [moment("pr", "2026-10-13"), moment("food_off", "2026-10-15"), moment("asked_for_a_change", "2026-10-17")];
  assertEquals(decideMoment(person([missed], three)), null);
  // The oldest of the three is 7 days back: out of the week.
  const outOfWeek = [moment("pr", "2026-10-12"), moment("food_off", "2026-10-15"), moment("asked_for_a_change", "2026-10-17")];
  assertEquals(decideMoment(person([missed], outOfWeek))?.topic, "missed_sessions");
  assertEquals(decideMoment(person([pain, missed], [...three, moment("pr", TODAY)]))?.topic, "hurting");
  // A pain moment today does not use up the day.
  assertEquals(decideMoment(person([missed], [moment("hurting", TODAY)]))?.topic, "missed_sessions");
});

Deno.test("nothing on the day a weekly card is still waiting, except pain", () => {
  const weekly: MomentCardRow = { slot: "weekly", topic: "goals_unclear", status: "pending", created_day: TODAY, deferred: false };
  assertEquals(decideMoment(person([missed], [weekly])), null);
  assertEquals(decideMoment(person([missed], [{ ...weekly, deferred: true }]))?.topic, "missed_sessions");
  assertEquals(decideMoment(person([missed], [{ ...weekly, created_day: "2026-10-18" }]))?.topic, "missed_sessions");
  assertEquals(decideMoment(person([pain], [weekly]))?.topic, "hurting");
});

Deno.test("cooldown: 2 weeks, 4 after Skip, any slot; then the next moment gets its turn", () => {
  assertEquals(decideMoment(person([missed, food], [moment("missed_sessions", "2026-10-08")]))?.topic, "food_off");
  assertEquals(decideMoment(person([missed], [moment("missed_sessions", "2026-10-05")]))?.topic, "missed_sessions");
  assertEquals(decideMoment(person([missed], [moment("missed_sessions", "2026-09-25", "dismissed")])), null);
  assertEquals(decideMoment(person([missed], [moment("missed_sessions", "2026-09-21", "dismissed")]))?.topic, "missed_sessions");
  const weeklyPain: MomentCardRow = { slot: "weekly", topic: "hurting", status: "pending", created_day: "2026-10-13" };
  assertEquals(decideMoment(person([pain], [weeklyPain])), null);
});

Deno.test("a 'topic:' mute and the quiet week are obeyed", () => {
  assertEquals(decideMoment(person([missed, food], [], { mutes: ["topic:missed_sessions"] }))?.topic, "food_off");
  const quiet = decideMoment(person([missed], [], { hushed: true }))!;
  assertEquals([quiet.kind, quiet.payload, quiet.body], ["notice", {}, "No session for 5 days."]);
});

Deno.test("the words: numbers from the detail, nothing invented", () => {
  const m = momentWords(missed)!;
  assertEquals([m.title, m.payload.action], ["5 days since your last session", "talk"]);
  assertEquals(momentWords(food)!.body, "Your last three days averaged 134% of your calorie target. Want to look at what is driving it?");
  assertEquals(momentWords({ type: "food_off", detail: { direction: "under", avg_pct: 62 } })!.title, "Three days well under target");
  const p = momentWords(pr)!;
  assertEquals([p.kind, p.title, p.body], ["notice", "New best: Bench Press",
    "Bench Press: 80 kg x 6, up from 77.5 kg. That is the work paying off."]);
  assertEquals((p.payload as Record<string, unknown>).workout_id, "w1");
  assertEquals(momentWords({ type: "pr", detail: { prs: [] } }), null);
  assertEquals(momentWords({ type: "missed_sessions", detail: {} }), null);
  assertEquals(momentWords(pain)!.title, "Look after that knee");
});

Deno.test("no words use an em dash, and chips stay short", () => {
  for (const c of [missed, food, ask, pr, pain, { type: "food_off", detail: { direction: "under", avg_pct: 62 } } as MomentCandidate]) {
    const w = momentWords(c)!;
    assertEquals(/—/.test(`${w.title} ${w.body} ${w.quiet ?? ""} ${w.payload.prompt ?? ""}`), false);
    for (const e of w.evidence) assertEquals(e.value.length <= 10, true, `${c.type}: ${e.value}`);
  }
});
