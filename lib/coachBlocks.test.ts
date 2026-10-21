// deno test --allow-all lib/coachBlocks.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { coachBlocksPlainText, parseCoachBlocks } from './coachBlocks.ts';

const BENCH_TABLE = `Your bench this month:

| Date | Exercise | Top set |
|------|----------|---------|
| Sep 1 | Bench Press | 80 kg |
| Oct 16 | Flat Bench Press | 82.5 kg |

Trending up.`;

Deno.test('a pipe table becomes a table, not text with pipes', () => {
  const blocks = parseCoachBlocks(BENCH_TABLE);
  assertEquals(blocks.map((b) => b.type), ['paragraph', 'table', 'paragraph']);
  const t = blocks[1];
  if (t.type !== 'table') throw new Error('expected a table');
  assertEquals(t.header, ['Date', 'Exercise', 'Top set']);
  assertEquals(t.rows.length, 2);
  // Number columns line up on the right; words stay left.
  assertEquals(t.align, ['left', 'left', 'right']);
});

Deno.test('a chart fence becomes a chart with numeric points', () => {
  const blocks = parseCoachBlocks('Here it is.\n\n```chart\n{"kind":"line","title":"Bench","unit":"kg","points":[["Sep 1",80],["Sep 8","82.5"]],"goal":85}\n```');
  const c = blocks[1];
  if (c.type !== 'chart') throw new Error('expected a chart');
  assertEquals(c.kind, 'line');
  assertEquals(c.points, [{ label: 'Sep 1', value: 80 }, { label: 'Sep 8', value: 82.5 }]);
  assertEquals(c.goal, 85);
});

Deno.test('a stats fence becomes stat tiles', () => {
  const blocks = parseCoachBlocks('```stats\n[{"label":"Volume","value":"4,915 kg","note":"+12%"},{"label":"Sets","value":18}]\n```');
  assertEquals(blocks, [{ type: 'stats', items: [
    { label: 'Volume', value: '4,915 kg', note: '+12%' },
    { label: 'Sets', value: '18', note: undefined },
  ] }]);
});

Deno.test('broken chart JSON is dropped, never shown as raw JSON', () => {
  const blocks = parseCoachBlocks('Look:\n\n```chart\n{"kind":"line","points":[["a",1]\n```\n\nDone.');
  assertEquals(blocks.map((b) => b.type), ['paragraph', 'paragraph']);
  assertEquals(blocks.some((b) => b.type === 'paragraph' && b.text.includes('{')), false);
});

Deno.test('while streaming, a half-written chart is a placeholder', () => {
  const blocks = parseCoachBlocks('Look:\n\n```chart\n{"kind":"line","poi', true);
  assertEquals(blocks.map((b) => b.type), ['paragraph', 'pending']);
});

Deno.test('while streaming, a table whose last row is arriving waits for it', () => {
  const partial = '| Date | Top set |\n|---|---|\n| Sep 1 | 80 |\n| Oct 1';
  const blocks = parseCoachBlocks(partial, true);
  const t = blocks[0];
  if (t.type !== 'table') throw new Error('expected a table');
  assertEquals(t.rows, [['Sep 1', '80']]);
});

Deno.test('a paragraph line followed by bullets keeps both', () => {
  const blocks = parseCoachBlocks('**Pull-ups**:\n- 8 reps\n- 6 reps\n\n1. first\n2. second');
  assertEquals(blocks.map((b) => b.type), ['paragraph', 'list', 'list']);
  const ordered = blocks[2];
  if (ordered.type !== 'list') throw new Error('expected a list');
  assertEquals(ordered.ordered, true);
});

Deno.test('copy text turns charts and tables into readable lines', () => {
  const text = coachBlocksPlainText('```chart\n{"kind":"bar","title":"Sets","points":[["Mon",9],["Wed",12]]}\n```\n\n' + BENCH_TABLE);
  assertEquals(text.includes('Sets: Mon 9, Wed 12'), true);
  assertEquals(text.includes('Sep 1 | Bench Press | 80 kg'), true);
  assertEquals(text.includes('```'), false);
});

Deno.test('a two-series line keeps both series, first one leading', () => {
  const blocks = parseCoachBlocks('```chart\n{"kind":"line","series":[{"name":"This month","points":[["W1",2100],["W2",2250]]},{"name":"Target","points":[["W1",2350],["W2",2350]]}]}\n```');
  const c = blocks[0];
  if (c.type !== 'chart') throw new Error('expected a chart');
  assertEquals(c.name, 'This month');
  assertEquals(c.points.map((p) => p.value), [2100, 2250]);
  assertEquals(c.compare?.name, 'Target');
  assertEquals(c.compare?.points.length, 2);
});

Deno.test('a donut keeps only positive slices and needs two', () => {
  const ok = parseCoachBlocks('```chart\n{"kind":"donut","unit":"g","points":[["Protein",105],["Carbs",172],["Fat",0]]}\n```');
  assertEquals(ok[0].type === 'chart' && ok[0].kind === 'donut' ? ok[0].points.length : -1, 2);
  const one = parseCoachBlocks('```chart\n{"kind":"donut","points":[["Protein",105]]}\n```');
  assertEquals(one.length, 0);
});

Deno.test('a progress fence needs a positive target per bar', () => {
  const blocks = parseCoachBlocks('```progress\n[{"label":"Protein","value":105,"target":115,"unit":"g"},{"label":"Steps","value":4000,"target":0}]\n```');
  assertEquals(blocks, [{ type: 'progress', items: [{ label: 'Protein', value: 105, target: 115, unit: 'g' }] }]);
  assertEquals(coachBlocksPlainText('```progress\n[{"label":"Protein","value":105,"target":115,"unit":"g"}]\n```'), 'Protein: 105 / 115 g');
});
