import { assertEquals } from "jsr:@std/assert@1";
import {
  MAX_NEW_NAME,
  assemblePlan,
  groundSkeleton,
  parseSkeleton,
  runGeneratePlan,
  type TextCaller,
} from "./generatePlan.ts";

const CATALOG = ["Bench Press", "T-Bar Row", "Treadmill Run", "Plank"];

const SKELETON = [
  "PLAN | Upper Plus Mobility | Upper/Lower | 2",
  "DAY | Upper | Press and pull",
  "SLOT | Bench Press",
  "SLOT | T Bar Row",
  "NEW | Couch Stretch | Hip Flexors | Bodyweight | duration",
  "DAY | Conditioning | Easy cardio",
  "SLOT | Treadmill Run",
  "NEW | Banded Shoulder Dislocate | shoulders | other | Weight-Reps",
].join("\n");

Deno.test("a NEW line becomes a slot that carries the custom-exercise template", () => {
  const s = parseSkeleton(SKELETON)!;
  assertEquals(s.days[0].slots, ["Bench Press", "T Bar Row", "Couch Stretch"]);
  assertEquals(s.new_exercises?.["Couch Stretch"], {
    muscle_group: "Hip Flexors",
    category: "Bodyweight",
    metric_type: "duration",
  });
});

Deno.test("the template is matched loosely and held to the app's vocabulary", () => {
  const s = parseSkeleton(SKELETON)!;
  assertEquals(s.new_exercises?.["Banded Shoulder Dislocate"], {
    muscle_group: "Shoulders",
    category: "Other",
    metric_type: "weight_reps",
  });
  const bad = parseSkeleton("DAY | A | b\nNEW | Odd Thing | Elbows | Kettlebell | vibes")!;
  // Off-vocabulary values fall back to what the create form starts on, so the
  // insert can never fail the metric_type check.
  assertEquals(bad.new_exercises?.["Odd Thing"], {
    muscle_group: "Other",
    category: "Other",
    metric_type: "weight_reps",
  });
});

Deno.test("a catalog exercise under another spelling takes the catalog's name", () => {
  const s = groundSkeleton(parseSkeleton(SKELETON)!, CATALOG);
  assertEquals(s.days[0].slots[1], "T-Bar Row");
});

Deno.test("a NEW exercise that is really in the catalog is folded back to it", () => {
  const s = groundSkeleton(parseSkeleton("DAY | A | b\nNEW | plank | Core | Bodyweight | duration")!, CATALOG);
  assertEquals(s.days[0].slots, ["Plank"]);
  assertEquals(s.new_exercises, undefined);
});

Deno.test("only the invented exercise reaches the client with a template", () => {
  const s = groundSkeleton(parseSkeleton(SKELETON)!, CATALOG);
  const plan = assemblePlan(s, [null, null], "why");
  const upper = plan.workouts[0].exercises;
  assertEquals(upper.map((e) => e.new_exercise?.metric_type ?? null), [null, null, "duration"]);
});

Deno.test("the day fill is told which new exercises are held for time", async () => {
  const prompts: string[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const call: TextCaller = ({ label, messages }) => {
    prompts.push(`${label}::${String(messages[0].content)}`);
    if (label === "skeleton") return Promise.resolve({ text: SKELETON, usage });
    if (label === "rationale") return Promise.resolve({ text: "Because.", usage });
    return Promise.resolve({ text: "EX | Couch Stretch | 2 | 45s | 60 | Squeeze the glute", usage });
  };
  const r = await runGeneratePlan("Build me a plan.", { call, catalog: CATALOG, system: [] });
  const d1 = prompts.find((p) => p.startsWith("fill:d1::"))!;
  assertEquals(d1.includes("Measured by time, not reps: Couch Stretch."), true);
  const d2 = prompts.find((p) => p.startsWith("fill:d2::"))!;
  assertEquals(d2.includes("Measured by time"), false);
  assertEquals(r.plan?.workouts[0].exercises[2].new_exercise?.muscle_group, "Hip Flexors");
});

Deno.test("a catalog name written without its punctuation still folds to the catalog", () => {
  const s = groundSkeleton(parseSkeleton("DAY | A | b\nNEW | TBar Row | Back | Barbell | weight_reps")!, CATALOG);
  assertEquals(s.days[0].slots, ["T-Bar Row"]);
  assertEquals(s.new_exercises, undefined);
});

Deno.test("a timed invention whose fill died falls back to a time, not 8-12 reps", () => {
  const s = groundSkeleton(parseSkeleton(SKELETON)!, CATALOG);
  const plan = assemblePlan(s, [null, null], "why");
  const reps = plan.workouts[0].exercises.map((e) => e.reps);
  assertEquals(reps, ["8-12", "8-12", "30s"]);
});

Deno.test("an exercise named like an object property is not mistaken for a template", () => {
  const s = parseSkeleton("DAY | A | b\nSLOT | constructor\nNEW | __proto__ | Core | Bodyweight | duration")!;
  const plan = assemblePlan(s, [null], "why");
  assertEquals(plan.workouts[0].exercises[0].new_exercise, undefined);
  assertEquals(plan.workouts[0].exercises[0].reps, "8-12");
  assertEquals(plan.workouts[0].exercises[1].new_exercise?.metric_type, "duration");
});

Deno.test("a runaway invented name is cut at a word boundary before it is saved", () => {
  const long = "Slow Controlled Half Kneeling Hip Flexor Stretch With Overhead Reach And Rotation Toward The Front Leg";
  const s = parseSkeleton(`DAY | A | b\nNEW | ${long} | Hip Flexors | Bodyweight | duration`)!;
  const name = s.days[0].slots[0];
  assertEquals(name.length <= MAX_NEW_NAME, true);
  assertEquals(long.startsWith(name), true);
  assertEquals(s.new_exercises?.[name]?.metric_type, "duration");
});

Deno.test("a carry measured by distance falls back to meters and its fill is told so", async () => {
  const skel = "DAY | A | b\nSLOT | Bench Press\nNEW | Sandbag Carry | Grip | Other | weight_distance";
  const s = groundSkeleton(parseSkeleton(skel)!, CATALOG);
  assertEquals(assemblePlan(s, [null], "why").workouts[0].exercises[1].reps, "20m");
  const prompts: string[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const call: TextCaller = ({ label, messages }) => {
    prompts.push(`${label}::${String(messages[0].content)}`);
    if (label === "skeleton") return Promise.resolve({ text: skel, usage });
    if (label === "rationale") return Promise.resolve({ text: "Because.", usage });
    return Promise.resolve({ text: "EX | Bench Press | 3 | 5 | 120", usage });
  };
  await runGeneratePlan("Build me a plan.", { call, catalog: CATALOG, system: [] });
  const d1 = prompts.find((p) => p.startsWith("fill:d1::"))!;
  assertEquals(d1.includes("Measured by distance, not reps: Sandbag Carry."), true);
});

Deno.test("control characters never reach a saved exercise name", () => {
  const s = parseSkeleton("DAY | A | b\nNEW | Couch\u0007 Stretch\u001b | Hip Flexors | Bodyweight | duration")!;
  assertEquals(s.days[0].slots, ["Couch Stretch"]);
  const star = parseSkeleton("DAY | A | b\nNEW | Couch*Stretch | Hip Flexors | Bodyweight | duration")!;
  assertEquals(star.days[0].slots, ["CouchStretch"]);
});
