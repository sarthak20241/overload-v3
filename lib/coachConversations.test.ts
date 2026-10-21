// deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/coachConversations.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  ensureActiveConversationId, hydrateCoachConversations, listConversations, saveActiveMessages, startNewConversation,
} from './coachConversations.ts';

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

Deno.test('a topic opened over an old chat sends under the NEW conversation id', async () => {
  // The topic effect calls startNewChat() and then handleSend in the same tick;
  // handleSend reads the id through ensureActiveConversationId.
  const user = 'user_topic_id';
  await hydrateCoachConversations(user);
  const old = ensureActiveConversationId(user);
  saveActiveMessages(user, [{ id: 'u', role: 'user', content: 'old chat' }], { immediate: true });
  const fresh = startNewConversation(user);
  assertEquals(ensureActiveConversationId(user), fresh.id);
  assertEquals(fresh.id === old, false);
});
