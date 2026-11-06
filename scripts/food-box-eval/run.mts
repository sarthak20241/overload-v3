// Food box eval runner.
//
//   npx tsx scripts/food-box-eval/run.mts
//
// ADAPTER=recorded (default): grades what the live food box actually served
// for each case, as stored in cases.ts from parse_traces. No model call, no
// network, no cost. Recordings come from the code live on their day, so a
// later fix does not show here.
//
// ADAPTER=live: runs today's food box code on each case (live.ts), with the
// case's saved meals, memory and diary. Always with EVAL_VIA_CLI=1 (owner
// rule). It reads the live catalog and writes nothing.
//
//   EVAL_VIA_CLI=1 ADAPTER=live npx tsx scripts/food-box-eval/run.mts
//
// Options: ONLY=id,id  TAG=correction  VERBOSE=1 (print passing checks too)
//          EVAL_CONCURRENCY=6 (live only; keep CLI runs at 6-8)
//          WRITE_BASELINE=1 (rewrite this adapter's section of BASELINE.md)
//          MIN_PASS=30 (exit 1 when fewer cases pass; for a future CI gate.
//          Without it the run always exits 0.)

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { CASES } from "./cases.ts";
import { grade } from "./grade.ts";
import type { FoodBoxCase, Grade, Outcome } from "./types.ts";

export interface Adapter {
  name: string;
  /** null = this adapter cannot run this case (it is skipped, not failed). */
  run(c: FoodBoxCase): Promise<Outcome | null>;
}

const recorded: Adapter = {
  name: "recorded",
  run: (c) => Promise.resolve(c.recorded ?? null),
};

/** Loaded only when asked for: it pulls in the whole pipeline. */
async function liveAdapter(): Promise<Adapter> {
  const m = await import("./live.ts");
  const why = m.liveReady();
  if (why) {
    console.error(why);
    process.exit(1);
  }
  return { name: m.liveName(), run: (c) => m.runLive(c) };
}

const ADAPTERS: Record<string, () => Promise<Adapter>> = { recorded: async () => recorded, live: liveAdapter };

const env = (k: string) => process.env[k] ?? "";
const adapter = await ADAPTERS[env("ADAPTER") || "recorded"]?.();
if (!adapter) {
  console.error(`Unknown ADAPTER "${env("ADAPTER")}". Known: ${Object.keys(ADAPTERS).join(", ")}`);
  process.exit(1);
}
const ONLY = env("ONLY") ? new Set(env("ONLY").split(",").map((s) => s.trim())) : null;
const TAG = env("TAG") || null;
const VERBOSE = env("VERBOSE") === "1";

const picked = CASES.filter((c) => (!ONLY || ONLY.has(c.id)) && (!TAG || c.tags.includes(TAG)));
// A typo in ONLY or TAG must not look like a clean run.
const unknownIds = ONLY ? [...ONLY].filter((id) => !CASES.some((c) => c.id === id)) : [];
if (picked.length === 0 || unknownIds.length > 0) {
  console.error(
    picked.length === 0 ? "No case matches ONLY / TAG." : `Unknown case id(s): ${unknownIds.join(", ")}.`,
  );
  process.exit(1);
}
// Checked before anything runs or is written: a bad value must not leave a
// rewritten BASELINE.md behind, and a gate that silently turns itself off is
// worse than no gate.
const minPass = env("MIN_PASS") ? Number(env("MIN_PASS")) : null;
if (minPass !== null && !(Number.isInteger(minPass) && minPass >= 0)) {
  console.error(`MIN_PASS must be a whole number, got "${env("MIN_PASS")}".`);
  process.exit(1);
}
// The baseline is the whole set. A filtered run must never overwrite it.
if (env("WRITE_BASELINE") === "1" && (ONLY || TAG)) {
  console.error("WRITE_BASELINE=1 cannot be combined with ONLY or TAG: BASELINE.md covers every case.");
  process.exit(1);
}

const CONCURRENCY = adapter.name !== "recorded" ? Math.max(1, Number(env("EVAL_CONCURRENCY") || "6") || 6) : 1;
const results: { c: FoodBoxCase; g: Grade | null; ms: number }[] = new Array(picked.length);
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= picked.length) return;
    const c = picked[i];
    const t0 = Date.now();
    try {
      const out = await adapter.run(c);
      results[i] = { c, g: out ? grade(c, out) : null, ms: Date.now() - t0 };
    } catch (e) {
      // A case that throws is a failure with its reason, never a crashed run.
      results[i] = {
        c,
        g: { id: c.id, pass: false, checks: [{ name: "adapter error", pass: false, detail: String(e).slice(0, 300) }] },
        ms: Date.now() - t0,
      };
    }
    if (adapter.name !== "recorded") {
      const r = results[i];
      console.log(`  [${i + 1}/${picked.length}] ${r.g?.pass ? "pass" : r.g ? "FAIL" : "skip"}  ${c.id}  (${Math.round(r.ms / 1000)}s)`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, worker));

const ran = results.filter((r) => r.g);
const passed = ran.filter((r) => r.g!.pass);
console.log(`\nFood box eval, adapter=${adapter.name}: ${passed.length}/${ran.length} passed, ${results.length - ran.length} skipped (no ${adapter.name} outcome)\n`);

for (const { c, g } of results) {
  if (!g) {
    console.log(`  SKIP  ${c.id}`);
    continue;
  }
  console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${c.id}  [${c.tags.join(", ")}]`);
  for (const k of g.checks) {
    if (!k.pass || VERBOSE) console.log(`          ${k.pass ? "ok " : "x  "} ${k.name}${k.detail ? `  (${k.detail})` : ""}`);
  }
}

// Per tag: where the failures cluster.
const tags = new Map<string, { pass: number; ran: number }>();
for (const { c, g } of ran) {
  for (const t of c.tags) {
    const v = tags.get(t) ?? { pass: 0, ran: 0 };
    v.ran++;
    if (g!.pass) v.pass++;
    tags.set(t, v);
  }
}
const tagRows = [...tags].sort((a, b) => a[0].localeCompare(b[0]));
console.log("\nBy tag:");
for (const [t, v] of tagRows) console.log(`  ${t.padEnd(14)} ${v.pass}/${v.ran}`);

if (env("WRITE_BASELINE") === "1") {
  const intro = adapter.name === "recorded"
    ? [
      `Generated by \`WRITE_BASELINE=1 npx tsx scripts/food-box-eval/run.mts\`.`,
      "",
      "Grades what the live food box served on the day of each message",
      "(parse_traces, 2026-10-02 to 2026-11-05). It is not a run of today's main: a later fix",
      "shows only in the live section below.",
      "",
      `**${passed.length} of ${ran.length} recorded cases pass.** ${results.length - ran.length} cases have no recording (synthetic, or replayed in a state the app never showed).`,
    ]
    : [
      `Generated by \`${adapter.name === "live_threads" ? "FOOD_THREADS=on " : ""}EVAL_VIA_CLI=1 ADAPTER=live WRITE_BASELINE=1 npx tsx scripts/food-box-eval/run.mts\`,`,
      `on ${new Date().toISOString().slice(0, 10)}, from commit ${gitHead()}.`,
      "",
      "Runs today's food box code (Precise) on each case with the case's fixtures (live.ts).",
      adapter.name === "live_threads"
        ? "With the thread store on (FOOD_THREADS=on): earlier cards are in the thread, and the agent has restore_card."
        : "Thread store off, as live today: earlier cards are not sent.",
      `Model calls ${env("EVAL_VIA_CLI") === "1" ? "through the Claude CLI: times are the CLI's, not the pipeline's" : "through the API"}.`,
      `Web label lookup ${env("EVAL_WEB") === "1" ? "on (Tavily)" : "off"}. Models answer differently run to run, so a case near a range edge can flip.`,
      "",
      `**${passed.length} of ${ran.length} cases pass.** On the ${ran.filter((r) => r.c.recorded).length} cases that have a recording: ` +
      `${passed.filter((r) => r.c.recorded).length} pass (the recorded section above is the same cases as served on the day).`,
    ];
  const lines = [
    `<!-- adapter:${adapter.name} -->`,
    `## Adapter: \`${adapter.name}\``,
    "",
    ...intro,
    "",
    "| Tag | Passed |",
    "|---|---|",
    ...tagRows.map(([t, v]) => `| ${t} | ${v.pass}/${v.ran} |`),
    "",
    "| Case | Result | Failed checks |",
    "|---|---|---|",
    ...results.map(({ c, g }) =>
      `| ${c.id} | ${!g ? "no recording" : g.pass ? "pass" : "FAIL"} | ${
        g ? g.checks.filter((k) => !k.pass).map((k) => k.name.replace(/\|/g, "/")).join("; ") : ""
      } |`
    ),
    `<!-- /adapter:${adapter.name} -->`,
  ];
  writeBaselineSection(adapter.name, lines.join("\n"));
  console.log(`\nWrote the ${adapter.name} section of scripts/food-box-eval/BASELINE.md`);
}

/** BASELINE.md holds one section per adapter. A run rewrites its own section
 *  and keeps the others, recorded first. */
function writeBaselineSection(name: string, section: string) {
  const url = new URL("./BASELINE.md", import.meta.url);
  let old = "";
  try { old = readFileSync(url, "utf8"); } catch { /* new file */ }
  const sections = new Map<string, string>();
  for (const m of old.matchAll(/<!-- adapter:(\w+) -->[\s\S]*?<!-- \/adapter:\1 -->/g)) sections.set(m[1], m[0]);
  sections.set(name, section);
  const known = ["recorded", "live", "live_threads"];
  const order = [...known, ...[...sections.keys()].filter((k) => !known.includes(k))];
  const body = order.filter((k) => sections.has(k)).map((k) => sections.get(k)).join("\n\n");
  const head = [
    "# Food box eval baseline",
    "",
    "One section per adapter. The false-claim check uses the live `claimsAction`",
    "(`supabase/functions/ai-coach/foodIntent.ts`): a change there can move a score with no change to the cases.",
    "",
  ].join("\n");
  writeFileSync(url, `${head}\n${body}\n`);
}

function gitHead(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

if (minPass !== null && passed.length < minPass) {
  console.error(`\n${passed.length} passed, below MIN_PASS=${minPass}.`);
  process.exit(1);
}
