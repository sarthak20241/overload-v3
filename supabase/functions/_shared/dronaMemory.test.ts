import { assertEquals } from "jsr:@std/assert@1";
import { catchMemory, type CatchDeps, GATE_YES, MAX_FACTS, type MemoryFactIn, readWriterCalls, writerSystem } from "./dronaMemory.ts";

const tool = (input: Record<string, unknown>) => ({ type: "tool_use", name: "remember_fact", input });

Deno.test("readWriterCalls: only valid facts, keys tidied, no duplicates, at most MAX_FACTS", () => {
  const facts = readWriterCalls([
    { type: "text", text: "saving" },
    tool({ category: "diet", key: "  Milk   Intolerance ", value: " Avoids  milk. " }),
    tool({ category: "diet", key: "milk intolerance", value: "a duplicate" }),
    tool({ category: "mood", key: "today", value: "tired" }),
    tool({ category: "injury", key: "", value: "no key" }),
    tool({ category: "injury", key: "knee", value: "x".repeat(301) }),
    { type: "tool_use", name: "forget_fact", input: { key: "diet" } },
    tool({ category: "schedule", key: "night shift", value: "Works nights." }),
    tool({ category: "equipment", key: "home", value: "Dumbbells." }),
    tool({ category: "preference", key: "running", value: "Hates running." }),
  ]);
  assertEquals(facts.map((f) => f.key), ["milk intolerance", "night shift", "home"].slice(0, MAX_FACTS));
  assertEquals(facts[0].value, "Avoids milk.");
  assertEquals(readWriterCalls(null), []);
});

Deno.test("writerSystem: shows current memory so a fact is updated, not copied", () => {
  const s = writerSystem([{ category: "diet", key: "diet type", value: "Vegetarian." }], "2026-10-19");
  assertEquals(s.includes("- diet / diet type: Vegetarian."), true);
  assertEquals(s.includes("today is 2026-10-19"), true);
  assertEquals(writerSystem([], "2026-10-19").includes("(nothing saved yet)"), true);
});

/** Jev and Anthropic behind one fake fetch: `gate` is Jev's noul, `writer` the model's content (or an HTTP status). */
function deps(gate: number | null, writer: unknown[] | number, saved: MemoryFactIn[] = [], over: Partial<CatchDeps> = {}) {
  const calls = { jev: 0, writer: 0 };
  const fetchFn = (async (url: string | URL) => {
    if (String(url).includes("typesafe.ai")) {
      calls.jev += 1;
      if (gate == null) return new Response("down", { status: 500 });
      return Response.json({ model: "jev-1.13.0", answers: { lasting: { type: "noul", noul: gate } }, usage: {} });
    }
    calls.writer += 1;
    if (typeof writer === "number") return new Response("err", { status: writer });
    return Response.json({ content: writer, usage: { input_tokens: 10, output_tokens: 5 } });
  }) as typeof fetch;
  const d: CatchDeps = {
    jev: { apiKey: "k", timeoutMs: 1000, fetchFn }, anthropicKey: "a", fetchFn, today: "2026-10-19",
    readMemory: async () => [],
    saveFact: async (f) => { saved.push(f); return true; },
    ...over,
  };
  return { d, calls };
}

Deno.test("catchMemory: a 'no' stops at Jev, with no writer call", async () => {
  const { d, calls } = deps(GATE_YES - 0.01, [tool({ category: "diet", key: "x", value: "y" })]);
  const r = await catchMemory("2 eggs and toast", "food_log", d);
  assertEquals([r.outcome, calls.jev, calls.writer], ["no", 1, 0]);
});

Deno.test("catchMemory: a yes at the line goes to the writer, and its facts are saved", async () => {
  const saved: MemoryFactIn[] = [];
  const { d, calls } = deps(GATE_YES, [tool({ category: "diet", key: "diet type", value: "Vegetarian." })], saved);
  const r = await catchMemory("i'm vegetarian", "food_log", d);
  assertEquals([r.outcome, r.saved, calls.writer, saved[0]?.key], ["saved", 1, 1, "diet type"]);
});

Deno.test("catchMemory: the writer may keep nothing", async () => {
  const { d } = deps(0.9, [{ type: "text", text: "" }]);
  assertEquals((await catchMemory("i train in the evening sometimes", "chat", d)).outcome, "nothing");
});

Deno.test("catchMemory: failures are 'failed' (the sweep retries them), never thrown", async () => {
  assertEquals((await catchMemory("i'm vegetarian", "chat", deps(null, []).d)).outcome, "failed");
  assertEquals((await catchMemory("i'm vegetarian", "chat", deps(0.9, 529).d)).outcome, "failed");
  // Facts written, none saved: failed, not "nothing to keep".
  const { d } = deps(0.9, [tool({ category: "diet", key: "diet type", value: "Vegetarian." })], [], {
    saveFact: async () => { throw new Error("db down"); },
  });
  assertEquals((await catchMemory("i'm vegetarian", "chat", d)).outcome, "failed");
});

Deno.test("catchMemory: under 3 characters is never asked about", async () => {
  const { d, calls } = deps(0.9, []);
  assertEquals([(await catchMemory(" ok ", "chat", d)).outcome, calls.jev], ["no", 0]);
});
