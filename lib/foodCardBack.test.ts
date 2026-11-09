// Run with: deno test --allow-all lib/foodCardBack.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { withBack, stepBack, boxAfterBack, backDepth, cancelPlan, arrivalAfter, BACK_STEPS, type CardBack } from './foodCardBack.ts';

type Card = { items: string[]; before?: CardBack<Card> };

/** A chat: the first message, then each follow-up adds one line. */
function chat(messages: string[], max?: number): Card {
  let card: Card = withBack({ items: [messages[0]] }, null, max);
  for (const m of messages.slice(1)) {
    card = withBack({ items: [...card.items, m] }, { review: card, turns: [], last: m }, max);
  }
  return card;
}

Deno.test('the arrow after a follow-up gives back only that message, and the card before it', () => {
  const card = chat(['2 boiled eggs', 'and a banana']);
  const back = stepBack(card)!;
  assertEquals(back.last, 'and a banana');
  assertEquals(back.review.items, ['2 boiled eggs']);
});

Deno.test('the arrow on the first message starts over', () => {
  assertEquals(stepBack(chat(['2 boiled eggs'])), null);
});

Deno.test('each tap goes back one more message', () => {
  const one = stepBack(chat(['eggs', 'banana', 'coffee']))!;
  assertEquals([one.last, one.review.items], ['coffee', ['eggs', 'banana']]);
  const two = stepBack(one.review)!;
  assertEquals([two.last, two.review.items], ['banana', ['eggs']]);
  assertEquals(stepBack(two.review), null);
});

Deno.test('the chat turns go back to before the message', () => {
  const first: Card = withBack({ items: ['eggs'] }, null);
  const turns = [{ role: 'user' as const, text: 'eggs' }, { role: 'drona' as const, text: 'Here it is.' }];
  const card = withBack({ items: ['eggs', 'banana'] }, { review: first, turns, last: 'banana' });
  assertEquals(stepBack(card)!.turns, turns);
});

Deno.test('a long chat keeps only the last BACK_STEPS steps', () => {
  const msgs = Array.from({ length: BACK_STEPS + 5 }, (_, i) => `food ${i}`);
  assertEquals(backDepth(chat(msgs)), BACK_STEPS);
  assertEquals(backDepth(chat(msgs, 2)), 2);
  assertEquals(backDepth(chat(['a', 'b', 'c'])), 2);
});

Deno.test('a half-typed follow-up rides after the words, not over them', () => {
  assertEquals(boxAfterBack('and a banana', ''), 'and a banana');
  assertEquals(boxAfterBack('and a banana', '  no sugar '), 'and a banana, no sugar');
});

Deno.test('cancel on a follow-up goes back to the card and its chat; on a first message the meal goes', () => {
  const first: Card = withBack({ items: ['eggs'] }, null);
  const turns = [{ role: 'user' as const, text: 'eggs' }];
  const back = { review: first, turns, last: 'and a banana' };
  assertEquals(cancelPlan(true, back), { kind: 'back', review: first, turns });
  assertEquals(cancelPlan(true, null), { kind: 'discard' });
  // Nothing in flight: the X is a Discard, even with a step stored.
  assertEquals(cancelPlan(false, back), { kind: 'discard' });
});

Deno.test('a cancel is not an arrival, and the flag is used once', () => {
  assertEquals(arrivalAfter(true), { show: false, cancelled: false });
  assertEquals(arrivalAfter(false), { show: true, cancelled: false });
});

Deno.test('a reply that left the card as it was still gives its message back', () => {
  const first: Card = withBack({ items: ['eggs'] }, null);
  const replied = withBack({ items: ['eggs'] }, { review: first, turns: [], last: 'is that right?' });
  const back = stepBack(replied)!;
  assertEquals([back.last, back.review.items], ['is that right?', ['eggs']]);
});
