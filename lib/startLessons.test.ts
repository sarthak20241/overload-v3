// Run with: deno test --allow-all --unstable-sloppy-imports lib/startLessons.test.ts
//
// Every getting-started step has a lesson, and the copy fits the card it is
// drawn on: one-line titles, two-line bodies, no em dashes.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { START_STEPS } from "./startGuide.ts";
import { LESSON_BODY_MAX, LESSON_TITLE_MAX, START_LESSONS } from "./startLessons.ts";

Deno.test("every step has a lesson of one to three cards", () => {
  for (const st of START_STEPS) {
    const l = START_LESSONS[st.id];
    assert(l, `no lesson for ${st.id}`);
    assert(l.pages.length >= 1 && l.pages.length <= 3, `${st.id} has ${l.pages.length} cards`);
    assert(l.cta.length > 0);
  }
  assertEquals(Object.keys(START_LESSONS).length, START_STEPS.length);
});

Deno.test("the copy fits its card and has no em dashes", () => {
  for (const [id, l] of Object.entries(START_LESSONS)) {
    for (const p of l.pages) {
      assert(p.title.length <= LESSON_TITLE_MAX, `${id}: title too long: ${p.title}`);
      assert(p.body.length <= LESSON_BODY_MAX, `${id}: body too long: ${p.body}`);
      for (const t of [p.title, p.body, l.cta]) assert(!t.includes("—"), `${id}: em dash in "${t}"`);
    }
  }
});
