import { assertEquals } from 'jsr:@std/assert';
import { luminance, orbTheme } from './orbTheme.ts';

Deno.test('no tint keeps the app theme', () => {
  assertEquals(orbTheme(undefined, 'dark'), 'dark');
  assertEquals(orbTheme(undefined, 'light'), 'light');
});

Deno.test('dark ink on a lime button fades toward white', () => {
  assertEquals(orbTheme('#0a0a0a', 'dark'), 'light');
});

Deno.test('white ink fades toward black', () => {
  assertEquals(orbTheme('#fff', 'light'), 'dark');
  assertEquals(orbTheme('#ffffff', 'light'), 'dark');
});

Deno.test('a mid grey keeps the app theme', () => {
  assertEquals(orbTheme('#8a8a93', 'dark'), 'dark');
  assertEquals(orbTheme('#8a8a93', 'light'), 'light');
});

Deno.test('alpha hex and rgb() are read, not dropped to the app theme', () => {
  assertEquals(orbTheme('#ffffffcc', 'light'), 'dark');
  assertEquals(orbTheme('#fffc', 'light'), 'dark');
  assertEquals(orbTheme('rgba(255, 255, 255, 0.8)', 'light'), 'dark');
  assertEquals(orbTheme('rgb(10,10,10)', 'dark'), 'light');
});

Deno.test('a color it cannot read keeps the app theme', () => {
  assertEquals(luminance('white'), null);
  assertEquals(luminance('rgb(300, 0, 0)'), null);
  assertEquals(orbTheme('transparent', 'dark'), 'dark');
});
