// Run with: deno test lib/foodBoxTour.test.ts
//
// lib/foodBoxTour.ts has no imports, so Deno can test it directly.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { shouldOfferTour, TOUR_COPY, tourEndReason, tourEndRetires, tourNext, tourSignalForFlow, type TourStep } from "./foodBoxTour.ts";

const ready = {
  signedIn: true,
  done: false,
  isToday: true,
  dayReady: true,
  flowIdle: true,
  historyLoaded: true,
  focused: true,
  history: [{ logged_via: null }, { logged_via: "manual" }],
};

Deno.test("offers the tour to a signed-in user with no typed meal in their recent history", () => {
  assert(shouldOfferTour(ready));
});

Deno.test("never offers it again once done", () => {
  assert(!shouldOfferTour({ ...ready, done: true }));
});

Deno.test("never offers it to someone who logged with Drona in their recent history", () => {
  assert(!shouldOfferTour({ ...ready, history: [{ logged_via: "manual" }, { logged_via: "ai" }] }));
  assert(!shouldOfferTour({ ...ready, history: [{ logged_via: "ai_auto" }] }));
});

Deno.test("waits for the day to load, for today, for the box to be free, and for a signed-in user", () => {
  assert(!shouldOfferTour({ ...ready, dayReady: false }));
  assert(!shouldOfferTour({ ...ready, isToday: false }));
  assert(!shouldOfferTour({ ...ready, flowIdle: false }));
  assert(!shouldOfferTour({ ...ready, signedIn: false }));
});

Deno.test("done is unknown until storage answers, and unknown is not an offer", () => {
  assert(!shouldOfferTour({ ...ready, done: null }));
});

Deno.test("never starts while the user is on another tab", () => {
  // Nutrition is a retained tab: it loads in the background.
  assert(!shouldOfferTour({ ...ready, focused: false }));
});

Deno.test("an empty history that has not loaded yet is not 'never typed a meal'", () => {
  assert(!shouldOfferTour({ ...ready, historyLoaded: false, history: [] }));
});

Deno.test("ends the tour when the user moves off today while it points at the box", () => {
  for (const step of ["type", "write", "retry"] as const) {
    assertEquals(tourEndReason(step, { isToday: false, history: ready.history }), "not_today");
  }
});

Deno.test("ends the tour when history shows they already log with Drona", () => {
  assertEquals(tourEndReason("type", { isToday: true, history: [{ logged_via: "ai" }] }), "uses_drona");
});

Deno.test("never ends a meal the user is in the middle of", () => {
  // Reading, the card, the last line: their own meal is mid-way, and their own
  // Add is what puts an 'ai' line in history.
  for (const step of ["reading", "review", "done"] as const) {
    assertEquals(tourEndReason(step, { isToday: false, history: [{ logged_via: "ai" }] }), null);
  }
});

Deno.test("keeps going while nothing changed", () => {
  assertEquals(tourEndReason("write", { isToday: true, history: ready.history }), null);
});

Deno.test("the happy path: tap the box, send, review, add", () => {
  let s: TourStep = "type";
  s = tourNext(s, "focused");
  assertEquals(s, "write");
  s = tourNext(s, "sent");
  assertEquals(s, "reading");
  s = tourNext(s, "review");
  assertEquals(s, "review");
  s = tourNext(s, "added");
  assertEquals(s, "done");
});

Deno.test("Just log it: the send itself logs, so the tour ends there", () => {
  assertEquals(tourNext("reading", "auto_logged"), "done");
});

Deno.test("a meal Drona could not read asks for another try, and the try carries on", () => {
  assertEquals(tourNext("reading", "declined"), "retry");
  assertEquals(tourNext("retry", "sent"), "reading");
});

Deno.test("a follow-up from the review card goes back to reading", () => {
  assertEquals(tourNext("review", "sent"), "reading");
});

Deno.test("an event that does not fit the step changes nothing", () => {
  assertEquals(tourNext("type", "added"), "type");
  assertEquals(tourNext("write", "review"), "write");
  assertEquals(tourNext("done", "focused"), "done");
});

Deno.test("every step the user can see has copy, written without em dashes", () => {
  for (const step of ["type", "write", "retry", "review", "done"] as const) {
    const c = TOUR_COPY[step];
    assert(c.title.length > 0 && c.body.length > 0, step);
    assert(!`${c.title}${c.body}`.includes("—"), `${step} has an em dash`);
  }
});

Deno.test("flow: a send from an idle box or a card is 'sent'", () => {
  assertEquals(tourSignalForFlow({ status: "idle" }, "analysing", false), { event: "sent" });
  assertEquals(tourSignalForFlow({ status: "review" }, "streaming", false), { event: "sent" });
});

Deno.test("flow: what a read turns into", () => {
  assertEquals(tourSignalForFlow({ status: "analysing" }, "review", false), { event: "review" });
  assertEquals(tourSignalForFlow({ status: "streaming" }, "declined", false), { event: "declined" });
  assertEquals(tourSignalForFlow({ status: "analysing" }, "error", false), { event: "declined" });
});

Deno.test("flow: Just log it sends finish the tour, a plain read that clears does not", () => {
  assertEquals(tourSignalForFlow({ status: "analysing", auto: true }, "idle", false), { event: "auto_logged" });
  assertEquals(tourSignalForFlow({ status: "streaming", auto: true }, "sent", false), { event: "auto_logged" });
  assertEquals(tourSignalForFlow({ status: "analysing" }, "idle", false), { end: "idle" });
  assertEquals(tourSignalForFlow({ status: "analysing" }, "create", false), { end: "create" });
});

Deno.test("flow: the card closing is Add only when Add closed it", () => {
  assertEquals(tourSignalForFlow({ status: "review" }, "idle", true), { event: "added" });
  assertEquals(tourSignalForFlow({ status: "review" }, "idle", false), { end: "discarded" });
});

Deno.test("flow: a review card that failed to add, then closed, ends the tour", () => {
  // Add failed (review -> error keeps the meal), then the user closed it.
  assertEquals(tourSignalForFlow({ status: "review" }, "error", false, "review"), null);
  assertEquals(tourSignalForFlow({ status: "error" }, "idle", false, "review"), { end: "discarded" });
  // A read Drona could not do, then closed: the tip still points at the box.
  assertEquals(tourSignalForFlow({ status: "error" }, "idle", false, "retry"), null);
});

Deno.test("moving off today only hides the tour; every other early end retires it", () => {
  assertEquals(tourEndRetires("not_today"), false);
  for (const r of ["search", "screen", "uses_drona", "discarded", "idle", "create", "sent"] as const) {
    assertEquals(tourEndRetires(r), true, r);
  }
  assertEquals(tourEndRetires(undefined), true);
});

Deno.test("flow: anything else says nothing", () => {
  assertEquals(tourSignalForFlow({ status: "analysing" }, "streaming", false), null);
  assertEquals(tourSignalForFlow({ status: "idle" }, "create", false), null);
  assertEquals(tourSignalForFlow({ status: "declined" }, "idle", false), null);
});
