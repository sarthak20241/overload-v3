import { assert, assertEquals } from 'jsr:@std/assert@1';
import { AI_APPS, CONNECT_STEPS, MCP_URL, TRY_ASKING } from './aiConnect.ts';

Deno.test('the connector link uses the public Overload MCP URL', () => {
  assertEquals(MCP_URL, 'https://mcp.tryoverload.app');
});

Deno.test('every app has three steps; no long dashes in any copy', () => {
  for (const a of AI_APPS) assertEquals(CONNECT_STEPS[a.id].length, 3, a.id);
  const all = [...Object.values(CONNECT_STEPS).flat(), ...TRY_ASKING];
  for (const line of all) assert(!/[—–]/.test(line), line);
});
