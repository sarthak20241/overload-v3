import { assertEquals } from "jsr:@std/assert@1";
import {
  estimateWorkoutMinutes,
  fitWorkoutToMinutes,
  requestSessionRange,
  sessionCap,
  sessionMinutesFromText,
} from "./sessionTime.ts";
import { runGeneratePlan, type TextCaller } from "./generatePlan.ts";

// The user who wrote "Home, 20 minutes" at onboarding (2026-11-28): her four
// phase 1 days exactly as Drona saved them.
const HER_DAYS: Record<string, [string, number, string, number][]> = {
  "Full Body Technique": [
    ["Chair Squat", 3, "8-12", 90], ["Dumbbell Bench Press", 3, "8-12", 90],
    ["One-Arm Dumbbell Row", 3, "10-12", 60], ["Glute Bridge", 3, "12-15", 60],
    ["Dumbbell Shoulder Press", 2, "8-12", 90], ["Plank", 2, "30s", 45],
  ],
  "Upper Push Pull": [
    ["Incline Push-Up", 3, "8-15", 90], ["Bent Over Two-Dumbbell Row", 3, "8-12", 90],
    ["Seated Dumbbell Press", 3, "8-12", 90], ["Inverted Row", 3, "6-12", 90],
    ["Side Lateral Raise", 3, "12-20", 60], ["Dumbbell Curl", 2, "10-15", 60],
    ["Overhead Tricep Extension", 2, "10-15", 60],
  ],
  "Glutes and Hamstrings": [
    ["Romanian Deadlift", 3, "8-12", 120], ["Hip Thrust", 3, "10-15", 90],
    ["Stiff-Legged Dumbbell Deadlift", 2, "10-12", 90], ["Single Leg Glute Bridge", 2, "10-15", 60],
    ["Band Hip Adductions", 2, "12-20", 60], ["Hip Extension with Bands", 2, "12-20", 45],
  ],
  "Core and Conditioning": [
    ["Dead Bug", 3, "8-12", 45], ["Pallof Press", 3, "10-12", 45], ["Russian Twist", 3, "12-16", 45],
    ["Reverse Crunch", 3, "10-15", 45], ["Side Bridge", 3, "20s", 45],
    ["Low-Impact Marching Intervals", 4, "45s", 30],
  ],
};
const day = (name: string) => ({
  name,
  exercises: HER_DAYS[name].map(([n, sets, reps, rest]) => ({ name: n, sets, reps, rest_seconds: rest })),
});

Deno.test("her saved days run well past the 20 minutes she asked for", () => {
  const mins = Object.keys(HER_DAYS).map((d) => Math.round(estimateWorkoutMinutes(day(d))));
  // Worked by hand, seconds:
  //   Full Body  360 + 360 + 279 + 301.5 + 240 + 150 - 45   = 1645.5 (27.4 min)
  //   Glutes     450 + 382.5 + 246 + 195 + 216 + 186 - 45   = 1630.5 (27.2 min)
  //   Core       225 + 234 + 261 + 247.5 + 195 + 300 - 30   = 1432.5 (23.9 min)
  assertEquals(mins, [27, 35, 27, 24]);
});

Deno.test("free text session times", () => {
  assertEquals(sessionMinutesFromText("Home, 20 minutes"), 20);
  assertEquals(sessionMinutesFromText("dumbbells only, keep it under 45 min"), 45);
  assertEquals(sessionMinutesFromText("30-45 mins at the gym"), 45);
  assertEquals(sessionMinutesFromText("about 1 hour"), 60);
  assertEquals(sessionMinutesFromText("1.5 hrs max"), 90);
  assertEquals(sessionMinutesFromText("half an hour after work"), 30);
  assertEquals(sessionMinutesFromText("an hour on weekends"), 60);
  // The session is the longest time named; the 10 min is part of it.
  assertEquals(sessionMinutesFromText("45 min with a 10 min warm-up"), 45);
  assertEquals(sessionMinutesFromText("Home, dumbbells"), null);
  assertEquals(sessionMinutesFromText("5 min"), null); // too short to be a session
  assertEquals(sessionMinutesFromText("20m sled pushes"), null); // meters, not minutes
});

Deno.test("the form's choice wins, the profile is used inside its range", () => {
  // Her case: an automatic build names no time, so the profile decides.
  // lib/phaseBuild.ts phaseBuildPrompt's own fallback words name a time; they
  // must not read as the form's choice.
  const autoBuild = "Design my training split. Build the split. Use my profile for my experience level and session length; if they are not set, keep sessions about 45-60 minutes.";
  assertEquals(sessionCap({ preferences: "Home, 20 minutes", request: autoBuild }), 20);
  assertEquals(sessionCap({ profileMinutes: 30, preferences: "Home, 20 minutes" }), 30);
  assertEquals(sessionCap({ profileMinutes: 20, request: "Design my training split. x Keep sessions about 20-30 min, Beginner level." }), 20);
  assertEquals(sessionCap({ profileMinutes: 20, request: "Design my training split. x Keep sessions about 60-75 min, Beginner level." }), 75);
  assertEquals(sessionCap({ request: "Goal: x. 4 days/week, 45-60 min sessions, Beginner level." }), 60);
  assertEquals(sessionCap({}), null);
  // A phase directive's finisher is not the session length.
  assertEquals(requestSessionRange("Add a 10 min finisher to two sessions."), null);
});

Deno.test("each of her days fits 20 minutes after the trim, and keeps its first lifts", () => {
  for (const d of Object.keys(HER_DAYS)) {
    const { workout, trimmed } = fitWorkoutToMinutes(day(d), 20);
    assertEquals(trimmed, true);
    assertEquals(estimateWorkoutMinutes(workout) <= 20, true, `${d}: ${estimateWorkoutMinutes(workout)}`);
    assertEquals(workout.exercises.length >= 3, true, d);
    assertEquals(workout.exercises[0].name, HER_DAYS[d][0][0]);
    assertEquals(workout.exercises.every((e) => e.rest_seconds <= 60 && e.sets >= 1), true, d);
  }
});

Deno.test("a session that already fits comes back untouched", () => {
  const d = day("Core and Conditioning");
  const r = fitWorkoutToMinutes(d, 45);
  assertEquals(r.trimmed, false);
  assertEquals(r.workout, d);
});

// ── The builder, end to end with a fake model that ignores the limit ────────

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const SKELETON = [
  "PLAN | Home Cut | Upper/Lower | 2",
  ...["Full Body Technique", "Upper Push Pull"].flatMap((d) => [
    `DAY | ${d} | knee friendly`,
    ...HER_DAYS[d].map(([n]) => `SLOT | ${n}`),
  ]),
].join("\n");
const CATALOG = [...new Set(Object.values(HER_DAYS).flat().map(([n]) => n))];

function fakeModel(prompts: string[]): TextCaller {
  return ({ label, messages }) => {
    prompts.push(`${label}::${String(messages[0].content)}`);
    if (label === "skeleton") return Promise.resolve({ text: SKELETON, usage });
    if (label === "rationale") return Promise.resolve({ text: "Because.", usage });
    const d = label === "fill:d1" ? "Full Body Technique" : "Upper Push Pull";
    const text = HER_DAYS[d].map(([n, s, r, rest]) => `EX | ${n} | ${s} | ${r} | ${rest}`).join("\n");
    return Promise.resolve({ text, usage });
  };
}

Deno.test("a 20 minute user gets 20 minute sessions even when the model ignores it", async () => {
  const prompts: string[] = [];
  const streamed: number[] = [];
  const r = await runGeneratePlan("Design my training split.", {
    call: fakeModel(prompts), catalog: CATALOG, system: [], sessionMinutes: 20,
    onDay: (_i, w) => streamed.push(estimateWorkoutMinutes(w)),
  });
  const mins = r.plan!.workouts.map((w) => estimateWorkoutMinutes(w));
  assertEquals(mins.every((m) => m <= 20), true, String(mins));
  // What the client shows while days land matches what it saves.
  assertEquals(streamed.every((m) => m <= 20), true, String(streamed));
  // Every call that picks exercises or sets is told the limit.
  for (const label of ["skeleton", "fill:d1", "fill:d2"]) {
    const p = prompts.find((x) => x.startsWith(`${label}::`))!;
    assertEquals(p.includes("must fit in 20 minutes"), true, label);
  }
});

Deno.test("no limit given: the plan is exactly what the model wrote", async () => {
  const prompts: string[] = [];
  const r = await runGeneratePlan("Design my training split.", { call: fakeModel(prompts), catalog: CATALOG, system: [] });
  assertEquals(r.plan!.workouts[1].exercises.length, 7);
  assertEquals(Math.round(estimateWorkoutMinutes(r.plan!.workouts[1])), 35);
  assertEquals(prompts.some((p) => p.includes("must fit in")), false);
});
