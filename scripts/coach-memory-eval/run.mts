/**
 * Does Drona call remember_fact when the user says something worth keeping,
 * and only then?
 *
 * One model turn per case, built with the real buildSystemPrompt and toolset
 * for that mode. Scored on the tool calls alone:
 *   save cases   at least one remember_fact, in the expected category
 *   skip cases   no remember_fact at all
 *
 * Why not the parse-meal CLI shim: it forces exactly ONE tool per reply. The
 * real coach runs with tool_choice auto and usually writes its reply AND calls
 * remember_fact in the same turn, so forcing one choice would push the model
 * to pick between talking and saving. Via the CLI this asks for
 * {reply, tool_calls[]} instead, which keeps both. Via the API it is a plain
 * tool_choice auto call, the same shape ai-coach sends.
 *
 * Held out: none of these messages appear in the prompt. Keep it that way.
 *
 *   EVAL_VIA_CLI=1 npx tsx scripts/coach-memory-eval/run.mts
 *   EVAL_VIA_CLI=1 REPEAT=3 ONLY=acl-chat npx tsx scripts/coach-memory-eval/run.mts
 *
 * Latency from a CLI run is meaningless.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../../supabase/functions/ai-coach/prompt.ts";

const MODEL = "claude-sonnet-4-6"; // ai-coach's MODEL
const VIA_CLI = process.env.EVAL_VIA_CLI === "1";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!VIA_CLI && !API_KEY) { console.error("Set EVAL_VIA_CLI=1 (subscription) or ANTHROPIC_API_KEY (ask first)."); process.exit(2); }
const REPEAT = Math.max(1, Number(process.env.REPEAT || "") || 2);
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const profile = {
  goal: "hypertrophy", experience_level: "intermediate", weekly_target_sessions: 4,
  weight_kg: 78, height_cm: 178, gender: "M", age_years: 29,
};
const today = { date: "2026-09-27", weekday: "Sunday", time_zone: "Asia/Kolkata" };

type Mode = "chat" | "discuss_program" | "live_workout";
interface Case {
  id: string;
  mode: Mode;
  message: string;
  /** Category the save should land in, or null when nothing should be saved. */
  expect: string | null;
}

const CASES: Case[] = [
  { id: "acl-chat", mode: "chat", expect: "injury",
    message: "I tore my ACL two years ago. It's fine now but I still get nervous going deep on squats. Can you suggest a leg day?" },
  { id: "equipment-chat", mode: "chat", expect: "equipment",
    message: "I've moved and now I only train at home, just adjustable dumbbells up to 32 kg and a bench. What should my push day look like?" },
  { id: "time-program", mode: "discuss_program", expect: "constraint",
    message: "I want a new program for the next 8 weeks. Weekdays I can never do more than 45 minutes, weekends I have as long as I want." },
  { id: "shoulder-live", mode: "live_workout", expect: "injury",
    message: "My left shoulder has been clicking on overhead press for a few weeks now, keep me off it for good." },
  { id: "history-q", mode: "chat", expect: null,
    message: "How has my bench been trending over the last month?" },
  { id: "sore-today", mode: "chat", expect: null,
    message: "Legs are a bit sore from yesterday, should I still train today?" },
];

interface ToolCall { name: string; input: Record<string, unknown> }

function systemText(system: unknown): string {
  return Array.isArray(system) ? system.map((b) => (b as { text?: string }).text ?? "").join("\n\n") : String(system);
}

function runClaude(system: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [
      "-p", "--output-format", "json", "--model", MODEL, "--system-prompt", system, "--max-turns", "1",
      // No tools of its own and no MCP servers: a native tool call ends the
      // one allowed turn as error_max_turns before any JSON comes back.
      "--tools", "", "--strict-mcp-config",
    ], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("claude -p timed out")); }, 180_000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(out) as { result?: string; is_error?: boolean; subtype?: string };
        if (env.is_error || code !== 0) return reject(new Error(`claude -p failed (${env.subtype}): ${String(env.result).slice(0, 300)}`));
        resolve(String(env.result ?? ""));
      } catch {
        reject(new Error(`claude -p exit ${code}: ${(out || err).slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

async function turnViaCli(system: unknown, tools: { name: string; description?: string; input_schema?: unknown }[], message: string): Promise<ToolCall[]> {
  const contract = [
    "## Output contract",
    "",
    "You are answering ONE turn. You may write a reply to the user, call any number of the functions below in the same turn (zero is fine), or both, exactly as you would with native tool use.",
    "",
    ...tools.flatMap((t) => [`### ${t.name}`, t.description ?? "", "Arguments JSON Schema:", JSON.stringify(t.input_schema), ""]),
    'Reply with ONLY this JSON object: {"reply": "<text to the user, may be empty>", "tool_calls": [{"name": "<function>", "input": {...}}]}',
    "No prose outside it, no code fence. Do not use any tools of your own.",
  ].join("\n");
  // The contract is repeated after the message: at the end of a ~20k-token
  // system prompt alone, the model sometimes answers in plain prose.
  const raw = await runClaude(
    `${systemText(system)}\n\n${contract}`,
    `USER: ${message}\n\n(Answer with the JSON object from the output contract only.)`,
  );
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (!json) throw new Error(`no JSON in reply: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(json) as { tool_calls?: ToolCall[] };
  return Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
}

async function turnViaApi(system: unknown, tools: unknown[], message: string): Promise<ToolCall[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system, tools, messages: [{ role: "user", content: message }] }),
  });
  const body = await res.json() as { content?: { type: string; name?: string; input?: Record<string, unknown> }[]; error?: unknown };
  if (!body.content) throw new Error(`API: ${JSON.stringify(body).slice(0, 300)}`);
  return body.content.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name ?? "", input: b.input ?? {} }));
}

async function runCase(c: Case): Promise<{ ok: boolean; note: string }> {
  const { system, tools } = buildSystemPrompt({ userContext: { profile, today }, mode: c.mode } as never);
  if (!tools.some((t) => t.name === "remember_fact")) return { ok: false, note: `remember_fact not offered in ${c.mode}` };
  const calls = VIA_CLI ? await turnViaCli(system, tools, c.message) : await turnViaApi(system, tools, c.message);
  const saves = calls.filter((t) => t.name === "remember_fact");
  const shown = calls.map((t) => t.name === "remember_fact" ? `remember_fact(${t.input.category}: ${t.input.key})` : t.name).join(", ") || "no tools";
  if (c.expect === null) return { ok: saves.length === 0, note: shown };
  const hit = saves.some((s) => s.input.category === c.expect);
  return { ok: hit, note: hit ? shown : `wanted a ${c.expect} save; got ${shown}` };
}

const cases = ONLY.length ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
const unknown = ONLY.filter((id) => !CASES.some((c) => c.id === id));
if (unknown.length || cases.length === 0) {
  console.error(`ONLY contains unknown cases: ${unknown.join(", ") || ONLY.join(", ")}`);
  process.exit(2);
}
let pass = 0;
let total = 0;
for (const c of cases) {
  const runs = await Promise.all(Array.from({ length: REPEAT }, () => runCase(c).catch((e) => ({ ok: false, note: String(e) }))));
  for (const r of runs) {
    total += 1;
    if (r.ok) pass += 1;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${c.id.padEnd(15)} ${r.note}`);
  }
}
console.log(`\n${pass}/${total} ${VIA_CLI ? "(via claude -p: correctness only, no latency)" : "(API)"}`);
process.exit(pass === total ? 0 : 1);
