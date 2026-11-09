import { assertEquals } from 'jsr:@std/assert@1';
import { BUILD_IT, asksToBuild, isPureAffirmative } from './coachAffirm.ts';

Deno.test('the Build it button text forces the build', () => {
  assertEquals(isPureAffirmative(BUILD_IT), true);
});

Deno.test('a plain yes forces; a yes with a change does not', () => {
  assertEquals(isPureAffirmative('yes'), true);
  assertEquals(isPureAffirmative('yep build it'), true);
  assertEquals(isPureAffirmative('yes but bump volume'), false);
  assertEquals(isPureAffirmative(''), false);
});

Deno.test('Build it shows only under a question about building', () => {
  assertEquals(asksToBuild("That's a 10-week cut in 3 blocks. Want me to build it now, or adjust the shape first?"), true);
  assertEquals(asksToBuild('Phases below.\n\nShall I build this program?'), true);
  // Clarifying questions: the plan is not agreed yet.
  assertEquals(asksToBuild('Before I lay it out: how many days a week can you train?'), false);
  assertEquals(asksToBuild('Do you have a race on a set day? I can build around it.'), false);
  assertEquals(asksToBuild('Here is the plan.'), false);
  // "build" that is not about building the plan.
  assertEquals(asksToBuild('Do you want to build up your legs first?'), false);
  assertEquals(asksToBuild('Ready? Should I build the program as written?'), true);
  assertEquals(asksToBuild(null), false);
});
