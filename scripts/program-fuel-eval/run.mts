/**
 * Does the program coach plan fuel days when it should, and only then?
 *
 * Each case is a program conversation that ends in the user's go-ahead, then
 * the generate_program call the app forces. The emitted phases are read with
 * the same parser the app uses (fuelDaysFromCoach) and scored:
 *   named-days      the user names hard sessions on set weekdays: every phase
 *                   carries those days
 *   no-days         the user names none: no phase invents any
 *   refine-keeps    a refine about calories only keeps the recap's fuel days
 *   carry-live      a new program keeps the fuel days the user already has
 *   adjust-keeps    adjusting an existing program keeps each phase's OWN
 *                   planned fuel days (they differ phase to phase)
 *
 * NO_PHASE_FUEL=1 strips the per-phase fuel days from the context, which is
 * what ai-coach sent before it read them: adjust-keeps should then fail.
 *
 * Held out: none of these inputs appear in the prompt. Keep it that way.
 *
 *   EVAL_VIA_CLI=1 npx tsx scripts/program-fuel-eval/run.mts          # subscription
 *   EVAL_VIA_CLI=1 REPEAT=3 ONLY=named-days npx tsx scripts/program-fuel-eval/run.mts
 *
 * Latency from a CLI run is meaningless (see claude-cli-fetch.ts).
 */
import { buildSystemPrompt } from "../../supabase/functions/ai-coach/prompt.ts";
import { fuelDaysFromCoach, fuelDaysText, type FuelDay } from "../../supabase/functions/_shared/fuelDays.ts";
import { makeClaudeCliFetch } from "../parse-meal-eval/claude-cli-fetch.ts";

const MODEL = "claude-sonnet-4-6"; // ai-coach's MODEL
const VIA_CLI = process.env.EVAL_VIA_CLI === "1";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!VIA_CLI && !API_KEY) { console.error("Set EVAL_VIA_CLI=1 (subscription) or ANTHROPIC_API_KEY (ask first)."); process.exit(2); }
const REPEAT = Math.max(1, Number(process.env.REPEAT || "") || 2);
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const fetchFn: typeof fetch = VIA_CLI ? makeClaudeCliFetch(MODEL) : fetch;

const profile = {
  goal: "fat_loss", experience_level: "intermediate", weekly_target_sessions: 4,
  weight_kg: 82, height_cm: 176, gender: "M", age_years: 31,
};
const today = { date: "2026-09-25", weekday: "Friday", time_zone: "Asia/Kolkata" };

type Mode = "discuss_program" | "refine_program";
interface Case {
  id: string;
  mode: Mode;
  userContext: Record<string, unknown>;
  turns: { role: "user" | "assistant"; content: string }[];
  /** Pass/fail with a reason, given every phase's fuel days (undefined = omitted). */
  check: (phases: (FuelDay[] | undefined)[]) => string | null;
}

const has = (days: FuelDay[] | undefined, dow: number) => !!days?.some((d) => d.dow === dow);

const CASES: Case[] = [
  {
    id: "named-days",
    mode: "discuss_program",
    userContext: { profile, today },
    turns: [
      { role: "user", content: "I want to get to 76 kg by mid December. I lift 4 days a week. Thursday nights I play a full 90 minute football match and Tuesday is hill sprints, I always feel empty the day after." },
      { role: "assistant", content: "That is about 6 kg in 11 weeks, a steady cut. I would run two 5-week deficit blocks with a deload week between, 4 lifting days, and give Thursday and Tuesday extra carbs so the match and the sprints are fuelled. Want me to build it now, or adjust the shape first?" },
      { role: "user", content: "Yes, build it." },
    ],
    check: (phases) => {
      const bad = phases.findIndex((p) => !has(p, 4) || !has(p, 2));
      return bad === -1 ? null : `phase ${bad + 1} is missing Tuesday or Thursday: ${phases[bad] ? fuelDaysText(phases[bad]!) : "omitted"}`;
    },
  },
  {
    id: "no-days",
    mode: "discuss_program",
    userContext: { profile, today },
    turns: [
      { role: "user", content: "Help me lean out to 77 kg over the next 10 weeks, 4 gym days a week, nothing else going on." },
      { role: "assistant", content: "That is 5 kg in 10 weeks. Two 4-week deficit blocks with a maintenance week between them, then a final week to consolidate, 4 lifting days throughout. Want me to build it now?" },
      { role: "user", content: "Go ahead." },
    ],
    check: (phases) => {
      const bad = phases.findIndex((p) => (p?.length ?? 0) > 0);
      return bad === -1 ? null : `phase ${bad + 1} invented fuel days: ${fuelDaysText(phases[bad]!)}`;
    },
  },
  {
    id: "refine-keeps",
    mode: "refine_program",
    userContext: { profile, today },
    turns: [
      {
        role: "user",
        content: [
          "[Current program]",
          "Title: Autumn Cut",
          "Goal: fat_loss",
          "Start date: 2026-09-21",
          "",
          "Phase 1: Deficit Block (5w)",
          "  Diet: 2150 kcal, 165g protein",
          "  Fuel days: Wed Swim squad +250, Sat Long ride +450",
          "  Training: Upper/Lower, 4d/wk",
          "  Week: Day 1 Upper, Day 2 Lower, Day 3 Rest, Day 4 Upper, Day 5 Lower, Day 6 Rest, Day 7 Rest",
          "",
          "Phase 2: Diet Break (1w)",
          "  Diet: 2600 kcal, 165g protein",
          "  Fuel days: Wed Swim squad +250, Sat Long ride +450",
          "  Training: Upper/Lower, 4d/wk",
          "  Week: Day 1 Upper, Day 2 Lower, Day 3 Rest, Day 4 Upper, Day 5 Lower, Day 6 Rest, Day 7 Rest",
        ].join("\n"),
      },
      { role: "assistant", content: "Here is your current program. What do you want to change?" },
      { role: "user", content: "Drop the Deficit Block to 2050 kcal, keep everything else the same." },
      { role: "assistant", content: "Deficit Block goes to 2050, the diet break and everything else stay as they are. Want me to rebuild it with that change now?" },
      { role: "user", content: "Yes." },
    ],
    check: (phases) => {
      const bad = phases.findIndex((p) => {
        const wed = p?.find((d) => d.dow === 3);
        const sat = p?.find((d) => d.dow === 6);
        return !(wed?.kcal === 250 && sat?.kcal === 450);
      });
      return bad === -1 ? null : `phase ${bad + 1} lost its fuel days: ${phases[bad] ? fuelDaysText(phases[bad]!) : "omitted"}`;
    },
  },
  {
    id: "carry-live",
    mode: "discuss_program",
    userContext: { profile, today, fuel_days: [{ day: "Saturday", extra_kcal: 400, label: "Long ride" }] },
    turns: [
      { role: "user", content: "Build me a 12 week program to get stronger on the big three, 4 days a week, keep my weight about the same." },
      { role: "assistant", content: "A strength block at maintenance: two 5-week blocks building intensity on squat, bench and deadlift, a deload between, and a test week at the end. Want me to build it now?" },
      { role: "user", content: "Build it." },
    ],
    check: (phases) => {
      // Omitted is also a pass here: the app keeps the live days when a phase says nothing.
      const bad = phases.findIndex((p) => p !== undefined && !has(p, 6));
      return bad === -1 ? null : `phase ${bad + 1} dropped the live Saturday: ${fuelDaysText(phases[bad]!)}`;
    },
  },
  {
    id: "adjust-keeps",
    mode: "discuss_program",
    userContext: {
      profile, today,
      fuel_days: [{ day: "Tuesday", extra_kcal: 200, label: "Track session" }],
      program: {
        title: "Spring Recomp", goal: "general", start_date: "2026-09-07", total_weeks: 9,
        current_phase: { seq: 1, name: "Intensity Block", week_in_phase: 2, weeks_total: 4, diet_targets: { calories: 2400, protein_g: 165 } },
        phases: [
          { seq: 0, name: "Base Block", duration_weeks: 3, start_offset_weeks: 0, calories: 2500, fuel_days: [] },
          { seq: 1, name: "Intensity Block", duration_weeks: 4, start_offset_weeks: 3, calories: 2400, fuel_days: [{ day: "Tuesday", extra_kcal: 200, label: "Track session" }] },
          { seq: 2, name: "Race Taper", duration_weeks: 2, start_offset_weeks: 7, calories: 2300, fuel_days: [{ day: "Tuesday", extra_kcal: 200, label: "Track session" }, { day: "Friday", extra_kcal: 450, label: "Race prep" }] },
        ],
      },
    },
    turns: [
      { role: "user", content: "Can you drop the Race Taper calories to 2250? Leave the rest of my program exactly as it is." },
      { role: "assistant", content: "Race Taper goes to 2250, every other part of the program stays the same. Want me to rebuild it with that change now?" },
      { role: "user", content: "Yes, do it." },
    ],
    check: (phases) => {
      if (phases.length !== 3) return `expected 3 phases, got ${phases.length}`;
      const [base, intensity, taper] = phases;
      const same = (p: FuelDay[] | undefined, want: [number, number][]) =>
        p !== undefined && p.length === want.length && want.every(([dow, kcal]) => p.some((d) => d.dow === dow && d.kcal === kcal));
      const shape = phases.map((f, i) => `P${i + 1}: ${f === undefined ? "omitted" : fuelDaysText(f)}`).join(" | ");
      if (base !== undefined && base.length > 0) return `Base Block gained fuel days: ${shape}`;
      if (!same(intensity, [[2, 200]])) return `Intensity Block changed: ${shape}`;
      if (!same(taper, [[2, 200], [5, 450]])) return `Race Taper changed: ${shape}`;
      return null;
    },
  },
];

// What ai-coach sent before it read each phase's fuel days (the control run).
if (process.env.NO_PHASE_FUEL === "1") {
  for (const c of CASES) {
    const prog = c.userContext.program as { phases?: Record<string, unknown>[] } | undefined;
    prog?.phases?.forEach((ph) => { delete ph.fuel_days; });
  }
}

async function runCase(c: Case): Promise<{ ok: boolean; note: string }> {
  const { system, tools } = buildSystemPrompt({ userContext: c.userContext, mode: c.mode } as never);
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 6144,
      system,
      tools,
      tool_choice: { type: "tool", name: "generate_program" },
      messages: c.turns,
    }),
  });
  const body = await res.json() as { content?: { type: string; name?: string; input?: Record<string, unknown> }[]; error?: unknown };
  const call = body.content?.find((b) => b.type === "tool_use" && b.name === "generate_program");
  if (!call?.input) return { ok: false, note: `no generate_program call: ${JSON.stringify(body).slice(0, 200)}` };
  const phases = (Array.isArray(call.input.phases) ? call.input.phases : []) as Record<string, unknown>[];
  if (phases.length === 0) return { ok: false, note: "no phases" };
  const fuel = phases.map((p) => fuelDaysFromCoach(p.fuel_days));
  const fail = c.check(fuel);
  const shape = fuel.map((f, i) => `P${i + 1}: ${f === undefined ? "omitted" : fuelDaysText(f)}`).join(" | ");
  return { ok: fail == null, note: fail ?? shape };
}

const cases = ONLY.length ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
let pass = 0;
let total = 0;
for (const c of cases) {
  const runs = await Promise.all(Array.from({ length: REPEAT }, () => runCase(c).catch((e) => ({ ok: false, note: String(e) }))));
  for (const r of runs) {
    total += 1;
    if (r.ok) pass += 1;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${c.id.padEnd(13)} ${r.note}`);
  }
}
console.log(`\n${pass}/${total} ${VIA_CLI ? "(via claude -p: correctness only, no latency)" : "(API)"}`);
process.exit(pass === total ? 0 : 1);
