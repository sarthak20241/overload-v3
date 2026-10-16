/**
 * Does a generated program carry the goal of what it DOES?
 *
 * coach_programs.goal is read by Drona's goals_disagree signal. Programs that
 * cut 6 to 15 kg were saved as 'hypertrophy' because the brief told the coach
 * to copy the profile's primary goal. Each case here builds a program the way
 * the app does (the onboarding brief, or a program conversation) and scores
 * two things:
 *   model   the goal the coach itself emitted in generate_program
 *   saved   that goal after programGoalFor, the guard the app applies before
 *           it saves (lib/fitnessGoals.ts). This is what lands in the table.
 *
 * A case passes only when BOTH are right, so a prompt regression shows up
 * even though the guard would still save the right label.
 *
 * Held out: none of these inputs appear in the prompt. Keep it that way.
 *
 *   EVAL_VIA_CLI=1 npx tsx scripts/program-goal-eval/run.mts
 *   EVAL_VIA_CLI=1 REPEAT=3 ONLY=onboard-cut npx tsx scripts/program-goal-eval/run.mts
 *
 * Latency from a CLI run is meaningless (see claude-cli-fetch.ts).
 */
import { buildSystemPrompt } from "../../supabase/functions/ai-coach/prompt.ts";
import { buildAnonProgramMessage, sanitizeAnonIntake, type AnonIntake } from "../../supabase/functions/ai-coach/anonOnboarding.ts";
import { makeClaudeCliFetch } from "../parse-meal-eval/claude-cli-fetch.ts";
import { requireTool, SONNET_MODEL, SONNET_SETTINGS } from "../../supabase/functions/_shared/sonnet.ts";
import { programGoalFor } from "../../lib/fitnessGoals.ts";

const MODEL = SONNET_MODEL; // ai-coach's MODEL
const VIA_CLI = process.env.EVAL_VIA_CLI === "1";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!VIA_CLI && !API_KEY) { console.error("Set EVAL_VIA_CLI=1 (subscription) or ANTHROPIC_API_KEY (ask first)."); process.exit(2); }
const REPEAT = Math.max(1, Number(process.env.REPEAT || "") || 2);
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const fetchFn: typeof fetch = VIA_CLI ? makeClaudeCliFetch(MODEL) : fetch;
const TODAY = "2026-10-16";

interface Case {
  id: string;
  /** The messages the app sends, and the system prompt mode. */
  build: () => { mode: "generate_program" | "discuss_program"; userContext: Record<string, unknown> | null; turns: { role: "user" | "assistant"; content: string }[] };
  currentKg: number;
  /** Goals that count as right for this program. */
  want: string[];
}

const onboard = (intake: AnonIntake) => () => ({
  mode: "generate_program" as const,
  userContext: null,
  turns: [{ role: "user" as const, content: buildAnonProgramMessage(sanitizeAnonIntake(intake), TODAY) }],
});

const body = { experience: "intermediate", frequency: 4, gender: "M", ageYears: 29, heightCm: 178 };

const CASES: Case[] = [
  {
    // Build muscle, but the target weight is 7 kg down: the road is a cut.
    id: "onboard-cut",
    build: onboard({ ...body, goal: "hypertrophy", goals: ["hypertrophy"], weightKg: 84, goalWeightKg: 77, weeklyRateKg: 0.5, direction: "loss",
      targets: { kcal: 2150, protein: 170, carb: 210, fat: 65 } }),
    currentKg: 84,
    want: ["fat_loss"],
  },
  {
    // Several goals with muscle first; the weight still goes down.
    id: "onboard-cut-multi",
    build: onboard({ ...body, goal: "strength", goals: ["strength", "hypertrophy", "fat_loss"], weightKg: 71, goalWeightKg: 65, weeklyRateKg: 0.4, direction: "loss",
      targets: { kcal: 1900, protein: 145, carb: 190, fat: 58 } }),
    currentKg: 71,
    want: ["fat_loss"],
  },
  {
    // Control: a gain is never fat_loss.
    id: "onboard-gain",
    build: onboard({ ...body, goal: "hypertrophy", goals: ["hypertrophy"], weightKg: 66, goalWeightKg: 71, weeklyRateKg: 0.25, direction: "gain",
      targets: { kcal: 2850, protein: 140, carb: 360, fat: 80 } }),
    currentKg: 66,
    want: ["hypertrophy", "strength"],
  },
  {
    // Control: no weight target. The training goal stands.
    id: "onboard-hold",
    build: onboard({ ...body, goal: "strength", goals: ["strength"], weightKg: 80, goalWeightKg: 80, weeklyRateKg: null, direction: null,
      targets: { kcal: 2600, protein: 160, carb: 300, fat: 80 } }),
    currentKg: 80,
    want: ["strength"],
  },
  {
    // In chat: the profile says build muscle, the conversation settles a cut.
    id: "chat-cut",
    build: () => ({
      mode: "discuss_program",
      userContext: {
        profile: { goal: "hypertrophy", experience_level: "intermediate", weekly_target_sessions: 4, weight_kg: 88, height_cm: 181, gender: "M", age_years: 34 },
        today: { date: TODAY, weekday: "Friday", time_zone: "Asia/Kolkata" },
      },
      turns: [
        { role: "user", content: "I've built a decent base but I'm carrying too much fat. I want to be around 80 kg by March without losing my lifts. 4 days a week." },
        { role: "assistant", content: "That is 8 kg in about 20 weeks, a steady cut. Two deficit blocks with a diet break between, heavy lifting kept in so your strength holds, then a week at maintenance to settle. Want me to build it?" },
        { role: "user", content: "Yes, build it." },
      ],
    }),
    currentKg: 88,
    want: ["fat_loss"],
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
  const input = call.input;
  const model = typeof input.goal === "string" ? input.goal : "(none)";
  const target = typeof input.target_weight_kg === "number" ? input.target_weight_kg : null;
  const saved = programGoalFor(input.goal, target, c.currentKg);
  const note = `title="${String(input.title ?? "")}" target=${target ?? "-"} model=${model} saved=${saved}`;
  return { ok: c.want.includes(model) && c.want.includes(saved), note };
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
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.c.id} #${r.i + 1}  ${r.note}`);
}
console.log(`\n${pass}/${total} passed (${VIA_CLI ? "CLI, subscription" : "API key"})`);
process.exit(pass === total ? 0 : 1);
