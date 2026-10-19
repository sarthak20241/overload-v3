import { assertEquals } from "jsr:@std/assert@1";
import { splitCardSpace, type CardSpace } from "./mealCardSplit.ts";

const split = (over: Partial<CardSpace>) =>
  splitCardSpace({ space: 600, listContent: 300, noticeContent: 100, listFloor: 88, noticeFloor: 18, ...over });

Deno.test("room to spare: the note is whole and the list takes the rest", () => {
  assertEquals(split({ space: 600 }), { list: 500, notice: 100 });
  assertEquals(split({ space: 400 }), { list: 300, notice: 100 });
});

Deno.test("short: the list gives way first, the note keeps its words", () => {
  assertEquals(split({ space: 250 }), { list: 150, notice: 100 });
  assertEquals(split({ space: 188 }), { list: 88, notice: 100 });
});

Deno.test("shorter: the list holds its floor and the note scrolls down to a line", () => {
  assertEquals(split({ space: 150 }), { list: 88, notice: 62 });
  assertEquals(split({ space: 106 }), { list: 88, notice: 18 });
});

Deno.test("not even the floors fit: the two never take more than the space, so Add stays on the card", () => {
  assertEquals(split({ space: 90 }), { list: 72, notice: 18 });
  assertEquals(split({ space: 10 }), { list: 0, notice: 10 });
  assertEquals(split({ space: -40 }), { list: 0, notice: 0 });
  for (const space of [0, 5, 18, 50, 105]) {
    const { list, notice } = split({ space });
    assertEquals(list + notice, space);
  }
});

Deno.test("no note: the list has it all", () => {
  assertEquals(split({ space: 200, noticeContent: 0 }), { list: 200, notice: 0 });
  assertEquals(split({ space: 40, noticeContent: 0 }), { list: 40, notice: 0 });
});

Deno.test("a short list or note is its own floor", () => {
  assertEquals(split({ space: 60, listContent: 50, noticeContent: 10 }), { list: 50, notice: 10 });
  assertEquals(split({ space: 55, listContent: 50, noticeContent: 10 }), { list: 45, notice: 10 });
});
