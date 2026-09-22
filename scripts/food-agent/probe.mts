// Does the food agent make the right calls on multi-step messages?
//   npx tsx scripts/food-agent/probe.mts
//
// Routes Sonnet through `claude -p` (subscription, not API credit). Checks
// DECISIONS only: which tools, which foods, which numbers. Timings from the CLI
// mean nothing, and parallel execution is pinned by foodAgent.test.ts.
//
// The CLI has no tool calling, so each turn the tools are written into the
// system prompt and the model answers {"calls": [...]}, several calls allowed,
// which are re-wrapped as tool_use blocks for runFoodAgent.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { runFoodAgent, type FoodAgentDeps } from "../../supabase/functions/ai-coach/foodAgent.ts";
import type { ParseMealResult } from "../../supabase/functions/ai-coach/parseMeal.ts";

const TODAY = "Thursday 2026-09-24";
type Food = { food_name: string; quantity: number; serving_label: string; kcal: number; protein_g: number; carb_g: number; fat_g: number };
const f = (food_name: string, quantity: number, serving_label: string, kcal: number): Food =>
  ({ food_name, quantity, serving_label, kcal, protein_g: Math.round(kcal / 20), carb_g: Math.round(kcal / 8), fat_g: Math.round(kcal / 40) });

// days_ago -> meal -> foods
const DIARY: Record<number, Record<string, Food[]>> = {
  0: { lunch: [f("paneer tikka", 250, "g", 400), f("naan", 1, "piece", 260)] },
  1: {
    breakfast: [f("oats", 48, "g", 180), f("milk", 550, "ml", 370), f("cornflakes", 30, "g", 110), f("biscuits", 2, "piece", 140), f("rice", 1, "cup", 200)],
    lunch: [f("dal", 1, "katori", 150), f("rice", 1, "cup", 200), f("roti", 2, "piece", 240)],
  },
  3: { lunch: [f("rajma", 1, "bowl", 220), f("rice", 1.5, "cup", 300), f("salad", 1, "bowl", 40)] },
};
const DATES: Record<string, number> = { "2026-09-24": 0, "2026-09-23": 1, "2026-09-22": 2, "2026-09-21": 3 };

async function readDiary(input: Record<string, unknown>) {
  const d = typeof input.date === "string" ? DATES[input.date] ?? 99 : typeof input.days_ago === "number" ? input.days_ago : 0;
  const day = DIARY[d] ?? {};
  const meal = typeof input.meal_type === "string" ? input.meal_type : null;
  const meals = Object.entries(day).filter(([m]) => !meal || m === meal).map(([meal_type, foods]) => ({ meal_type, foods }));
  return { days_ago: d, meals };
}

function fakeParse(text: string): ParseMealResult {
  return {
    parsed: {
      meal_type: "snack",
      items: [{ food_id: null, food_name: text, quantity: 1, serving_label: "serving", grams: 100, kcal: 200, protein_g: 10, carb_g: 20, fat_g: 5, fiber_g: null, source: "estimate", assumption: null, confidence: "medium" }],
      drona_line: "",
    },
    declined: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 },
    tool_calls: [], steps: [], iterations: 1,
  };
}

// ── claude -p as a multi-call model ─────────────────────────────────────────

function runClaude(system: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith("CLAUDE_CODE_") || k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_BASE_URL") delete env[k];
    }
    const child = spawn("claude", [
      "-p", "--output-format", "json", "--model", "sonnet", "--system-prompt", system, "--max-turns", "1",
      "--disallowed-tools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite",
    ], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, 180_000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.stdin.end(stdin);
  });
}

function flatten(messages: unknown[]): string {
  return (messages as { role: string; content: unknown }[]).map((m) => {
    const label = m.role === "assistant" ? "Assistant" : "User";
    if (typeof m.content === "string") return `${label}: ${m.content}`;
    const parts = (m.content as Record<string, unknown>[]).map((b) =>
      b.type === "tool_use" ? `[called ${b.name} with ${JSON.stringify(b.input)}]`
      : b.type === "tool_result" ? `[result: ${b.content}]` : String(b.text ?? "")
    );
    return `${label}: ${parts.join("\n")}`;
  }).join("\n\n");
}

/** The first JSON object in `text` that has `key`, scanning brace by brace. */
function firstJsonWith(text: string, key: string): Record<string, unknown> {
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { const v = JSON.parse(text.slice(i, j + 1)); if (v && typeof v === "object" && key in v) return v; } catch { /* next */ }
        break;
      }
    }
  }
  throw new Error(`no JSON with "${key}" in: ${text.slice(0, 160)}`);
}

const callModel: FoodAgentDeps["callModel"] = async (body) => {
  const tools = body.tools as { name: string; description: string; input_schema: unknown }[];
  const system = [
    String(body.system),
    "",
    "## Output contract",
    "Answer ONLY with this JSON object: {\"calls\": [{\"tool\": \"<name>\", \"input\": {...}}]}.",
    "List several calls when they can run at the same time. No prose, no code fence. Do not use any tools.",
    "",
    ...tools.flatMap((t) => [`### ${t.name}`, t.description, JSON.stringify(t.input_schema), ""]),
  ].join("\n");
  let raw: string;
  try {
    raw = await runClaude(system, flatten(body.messages as unknown[]));
  } catch (e) {
    return { ok: false, status: 504, body: String(e) };
  }
  try {
    // stdout can carry more than one JSON value; the envelope is the one with `result`.
    const env = firstJsonWith(raw, "result") as { result?: string; usage?: unknown };
    const json = firstJsonWith(String(env.result ?? ""), "calls") as { calls?: unknown };
    const calls = (json.calls ?? []) as { tool: string; input: Record<string, unknown> }[];
    return {
      ok: true,
      data: {
        usage: env.usage ?? {},
        content: calls.map((c, i) => ({ type: "tool_use", id: `c${Date.now()}_${i}`, name: c.tool, input: c.input ?? {} })),
      },
    };
  } catch (e) {
    console.log(`   [cli] ${String(e).slice(0, 80)} ${raw.slice(0, 160)}`);
    return { ok: false, status: 502, body: `${String(e)} ${raw.slice(0, 200)}` };
  }
};

// ── Cases ───────────────────────────────────────────────────────────────────

type Out = Awaited<ReturnType<typeof runFoodAgent>>;
const names = (items: unknown) => ((items as { name?: string; food_name?: string }[]) ?? []).map((i) => (i.name ?? i.food_name ?? "").toLowerCase());
const kcalOf = (items: unknown, n: string) => ((items as Record<string, unknown>[]) ?? []).find((i) => String(i.name ?? i.food_name).toLowerCase().includes(n))?.kcal;

const CASES: { text: string; check: (o: Out) => string | null }[] = [
  {
    text: "please create my yesterday's oat meal that i had in breakfast as a meal and also log it in lunch today",
    check: (o) => {
      if (o.kind !== "create") return `want a save card, got ${o.kind}`;
      const n = names(o.create.input.items);
      if (!n.some((x) => x.includes("oat")) || !n.some((x) => x.includes("milk"))) return `missing oats/milk: ${n}`;
      if (n.some((x) => x.includes("biscuit") || x.includes("rice"))) return `took biscuits/rice: ${n}`;
      if (o.create.input.log_now !== true || o.create.input.meal_type !== "lunch") return "not set to log at lunch";
      if (kcalOf(o.create.input.items, "oat") !== 180) return `oats not copied: ${kcalOf(o.create.input.items, "oat")}`;
      return null;
    },
  },
  {
    text: "log the same breakfast as yesterday",
    check: (o) => {
      if (o.kind !== "log") return `want log, got ${o.kind}`;
      const total = o.result.parsed!.items.reduce((s, i) => s + i.kcal, 0);
      return total === 1000 ? null : `total ${total}, want 1000`;
    },
  },
  {
    text: "same lunch as Monday but half the rice",
    check: (o) => {
      if (o.kind !== "log") return `want log, got ${o.kind}`;
      const it = o.result.parsed!.items;
      const rice = it.find((i) => i.food_name.toLowerCase().includes("rice"))?.kcal;
      const rajma = it.find((i) => i.food_name.toLowerCase().includes("rajma"))?.kcal;
      return rajma === 220 && rice === 150 ? null : `rajma ${rajma} rice ${rice}`;
    },
  },
  {
    text: "save my poha from yesterday as a meal",
    check: (o) => (o.kind === "reply" ? null : `no poha anywhere, want a question, got ${o.kind}`),
  },
  {
    text: "turn today's lunch into a saved meal",
    check: (o) => {
      if (o.kind !== "create") return `want a save card, got ${o.kind}`;
      if (o.create.input.log_now !== false) return "log_now should be false: it is already logged";
      const n = names(o.create.input.items);
      return n.some((x) => x.includes("paneer")) && n.some((x) => x.includes("naan")) ? null : `items ${n}`;
    },
  },
  {
    text: "log yesterday's lunch again for dinner, without the roti",
    check: (o) => {
      if (o.kind !== "log") return `want log, got ${o.kind}`;
      const n = o.result.parsed!.items.map((i) => i.food_name.toLowerCase());
      if (o.result.parsed!.meal_type !== "dinner") return `meal ${o.result.parsed!.meal_type}`;
      return !n.some((x) => x.includes("roti")) && n.some((x) => x.includes("dal")) ? null : `items ${n}`;
    },
  },
];

async function one(c: (typeof CASES)[number]) {
  const statuses: string[] = [];
  const out = await runFoodAgent({ text: c.text, defaultMeal: "snack", today: TODAY }, {
    model: "sonnet", callModel, readDiary,
    savedMeals: async () => [],
    parseFood: async (t) => fakeParse(t),
    onStatus: (s) => statuses.push(s),
  });
  const err = out.kind === "failed" ? `failed: ${out.reason}` : c.check(out);
  if (out.kind === "failed" && out.reason.startsWith("http_")) lastErr.push(c.text);
  const turns = out.turns.map((t) => `[${t.tools.map((x) => x.name.replace("coach_list_", "")).join("+")}]`).join(" ");
  return { c, err, turns, statuses };
}

const lastErr: string[] = [];
let bad = 0;
for (let i = 0; i < CASES.length; i += 2) {
  for (const r of await Promise.all(CASES.slice(i, i + 2).map(one))) {
    if (r.err) bad++;
    console.log(`${r.err ? "XX" : "  "} ${r.c.text}\n     turns: ${r.turns}\n     status: ${r.statuses.join(" | ")}${r.err ? `\n     WHY: ${r.err}` : ""}`);
  }
}
console.log(`\n${CASES.length - bad}/${CASES.length} correct`);
