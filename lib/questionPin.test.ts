// deno test --allow-all lib/questionPin.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { pinOffset, pinRoom, tailAfterReply } from './questionPin.ts';

const GAP = 12;
const SCREEN = 800;

Deno.test('the pin leaves a small gap above the question', () => {
  assertEquals(pinOffset(500, GAP), 488);
});

Deno.test('a question near the top pins at zero, never a negative offset', () => {
  assertEquals(pinOffset(4, GAP), 0);
});

Deno.test('the pin needs one screen of content under its offset', () => {
  assertEquals(pinRoom(500, GAP, SCREEN), 1288);
});

Deno.test('a short reply keeps the tail it still needs, so the question stays at the top', () => {
  // Question at 500, thread ends at 900: the pin needs 1288, so 388 of tail.
  assertEquals(tailAfterReply(900, 500, GAP, SCREEN), 388);
});

Deno.test('with the tail in place, the content is exactly the room the pin needs', () => {
  const threadEnd = 900;
  assertEquals(threadEnd + tailAfterReply(threadEnd, 500, GAP, SCREEN), pinRoom(500, GAP, SCREEN));
});

Deno.test('a reply taller than the screen needs no tail', () => {
  assertEquals(tailAfterReply(2400, 500, GAP, SCREEN), 0);
});

Deno.test('rows drawn after the reply ends (copy button, sources) shrink the tail', () => {
  assertEquals(tailAfterReply(960, 500, GAP, SCREEN), tailAfterReply(900, 500, GAP, SCREEN) - 60);
});
