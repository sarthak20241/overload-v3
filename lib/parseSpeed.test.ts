// deno test --allow-all --no-check --unstable-sloppy-imports --import-map=lib/coachConversations.test-import-map.json lib/parseSpeed.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  effectiveParseSpeed, getParseSpeed, parseSpeedWire, peekParseSpeed, setParseSpeed,
} from './parseSpeed.ts';

const KEY = 'overload.parseSpeed';

Deno.test('Precise without Pro runs as Quick, the one tier left', () => {
  assertEquals(effectiveParseSpeed('precise', false), 'quick');
  assertEquals(effectiveParseSpeed('precise', true), 'precise');
  assertEquals(effectiveParseSpeed('quick', false), 'quick');
});

Deno.test('every tier sends a speed: Quick is fast, Precise is super', () => {
  assertEquals(parseSpeedWire('quick'), 'fast');
  assertEquals(parseSpeedWire('precise'), 'super');
});

Deno.test('a phone that stored the retired Thorough reads as Quick', async () => {
  await AsyncStorage.setItem(KEY, 'thorough');
  assertEquals(await getParseSpeed(), 'quick');
  assertEquals(peekParseSpeed(), 'quick');
});

Deno.test('a pick is in memory at once and stored; Quick clears the key', async () => {
  const p = setParseSpeed('precise');
  // Read before the write settles: the other screen sees it on focus.
  assertEquals(peekParseSpeed(), 'precise');
  await p;
  assertEquals(await AsyncStorage.getItem(KEY), 'precise');
  await setParseSpeed('quick');
  assertEquals(await AsyncStorage.getItem(KEY), null);
  assertEquals(await getParseSpeed(), 'quick');
});

Deno.test('a pick made while a read is running is not undone by the read', async () => {
  await AsyncStorage.removeItem(KEY);
  const read = getParseSpeed();
  // The user taps Precise before the stored value (none: Quick) comes back.
  const write = setParseSpeed('precise');
  assertEquals(await read, 'precise');
  assertEquals(peekParseSpeed(), 'precise');
  await write;
});
