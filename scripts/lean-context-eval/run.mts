/**
 * Lean chat context: does Drona fetch a held-back section when the question
 * needs it, and leave the tool alone when the summary already answers?
 *
 * One model turn per case, built with the real buildSystemPrompt and
 * leanUserContext, against a made-up user (never a real account). Two arms:
 *   lean  the summary + coach_get_user_details (what chat now sends)
 *   full  the whole context, as before, for comparison
 *
 *   EVAL_VIA_CLI=1 npx tsx scripts/lean-context-eval/run.mts            # subscription, via claude -p
 *   ANTHROPIC_API_KEY=... npx tsx scripts/lean-context-eval/run.mts     # API credit; ask first
 *   Composable: REPEAT=3  ONLY=case-a,case-b  ARMS=lean
 *
 * Latency from a CLI run is meaningless.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../../supabase/functions/ai-coach/prompt.ts";
import { leanUserContext } from "../../supabase/functions/ai-coach/userContextLean.ts";
import { SONNET_MODEL, SONNET_SETTINGS } from "../../supabase/functions/_shared/sonnet.ts";

const MODEL = SONNET_MODEL;
const VIA_CLI = process.env.EVAL_VIA_CLI === "1";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!VIA_CLI && !API_KEY) { console.error("Set EVAL_VIA_CLI=1 (subscription) or ANTHROPIC_API_KEY (ask first)."); process.exit(2); }
const REPEAT = Math.max(1, Number(process.env.REPEAT || "") || 2);
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ARMS = (process.env.ARMS ?? "lean,full").split(",").map((s) => s.trim()).filter(Boolean) as Arm[];
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY || "") || 6);

// ── A made-up user with enough history that every section is held back ──────
const ex = (name: string, muscle: string, sets: number, reps: string) => ({ name, muscle, sets, reps, rest_s: 120 });
const ROUTINES = [
  { name: "Upper A", description: "Heavy upper", exercises: [ex("Barbell Bench Press", "chest", 4, "5-7"), ex("Weighted Pull-Up", "back", 4, "5-7"), ex("Seated Dumbbell Press", "shoulders", 3, "8-10"), ex("Chest-Supported Row", "back", 3, "8-10")] },
  { name: "Lower A", description: "Squat focus", exercises: [ex("Back Squat", "quads", 4, "4-6"), ex("Romanian Deadlift", "hamstrings", 3, "6-8"), ex("Walking Lunge", "quads", 3, "10-12"), ex("Standing Calf Raise", "calves", 4, "10-15")] },
  { name: "Upper B", description: "Volume upper", exercises: [ex("Incline Dumbbell Press", "chest", 4, "8-10"), ex("Lat Pulldown", "back", 4, "10-12"), ex("Cable Lateral Raise", "shoulders", 3, "12-15"), ex("EZ-Bar Curl", "biceps", 3, "10-12"), ex("Rope Pushdown", "triceps", 3, "10-12")] },
  { name: "Lower B", description: "Hinge focus", exercises: [ex("Trap Bar Deadlift", "hamstrings", 4, "4-6"), ex("Leg Press", "quads", 3, "10-12"), ex("Lying Leg Curl", "hamstrings", 3, "10-12"), ex("Hip Thrust", "glutes", 3, "8-10")] },
  { name: "Arms + Delts", description: "Optional fifth day", exercises: [ex("Cable Curl", "biceps", 3, "12-15"), ex("Overhead Cable Extension", "triceps", 3, "12-15"), ex("Rear Delt Fly", "shoulders", 3, "15-20")] },
  { name: "Hotel Full Body", description: "Travel, dumbbells only", exercises: [ex("Goblet Squat", "quads", 3, "12-15"), ex("Dumbbell Bench Press", "chest", 3, "10-12"), ex("One-Arm Dumbbell Row", "back", 3, "10-12")] },
];
const weeks = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
const FULL_CONTEXT = {
  profile: { goal: "hypertrophy", experience_level: "intermediate", weekly_target_sessions: 4, weight_kg: 81.2, height_cm: 180, gender: "M", age_years: 31 },
  today: { date: "2026-10-29", weekday: "Thursday", time_zone: "Europe/London" },
  goals: ["hypertrophy", "fat_loss"],
  injury_notes: "Left knee: no deep lunges or jumping.",
  memory: [{ category: "schedule", key: "training days", value: "Mon, Tue, Thu, Fri mornings", noted: "2026-10-02" }],
  activity: { sessions_last_7d: 3, sessions_last_28d: 13, last_finished_at: "2026-10-28T07:40:00Z" },
  top_lifts: [
    { exercise: "Barbell Bench Press", best_e1rm_kg: 102.5, last_e1rm_kg: 100 },
    { exercise: "Back Squat", best_e1rm_kg: 140, last_e1rm_kg: 140 },
    { exercise: "Trap Bar Deadlift", best_e1rm_kg: 182.5, last_e1rm_kg: 177.5 },
  ],
  nutrition: { targets: { kcal: 2350, protein_g: 175, carb_g: 240, fat_g: 70 }, recent_3d_avg: { kcal: 2290, protein_g: 168 }, today_so_far: { kcal: 640, protein_g: 52 } },
  program: { title: "10-Week Lean Gain", goal: "hypertrophy", current_phase: { name: "Accumulation", week_in_phase: 3, weeks_total: 4, diet_calorie_target: 2350 } },
  active_routines: ROUTINES,
  weekly_volume: weeks.flatMap((w, i) => [
    { week_start: w, muscle: "chest", working_sets: 12 + (i % 2) * 2 },
    { week_start: w, muscle: "back", working_sets: 15 },
    { week_start: w, muscle: "quads", working_sets: 10 - (i === 3 ? 4 : 0) },
    { week_start: w, muscle: "hamstrings", working_sets: 9 },
  ]),
  recent_plan_changes: [
    "2026-10-27 (card) targets: daily_calorie_target 2450 -> 2350",
    "2026-10-20 (chat) routine 'Upper B': added Cable Lateral Raise 3x12-15",
    "2026-10-14 (manual) routine 'Hotel Full Body' created",
    "2026-10-09 (chat) targets: protein_target_g 165 -> 175",
    "2026-10-06 (manual) routine 'Lower A': removed Bulgarian Split Squat",
    "2026-10-01 (auto) targets: daily_calorie_target 2550 -> 2450",
    "2026-09-29 (onboarding) program '10-Week Lean Gain' created",
  ],
  // summarizeMeasurements' shape (memory.ts)
  body_measurements: {
    latest_on: "2026-10-26", days_logged: 6,
    sites: [
      { site: "chest", cm: 104, on: "2026-10-26", prev_cm: 103, prev_on: "2026-08-03" },
      { site: "hips", cm: 98, on: "2026-10-26", prev_cm: 99.5, prev_on: "2026-08-03" },
      { site: "neck", cm: 39, on: "2026-10-26", prev_cm: 39.5, prev_on: "2026-08-03" },
      { site: "thigh_l", cm: 59, on: "2026-10-26", prev_cm: 59, prev_on: "2026-08-03" },
      { site: "waist", cm: 84.5, on: "2026-10-26", prev_cm: 87, prev_on: "2026-08-03" },
    ],
  },
};

type Arm = "lean" | "full";
interface Case {
  id: string;
  message: string;
  /** The held section this question needs, or null when the summary answers it. */
  needs: "routines" | "weekly_volume" | "plan_changes" | "body_measurements" | null;
}

const CASES: Case[] = [
  { id: "routine-contents", needs: "routines", message: "What's in my Lower B day? Exercises and sets please." },
  { id: "routine-swap", needs: "routines", message: "Swap one exercise in Upper A for something easier on the elbows. Which one would you change?" },
  { id: "chest-volume", needs: "weekly_volume", message: "How many chest sets have I been doing per week this month?" },
  { id: "quad-dip", needs: "weekly_volume", message: "Did my leg volume drop at any point recently?" },
  { id: "all-changes", needs: "plan_changes", message: "List every change to my plan and targets this month, and who made each one." },
  { id: "waist", needs: "body_measurements", message: "Has my waist come down since August?" },
  { id: "protein-target", needs: null, message: "What's my protein target again?" },
  { id: "knee-today", needs: null, message: "Knee feels a bit cranky today. Anything I should avoid?" },
  { id: "hello", needs: null, message: "Morning Drona!" },
];

// Calls that fetch a section, through the new tool or the older ways.
function fetched(calls: ToolCall[], section: NonNullable<Case["needs"]>): boolean {
  return calls.some((c) => {
    if (c.name === "coach_get_user_details") return Array.isArray(c.input.sections) && c.input.sections.includes(section);
    const sql = String(c.input.sql ?? c.input.query ?? "").toLowerCase();
    switch (section) {
      case "routines": return c.name === "coach_query_sql" && sql.includes("routine");
      case "weekly_volume": return c.name === "coach_get_muscle_volume_series" || (c.name === "coach_query_sql" && sql.includes("workout_sets"));
      case "plan_changes": return c.name === "coach_query_sql" && sql.includes("plan_changes");
      case "body_measurements": return c.name === "coach_get_body_log";
    }
  });
}

interface ToolCall { name: string; input: Record<string, unknown> }

function systemText(system: unknown): string {
  return Array.isArray(system) ? system.map((b) => (b as { text?: string }).text ?? "").join("\n\n") : String(system);
}

function runClaude(system: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [
      "-p", "--output-format", "json", "--model", MODEL, "--system-prompt", system, "--max-turns", "1",
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

async function turnViaCli(system: unknown, tools: { name: string; description?: string; input_schema?: unknown }[], message: string): Promise<{ calls: ToolCall[]; reply: string }> {
  const contract = [
    "## Output contract",
    "",
    "You are answering ONE turn. You may write a reply to the user, call any number of the functions below in the same turn (zero is fine), or both, exactly as you would with native tool use. A function's result arrives on the next turn, so a reply that needs it should wait for it.",
    "",
    ...tools.flatMap((t) => [`### ${t.name}`, t.description ?? "", "Arguments JSON Schema:", JSON.stringify(t.input_schema), ""]),
    'Reply with ONLY this JSON object: {"reply": "<text to the user, may be empty>", "tool_calls": [{"name": "<function>", "input": {...}}]}',
    "No prose outside it, no code fence. Do not use any tools of your own.",
  ].join("\n");
  const raw = await runClaude(
    `${systemText(system)}\n\n${contract}`,
    `USER: ${message}\n\n(Answer with the JSON object from the output contract only.)`,
  );
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (!json) throw new Error(`no JSON in reply: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(json) as { tool_calls?: ToolCall[]; reply?: string };
  return { calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [], reply: String(parsed.reply ?? "") };
}

async function turnViaApi(system: unknown, tools: unknown[], message: string): Promise<{ calls: ToolCall[]; reply: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system, tools, messages: [{ role: "user", content: message }], ...SONNET_SETTINGS }),
  });
  const body = await res.json() as { content?: { type: string; name?: string; text?: string; input?: Record<string, unknown> }[] };
  if (!body.content) throw new Error(`API: ${JSON.stringify(body).slice(0, 300)}`);
  return {
    calls: body.content.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name ?? "", input: b.input ?? {} })),
    reply: body.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
  };
}

interface Result { arm: Arm; id: string; ok: boolean; unneeded: boolean; note: string }

async function runCase(arm: Arm, c: Case): Promise<Result> {
  const lean = arm === "lean";
  const userContext = lean ? leanUserContext(FULL_CONTEXT).summary : FULL_CONTEXT;
  const { system, tools } = buildSystemPrompt({ userContext, mode: "chat", richReplies: true, leanContext: lean });
  const { calls } = VIA_CLI ? await turnViaCli(system, tools, c.message) : await turnViaApi(system, tools, c.message);
  const shown = calls.map((t) => t.name === "coach_get_user_details" ? `details(${(t.input.sections as string[] ?? []).join("+")})` : t.name).join(", ") || "no tools";
  const usedDetails = calls.some((t) => t.name === "coach_get_user_details");
  if (c.needs === null) return { arm, id: c.id, ok: !usedDetails, unneeded: calls.length > 0, note: shown };
  // The full arm already holds every section: answering from it is a pass.
  const ok = lean ? fetched(calls, c.needs) : true;
  return { arm, id: c.id, ok, unneeded: !lean && calls.length > 0, note: shown };
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

const cases = CASES.filter((c) => ONLY.length === 0 || ONLY.includes(c.id));
const jobs = ARMS.flatMap((arm) => cases.flatMap((c) => Array.from({ length: REPEAT }, () => () =>
  runCase(arm, c).catch((e): Result => ({ arm, id: c.id, ok: false, unneeded: false, note: `ERROR ${String(e).slice(0, 160)}` })))));
console.log(`lean-context eval: ${cases.length} cases x ${REPEAT} x arms [${ARMS.join(", ")}], ${VIA_CLI ? "via CLI" : "via API"}`);
const results = await pool(jobs, CONCURRENCY);
for (const arm of ARMS) {
  const mine = results.filter((r) => r.arm === arm);
  console.log(`\n== ${arm}: ${mine.filter((r) => r.ok).length}/${mine.length} pass, ${mine.filter((r) => r.unneeded).length} with a tool call the context already answered`);
  for (const c of cases) {
    const rs = mine.filter((r) => r.id === c.id);
    console.log(`  ${rs.every((r) => r.ok) ? "PASS" : "FAIL"} ${c.id.padEnd(17)} ${rs.map((r) => r.note).join(" | ")}`);
  }
}
const lean = results.filter((r) => r.arm === "lean");
process.exit(lean.length > 0 && lean.some((r) => !r.ok) ? 1 : 0);
