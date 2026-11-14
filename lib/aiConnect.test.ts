// deno test --allow-all lib/aiConnect.test.ts
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { AI_APPS, CONNECT_STEPS, MCP_HOST, MCP_URL, SHORT_STEPS, TRY_ASKING, stepMarks } from './aiConnect.ts';

Deno.test('the connector link uses the public Overload MCP URL', () => {
  assertEquals(MCP_URL, 'https://mcp.tryoverload.app');
});

Deno.test('every app has three steps, long and short; no long dashes in any copy', () => {
  for (const a of AI_APPS) {
    assertEquals(CONNECT_STEPS[a.id].length, 3, a.id);
    assertEquals(SHORT_STEPS[a.id].length, 3, a.id);
  }
  const all = [
    ...Object.values(CONNECT_STEPS).flat(),
    ...Object.values(SHORT_STEPS).flat().flatMap((s) => [s.title, s.detail]),
    ...TRY_ASKING,
  ];
  for (const line of all) assert(!/[—–]/.test(line), line);
});

const base = { copied: false, copyFailed: false, opened: false, needsPlan: false };

Deno.test('a fresh screen lights step 1 only', () => {
  assertEquals(stepMarks(base), ['next', 'todo', 'todo']);
});

Deno.test('a copy marks step 1 done and lights step 2', () => {
  assertEquals(stepMarks({ ...base, copied: true }), ['done', 'next', 'todo']);
});

Deno.test('a failed copy still moves on to step 2, but never claims step 1', () => {
  assertEquals(stepMarks({ ...base, copyFailed: true }), ['todo', 'next', 'todo']);
});

Deno.test('opening the app lights step 3', () => {
  assertEquals(stepMarks({ ...base, copied: true, opened: true }), ['done', 'done', 'next']);
});

Deno.test('with no plan no step is lit', () => {
  assertEquals(stepMarks({ ...base, needsPlan: true }), ['todo', 'todo', 'todo']);
});

Deno.test('the step 1 card shows the same link that is copied', () => {
  assertEquals(`https://${MCP_HOST}`, MCP_URL);
  assertEquals(SHORT_STEPS.chatgpt[0].detail, MCP_HOST);
  assertEquals(SHORT_STEPS.claude[0].detail, MCP_HOST);
});
