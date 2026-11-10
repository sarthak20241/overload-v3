// deno test --allow-all lib/chartScale.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { metricXScale } from './chartScale.ts';

Deno.test('one reading: the dot sits at the left edge and the goal ring at the program end', () => {
  // A single reading in week 3 of a 12-week program; pixels 4..394.
  const X = metricXScale({ x0: 4, x1: 394, xStart: 3, xNow: 3, xEnd: 12, readings: 1 });
  assertEquals(X(3), 4);
  assertEquals(X(12), 394);
  assertEquals(Math.round(X(7.5)), 199); // halfway to the end, halfway across
});

Deno.test('two or more readings get at least 58% of the width, then the rest runs to the end', () => {
  const X = metricXScale({ x0: 0, x1: 100, xStart: 3, xNow: 3.5, xEnd: 12, readings: 4 });
  assertEquals(X(3), 0);
  assertEquals(Math.round(X(3.5)), 58);
  assertEquals(X(12), 100);
});

Deno.test('readings that already cover more than 58% keep a plain linear scale', () => {
  const X = metricXScale({ x0: 0, x1: 100, xStart: 0, xNow: 9, xEnd: 12, readings: 10 });
  assertEquals(X(9), 75);
  assertEquals(X(12), 100);
  assertEquals(X(-2), 0); // clamped to the range
});
