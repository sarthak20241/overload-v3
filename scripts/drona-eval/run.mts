/**
 * The ugly-week eval for B1 (plan section 3): the model earns the job only if
 * clean stalls come out as a proposal inside the bounds and ugly weeks come
 * out as a hold. Held-out packs: never put eval inputs into the prompt.
 *
 *   EVAL_VIA_CLI=1 npx tsx scripts/drona-eval/run.mts      # subscription, via claude -p
 *   ANTHROPIC_API_KEY=... npx tsx scripts/drona-eval/run.mts  # API credit; ask first
 *
 * Latency from a CLI run is meaningless (see claude-cli-fetch.ts).
 */
import { askCaloriesModel, DRONA_CARD_MODEL } from "../../supabase/functions/_shared/dronaModel.ts";
import { calorieGate, uglyChecks, validateTargets, type DietFacts } from "../../supabase/functions/_shared/dronaCalories.ts";
import type { DronaFacts } from "../../supabase/functions/_shared/dronaCards.ts";
import { makeClaudeCliFetch } from "../parse-meal-eval/claude-cli-fetch.ts";

const VIA_CLI = process.env.EVAL_VIA_CLI === "1";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (!VIA_CLI && !API_KEY) { console.error("Set EVAL_VIA_CLI=1 (subscription) or ANTHROPIC_API_KEY."); process.exit(2); }

const AS_OF = "2026-09-18";
const day = (back: number) => new Date(Date.UTC(2026, 8, 18) - back * 86_400_000).toISOString().slice(0, 10);

const baseFacts = (): DronaFacts => ({
  as_of: AS_OF, week_start: "2026-09-14", tier: "annual",
  tenure: { days_since_first_session: 120, sessions_total: 50 },
  goal: { goal: "fat_loss", goal_weight_kg: 68, weight_kg: 72.4 },
  training: { sessions_14d: 7, planned_14d: 8, days_since_last_session: 1 },
  nutrition: { days_logged_14d: 12, target_kcal: 2100, on_target_days_14d: 11 },
  weight: { weigh_ins_14d: 10, weigh_ins_28d: 20 },
  cards: [],
} as DronaFacts);
const baseDiet = (): DietFacts => ({
  as_of: AS_OF, tier: "annual", tier_expires_at: null,
  body: { gender: "M", height_cm: 178, weight_kg: 72.4, age_years: 30 },
  targets: { kcal: 2100, protein_g: 150, carb_g: 210, fat_g: 60 },
  phase: { id: "ph1", kcal: 2100, protein_g: 150, carb_g: 210, fat_g: 60 },
  food: Array.from({ length: 12 }, (_, i) => ({ day: day(i < 3 ? i : i + 1), kcal: 2060 + (i % 4) * 30, protein_g: 148 })),
  weight: Array.from({ length: 10 }, (_, i) => ({ day: day(i), kg: Math.round((72.4 + ((i % 2) ? 0.15 : -0.1)) * 10) / 10 })),
  target_changes: [{ at: "2026-08-28T08:00:00Z", from: 2250, to: 2100, source: "chat", card_id: null }],
  days_since_target_change: 21,
});

interface Pack { name: string; expect: "propose" | "hold"; facts: DronaFacts; diet: DietFacts }
const packs: Pack[] = [
  { name: "clean-stall", expect: "propose", facts: baseFacts(), diet: baseDiet() },
  {
    name: "clean-stall-no-history", expect: "propose", facts: baseFacts(),
    diet: { ...baseDiet(), target_changes: [], days_since_target_change: null },
  },
  {
    // Twelve days "near" target on average, but two 3400 kcal Saturdays hide inside the mean.
    name: "weekend-blowouts", expect: "hold",
    facts: { ...baseFacts(), nutrition: { days_logged_14d: 12, target_kcal: 2100, on_target_days_14d: 9 } },
    diet: { ...baseDiet(), food: baseDiet().food!.map((r, i) => (i === 1 || i === 8 ? { ...r, kcal: 3400 } : r)) },
  },
  {
    // The user raised the target BACK by hand a month ago after a card cut it. They said something.
    name: "raised-back-by-hand", expect: "hold", facts: baseFacts(),
    diet: { ...baseDiet(), target_changes: [
      { at: "2026-08-20T08:00:00Z", from: 1950, to: 2100, source: "manual", card_id: null },
      { at: "2026-08-10T08:00:00Z", from: 2100, to: 1950, source: "card", card_id: "x" },
    ], days_since_target_change: 29 },
  },
  {
    // Weight swinging a kilo day to day: no trend can be read from that.
    name: "noisy-scale", expect: "hold", facts: baseFacts(),
    diet: { ...baseDiet(), weight: Array.from({ length: 10 }, (_, i) => ({ day: day(i), kg: [73.4, 71.6, 73.1, 71.9, 72.9, 71.5, 73.3, 71.8, 72.6, 71.7][i] })) },
  },
  {
    // Protein has collapsed alongside the stall: the fix is not fewer calories.
    name: "protein-collapsed", expect: "hold", facts: baseFacts(),
    diet: { ...baseDiet(), food: baseDiet().food!.map((r) => ({ ...r, protein_g: 70 })) },
  },
];

// Two scores, reported apart:
//   model     what the model itself answered. This is the judgment the plan
//             says it must earn.
//   pipeline  what the user would get after the validator. The validator's
//             own ugly checks catch the four known patterns; the model has to
//             catch what those do not name.
const fetchFn = VIA_CLI ? makeClaudeCliFetch(DRONA_CARD_MODEL) : fetch;
let modelPass = 0;
let pipelinePass = 0;
for (const p of packs) {
  const gate = calorieGate(p.facts, p.diet);
  if (!gate.eligible || !gate.anchor) { console.log(`SKIP ${p.name}: gate closed (${gate.reasons.join(",")})`); continue; }
  const a = await askCaloriesModel({ facts: p.facts, diet: p.diet, anchor: gate.anchor, memory: [] }, API_KEY, fetchFn);
  const modelSaid = a.tool === "propose_targets" ? "propose" : a.tool === "hold" ? "hold" : "none";
  let final = "hold";
  let detail = "";
  if (a.tool === "propose_targets") {
    const v = validateTargets(a.input, { ...gate.anchor, checks: uglyChecks(p.facts, p.diet) });
    if (v.ok) { final = "propose"; detail = `${v.kcal}`; }
    else detail = `refused: ${v.reason}`;
  } else if (a.tool === "hold") detail = String(a.input.reason ?? "").slice(0, 100);
  else detail = `model error: ${a.error}`;
  const mOk = modelSaid === p.expect;
  const pOk = final === p.expect;
  if (mOk) modelPass++;
  if (pOk) pipelinePass++;
  console.log(`${p.name.padEnd(24)} expect ${p.expect.padEnd(7)} model ${mOk ? "PASS" : "FAIL"} (${modelSaid})  pipeline ${pOk ? "PASS" : "FAIL"} (${final} ${detail})`);
  if (a.tool === "propose_targets") console.log(`     "${String(a.input.rationale)}"`);
}
console.log(`model ${modelPass}/${packs.length}   pipeline ${pipelinePass}/${packs.length} ${VIA_CLI ? "(via claude -p: correctness only, no latency)" : "(API)"}`);
// Both scores must be whole. The validator catching a bad proposal is the
// safety net working, not the model passing: a green run that hides a wrong
// judgment behind a refusal is exactly what this eval exists to show.
if (modelPass < packs.length || pipelinePass < packs.length) process.exitCode = 1;
