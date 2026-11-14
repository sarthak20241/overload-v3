// deno test --allow-all lib/aiConnect.test.ts
import { assertEquals } from 'jsr:@std/assert';
import { MCP_HOST, MCP_URL, SHORT_STEPS, stepMarks } from './aiConnect.ts';

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
