// Run with: deno test lib/foodBoxTour.test.ts
//
// lib/foodBoxTour.ts has no imports, so Deno can test it directly.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { shouldOfferTour, TOUR_COPY, tourNext, type TourStep } from "./foodBoxTour.ts";

const ready = {
  signedIn: true,
  done: false,
  isToday: true,
  dayReady: true,
  flowIdle: true,
  history: [{ logged_via: null }, { logged_via: "manual" }],
};

Deno.test("offers the tour to a signed-in user who has never typed a meal", () => {
  assert(shouldOfferTour(ready));
});

Deno.test("never offers it again once done", () => {
  assert(!shouldOfferTour({ ...ready, done: true }));
});

Deno.test("never offers it to someone who already logs with Drona", () => {
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
