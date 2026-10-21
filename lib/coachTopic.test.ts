// deno test --allow-all lib/coachTopic.test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { coachTopicContext, dronaCardTopic, insightTopic, isOpeningNarration, TOPIC_MARKER } from './coachTopic.ts';
import { sentTurns, type ChatTurn } from './coachTurns.ts';

Deno.test('topic context: Drona is told the user did not type it and speaks first', () => {
  const text = coachTopicContext(insightTopic({
    title: 'Bench press stalled',
    body: 'No new best in 4 sessions.',
    coachPrompt: "My bench hasn't improved in 4 sessions. Why?",
  }));
  assert(text.startsWith(TOPIC_MARKER));
  assert(text.includes('"Coach noticed" card'));
  assert(text.includes('- Bench press stalled'));
  assert(text.includes('- No new best in 4 sessions.'));
  assert(text.includes('You speak first'));
});

Deno.test('drona card topic carries the evidence and falls back to the title', () => {
  const t = dronaCardTopic({
    title: 'Three light days',
    body: 'You ate under target.',
    evidence: [{ label: 'Avg', value: '1,400 kcal' }],
    payload: {},
  });
  assertEquals(t.facts, ['Your card said: Three light days. You ate under target.', 'Avg: 1,400 kcal']);
  assertEquals(t.ask, 'Three light days');
});

const ctx: ChatTurn = { id: 'c', role: 'user', content: 'CONTEXT', context: { title: 'T' } };

Deno.test('topic opening: only the hidden context goes, as a user turn', () => {
  assertEquals(sentTurns([ctx], { maxTurns: 24 }), [{ role: 'user', content: 'CONTEXT' }]);
});

Deno.test('topic follow-up keeps Drona\'s opening reply after the context', () => {
  const chat: ChatTurn[] = [ctx, { id: 'a', role: 'assistant', content: 'Hi' }, { id: 'u', role: 'user', content: 'why?' }];
  assertEquals(sentTurns(chat, { maxTurns: 24 }).map((t) => t.content), ['CONTEXT', 'Hi', 'why?']);
});

Deno.test('topic context stays pinned when the window slides past it', () => {
  const chat: ChatTurn[] = [ctx];
  for (let i = 0; i < 10; i++) {
    chat.push({ id: `a${i}`, role: 'assistant', content: `a${i}` }, { id: `u${i}`, role: 'user', content: `u${i}` });
  }
  const sent = sentTurns(chat, { maxTurns: 4 });
  assertEquals(sent.map((t) => t.content), ['CONTEXT', 'a8', 'u8', 'a9', 'u9']);
});

Deno.test('plain chat: the greeting is dropped so the first turn is the user', () => {
  const chat: ChatTurn[] = [{ id: '1', role: 'assistant', content: 'greeting' }, { id: 'u', role: 'user', content: 'hey' }];
  assertEquals(sentTurns(chat, { maxTurns: 24 }), [{ role: 'user', content: 'hey' }]);
});

Deno.test('workout review opening sends the recap alone, never the app greeting', () => {
  const chat: ChatTurn[] = [{ id: 'wc-starter', role: 'assistant', content: 'Session logged' }];
  const sent = sentTurns(chat, { maxTurns: 24, workoutOpener: 'RECAP', skipIds: ['wc-starter'] });
  assertEquals(sent, [{ role: 'user', content: 'RECAP' }]);
});

Deno.test('workout review follow-up: recap, the review, then the question', () => {
  const chat: ChatTurn[] = [
    { id: 'wc-starter', role: 'assistant', content: 'Session logged' },
    { id: 'r', role: 'assistant', content: 'REVIEW' },
    { id: 'u', role: 'user', content: 'and legs?' },
  ];
  const sent = sentTurns(chat, { maxTurns: 24, workoutOpener: 'RECAP', skipIds: ['wc-starter'] });
  assertEquals(sent.map((t) => t.content), ['RECAP', 'REVIEW', 'and legs?']);
});

Deno.test('live workout is unchanged: recap then the typed question', () => {
  const chat: ChatTurn[] = [
    { id: 'wc-starter', role: 'assistant', content: "You're 10 min in" },
    { id: 'u', role: 'user', content: 'go heavier?' },
  ];
  const sent = sentTurns(chat, { maxTurns: 24, workoutOpener: 'RECAP', skipIds: ['wc-starter'] });
  assertEquals(sent.map((t) => t.content), ['RECAP', 'go heavier?']);
});

Deno.test('opening narration: the lines Drona wrote before his tools are dropped', () => {
  // Seen on the simulator, 2026-10-21.
  assert(isOpeningNarration('Let me pull the actual history before I say anything.'));
  assert(isOpeningNarration('Let me check the numbers first.'));
  assert(isOpeningNarration('Five PRs in one week is worth a look, so let me pull up what actually moved.'));
  assert(isOpeningNarration("Coach Drona here. I saw the Weighted Pull Ups stall, so I'm pulling your history to check what changed."));
});

Deno.test('opening narration: a bare greeting or real content is kept', () => {
  assert(!isOpeningNarration('Hey, your bench stalled.'));
  assert(!isOpeningNarration('Your bench stalled, worth a look.'));
  assert(!isOpeningNarration("I'll keep this short: your bench stalled."));
  assert(!isOpeningNarration('Looking at your bench, it has stalled.'));
  assert(!isOpeningNarration("I'm looking at your bench and it stalled."));
  assert(!isOpeningNarration('Let me say it plainly: your bench stalled.'));
  assert(!isOpeningNarration('Hey, time to check in on your pull-ups. Want to review them?'));
  assert(!isOpeningNarration(''));
  assert(!isOpeningNarration('Let me check.\n\nYour bench has been flat for 4 weeks.'));
  assert(!isOpeningNarration(`Let me check ${'x'.repeat(200)}`));
});

Deno.test('a window that starts on a user turn keeps the context first', () => {
  // A stopped turn can leave two user turns in a row; the API merges them.
  const chat: ChatTurn[] = [
    ctx,
    { id: 'a', role: 'assistant', content: 'Hi' },
    { id: 'u1', role: 'user', content: 'first' },
    { id: 'u2', role: 'user', content: 'second' },
  ];
  assertEquals(sentTurns(chat, { maxTurns: 2 }).map((t) => t.content), ['CONTEXT', 'first', 'second']);
});

Deno.test('topic context skips a missing fact instead of throwing', () => {
  const text = coachTopicContext({
    source: 'readiness',
    title: 'Readiness 72',
    facts: ['Readiness today: 72 (moderate).', undefined as unknown as string],
    ask: 'Should I train as planned?',
  });
  assert(text.includes('- Readiness today: 72 (moderate).'));
  assert(!text.includes('undefined'));
});

Deno.test('a runaway fact is cut short', () => {
  const text = coachTopicContext({ source: 'insight', title: 'T', facts: ['x'.repeat(5000)], ask: 'Why?' });
  assert(text.length < 2000);
});
