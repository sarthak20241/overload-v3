// deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/coachConversations.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { hydrateCoachConversations, listConversations, saveActiveMessages, startNewConversation } from './coachConversations.ts';

Deno.test('a topic chat is titled by its topic and counts only what the chat shows', async () => {
  const user = 'user_topic_test';
  await hydrateCoachConversations(user);
  startNewConversation(user);
  saveActiveMessages(user, [
    { id: 'c', role: 'user', content: '[OPENED FROM THE APP...] long hidden note', context: { title: 'Bench press stalled' } },
    { id: 'a', role: 'assistant', content: 'Hey, I looked at your bench.' },
  ], { immediate: true });
  const [chat] = listConversations(user);
  assertEquals(chat.title, 'Bench press stalled');
  assertEquals(chat.messageCount, 1);
});

Deno.test('the hidden topic turn survives a save, flag included', async () => {
  const user = 'user_topic_keep';
  await hydrateCoachConversations(user);
  startNewConversation(user);
  saveActiveMessages(user, [
    { id: 'c', role: 'user', content: 'NOTE', context: { title: 'T' } },
    { id: 'a', role: 'assistant', content: '' }, // streaming placeholder, dropped
  ], { immediate: true });
  const { getActiveMessages } = await import('./coachConversations.ts');
  assertEquals(getActiveMessages(user), [{ id: 'c', role: 'user', content: 'NOTE', context: { title: 'T' } }]);
});
