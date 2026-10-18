/**
 * Does Drona set activity goals (steps a day, cardio a week) when the program
 * calls for them, and only then?
 *
 * Each case builds a program the way the app does and reads the goals the app
 * would SAVE: the coach's activity block after normalizeActivityGoals, the same
 * clamp structuredToProgram applies.
 *
 *   cut      a step goal on at least one phase
 *   ask      the user asked for a weekly run: a cardio goal on some phase
 *   control  a gain or a strength hold with no ask: no activity goals at all
 *
 * Run:
 *   EVAL_VIA_CLI=1 npx tsx scripts/program-activity-eval/run.mts
 *   EVAL_VIA_CLI=1 REPEAT=3 ONLY=chat-cut npx tsx scripts/program-activity-eval/run.mts
 *
 * Latency from a CLI run is meaningless (see claude-cli-fetch.ts).
 */
import { buildSystemPrompt } from "../../supabase/functions/ai-coach/prompt.ts";
import { buildAnonProgramMessage, sanitizeAnonIntake, type AnonIntake } from "../../supabase/functions/ai-coach/anonOnboarding.ts";
import { makeClaudeCliFetch } from "../parse-meal-eval/claude-cli-fetch.ts";
import { requireTool, SONNET_MODEL, SONNET_SETTINGS } from "../../supabase/functions/_shared/sonnet.ts";
import { activityText, normalizeActivityGoals, type ActivityGoals } from "../../supabase/functions/_shared/activityGoals.ts";

const MODEL = SONNET_MODEL; // ai-coach's MODEL
const VIA_CLI = process.env.EVAL_VIA_CLI === "1";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!VIA_CLI && !API_KEY) { console.error("Set EVAL_VIA_CLI=1 (subscription) or ANTHROPIC_API_KEY (ask first)."); process.exit(2); }
const REPEAT = Math.max(1, Number(process.env.REPEAT || "") || 2);
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const fetchFn: typeof fetch = VIA_CLI ? makeClaudeCliFetch(MODEL) : fetch;
const TODAY = "2026-10-18";

type Want = "steps" | "cardio" | "none";

interface Case {
  id: string;
  build: () => { mode: "generate_program" | "discuss_program"; userContext: Record<string, unknown> | null; turns: { role: "user" | "assistant"; content: string }[] };
  want: Want;
}

const onboard = (intake: AnonIntake) => () => ({
  mode: "generate_program" as const,
  userContext: null,
  turns: [{ role: "user" as const, content: buildAnonProgramMessage(sanitizeAnonIntake(intake), TODAY) }],
});

const body = { experience: "intermediate", frequency: 4, gender: "M", ageYears: 29, heightCm: 178 };
const chatUser = {
  profile: { goal: "hypertrophy", experience_level: "intermediate", weekly_target_sessions: 4, weight_kg: 88, height_cm: 181, gender: "M", age_years: 34 },
  today: { date: TODAY, weekday: "Sunday", time_zone: "Asia/Kolkata" },
};

const CASES: Case[] = [
  {
    id: "onboard-cut",
    build: onboard({ ...body, goal: "hypertrophy", goals: ["hypertrophy"], weightKg: 84, goalWeightKg: 77, weeklyRateKg: 0.5, direction: "loss",
      targets: { kcal: 2150, protein: 170, carb: 210, fat: 65 } }),
    want: "steps",
  },
  {
    id: "chat-cut",
    build: () => ({
      mode: "discuss_program",
      userContext: chatUser,
      turns: [
        { role: "user", content: "I'm carrying too much fat. I want to be around 80 kg by March without losing my lifts. 4 days a week." },
        { role: "assistant", content: "That is 8 kg in about 20 weeks, a steady cut. Two deficit blocks with a diet break between, heavy lifting kept in so your strength holds. Want me to build it?" },
        { role: "user", content: "Yes, build it." },
      ],
    }),
    want: "steps",
  },
  {
    id: "chat-gain-weekly-run",
    build: () => ({
      mode: "discuss_program",
      userContext: { ...chatUser, profile: { ...chatUser.profile, weight_kg: 70 } },
      turns: [
        { role: "user", content: "I want to put on muscle over the next 12 weeks, 4 lifting days. I also want to keep a weekly run going so my fitness doesn't drop." },
        { role: "assistant", content: "A slow lean gain with four lifting days and one easy run a week fits well. Want me to build it?" },
        { role: "user", content: "Yes please." },
      ],
    }),
    want: "cardio",
  },
  {
    // Control: a gain with no ask.
    id: "onboard-gain",
    build: onboard({ ...body, goal: "hypertrophy", goals: ["hypertrophy"], weightKg: 66, goalWeightKg: 71, weeklyRateKg: 0.25, direction: "gain",
      targets: { kcal: 2850, protein: 140, carb: 360, fat: 80 } }),
    want: "none",
  },
  {
    // Control: strength at the same weight.
    id: "onboard-hold",
    build: onboard({ ...body, goal: "strength", goals: ["strength"], weightKg: 80, goalWeightKg: 80, weeklyRateKg: null, direction: null,
      targets: { kcal: 2600, protein: 160, carb: 300, fat: 80 } }),
    want: "none",
  },
];

async function runCase(c: Case): Promise<{ ok: boolean; note: string }> {
  const { mode, userContext, turns } = c.build();
  const { system, tools } = buildSystemPrompt({ userContext, retrievedResearch: [], mode } as never);
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000, // GENERATE_PROGRAM_MAX_TOKENS
      system,
      tools,
      messages: [...turns, requireTool("generate_program")],
      ...SONNET_SETTINGS,
    }),
  });
  const json = await res.json() as { content?: { type: string; name?: string; input?: Record<string, unknown> }[]; error?: unknown };
  const call = json.content?.find((b) => b.type === "tool_use" && b.name === "generate_program");
  if (!call?.input) return { ok: false, note: `no generate_program call ${json.error ? JSON.stringify(json.error).slice(0, 160) : ""}` };
  const phases = Array.isArray(call.input.phases) ? call.input.phases as Record<string, unknown>[] : [];
  const saved: ActivityGoals[] = phases.map((p) => normalizeActivityGoals(p.activity));
  const anySteps = saved.some((g) => g.steps_per_day != null);
  const anyCardio = saved.some((g) => g.cardio_sessions_per_week != null);
  const ok = c.want === "steps" ? anySteps : c.want === "cardio" ? anyCardio : !anySteps && !anyCardio;
  const note = saved.map((g, i) => `P${i + 1}: ${activityText(g)}`).join(" | ");
  return { ok, note };
}

const cases = ONLY.length ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
let pass = 0, total = 0;
const jobs = cases.flatMap((c) => Array.from({ length: REPEAT }, (_, i) => ({ c, i })));
const results = await Promise.all(jobs.map(async ({ c, i }) => {
  try { return { c, i, ...(await runCase(c)) }; }
  catch (e) { return { c, i, ok: false, note: `error ${(e as Error).message}` }; }
}));
for (const r of results) {
  total++;
  if (r.ok) pass++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.c.id} #${r.i + 1}  (want ${r.c.want})  ${r.note}`);
}
console.log(`\n${pass}/${total} passed (${VIA_CLI ? "CLI, subscription" : "API key"})`);
process.exit(pass === total ? 0 : 1);
