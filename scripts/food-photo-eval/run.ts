// Photo food logging: compare the photo-read models (FOOD_PHOTO_MODEL).
// macOS only: photos are resized with `sips`. The API key comes from the env
// or from the main checkout's .env.local (outside this worktree).
//
//   ANTHROPIC_API_KEY=... deno run -A scripts/food-photo-eval/run.ts
//   MODELS=claude-haiku-5-5 ONLY=label-bar deno run -A ...      # one model, some cases
//   CASES=~/.config/overload/food-photos/cases.json deno run -A ...  # the weighed set
//   REPEAT=3 deno run -A ...                                      # how steady a read is
//   OUT=/tmp/photo-eval.json deno run -A ...                      # every read, for a closer look
//   SCALE=1 deno run -A ...     # send each photo's measured scale (a case's `rig`), as a LiDAR phone would
//   NOTE=names deno run -A ...  # send a note naming the foods, no amounts (a case's `ingredients`)
//   E2E=0 deno run -A ...       # read stage only
//
// Two stages, as in the app. READ: the vision call (foodPhoto.ts
// readFoodPhoto) and the words it makes (photoToText); graded on the photo
// kind, the total weight against the scale (a case's `truth.mass_g`), whether
// the truth falls inside the read's low..high range, and a label's printed
// numbers. END TO END (Quick): those words and the note go through the real
// parse (runParseMeal, mode "fast": one Haiku call that names each food and
// prices it, no catalog), graded on calories, fat, carbs and protein against
// the weighed truth. Precise (catalog, memory, web) needs the live database
// and is not run here.
//
// The weighed set: scripts/food-photo-eval/nutrition5k.ts builds it from
// Nutrition5k (CC BY 4.0) outside the repo.
//
// Photos are prepared like the app does: long edge 1568 px, one JPEG pass at
// quality 80 (sips, macOS). The weighed set lives OUTSIDE the repo (people's
// meals); scripts/food-photo-eval/smoke holds two synthetic images that check
// the request shape only, not accuracy.
//
// API credit, not the CLI (owner rule 2026-11-07): the CLI cannot send an
// image the way the app does, and API timings are the real ones. Every run
// prints its cost.

import {
  FOOD_PHOTO_MODELS,
  markPhotoLines,
  photoToText,
  type PhotoImage,
  type PhotoRead,
  readFoodPhoto,
} from "../../supabase/functions/ai-coach/foodPhoto.ts";
import { type ParseMealDeps, runParseMeal } from "../../supabase/functions/ai-coach/parseMeal.ts";

// ── cases ───────────────────────────────────────────────────────────────────

interface TruthItem {
  /** Words that must appear in the read's name for a match ("rice"). */
  match: string[];
  grams: number;
}
interface Case {
  id: string;
  /** Paths relative to the cases file. One or two. */
  images: string[];
  note?: string;
  kind: "plate" | "label" | "not_food";
  items?: TruthItem[];
  /** Cooking fat was used and the note does not say so. */
  fat_added?: boolean;
  /** Printed per 100 g (or per serving) values. */
  label?: { kcal: number; protein_g?: number; carb_g?: number; fat_g?: number };
  /** Smoke cases check the shape only and are left out of the accuracy lines. */
  smoke?: boolean;
  /** Weighed totals for the whole dish. */
  truth?: { mass_g: number; kcal: number; fat_g: number; carb_g: number; protein_g: number };
  /** "chicken 154 g": what is on the plate, for NOTE=names and for reading by eye. */
  ingredients?: string[];
  /** The camera rig: SCALE=1 turns it into the photo's measured scale. */
  rig?: { distance_cm: number; cm_per_px: number };
}

const here = new URL(".", import.meta.url).pathname;
const casesPath = Deno.env.get("CASES") ?? `${here}cases.json`;
const casesDir = casesPath.slice(0, casesPath.lastIndexOf("/") + 1);
const only = (Deno.env.get("ONLY") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const models = (Deno.env.get("MODELS") ?? FOOD_PHOTO_MODELS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const repeat = Math.max(1, Number(Deno.env.get("REPEAT") ?? 1) || 1);
const effort = (Deno.env.get("EFFORT") ?? "medium") as "low" | "medium" | "high";
const withScale = Deno.env.get("SCALE") === "1";
const noteMode = Deno.env.get("NOTE") ?? "";
const e2e = Deno.env.get("E2E") !== "0";
const pool = Math.max(1, Number(Deno.env.get("EVAL_CONCURRENCY") ?? 4) || 4);
const cases: Case[] = (JSON.parse(await Deno.readTextFile(casesPath)) as Case[]).filter((c) => !only.length || only.includes(c.id));

let apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
if (!apiKey) {
  // The main checkout's .env.local, never printed.
  try {
    const env = await Deno.readTextFile(`${here}../../../../../.env.local`).catch(() => Deno.readTextFile(`${here}../../.env.local`));
    apiKey = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  } catch { /* none */ }
}
if (!apiKey) {
  console.error("Needs ANTHROPIC_API_KEY (env, or .env.local).");
  Deno.exit(1);
}

/** $ per million tokens (input, output), first-party API, 2026-11. */
const PRICE: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.10, 0.50],
  "claude-sonnet-5-5": [2.00, 10.00],
};

// ── prepare a photo like the app ────────────────────────────────────────────

/** Pixel size of an image file (sips). */
async function pixelSize(path: string): Promise<{ w: number; h: number } | null> {
  const r = await new Deno.Command("sips", { args: ["-g", "pixelWidth", "-g", "pixelHeight", path], stdout: "piped", stderr: "null" }).output();
  const out = new TextDecoder().decode(r.stdout);
  const w = Number(out.match(/pixelWidth: (\d+)/)?.[1]);
  const h = Number(out.match(/pixelHeight: (\d+)/)?.[1]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** NOTE=names: what a user might type, the foods with no amounts. */
function noteFor(c: Case): string {
  if (noteMode === "names" && c.ingredients?.length) return c.ingredients.map((i) => i.replace(/\s+\d+\s*g$/, "")).join(", ");
  return c.note ?? "";
}

/** The Quick parse, as the app runs it for a first message: one model call,
 *  no catalog. Model and budget as in ai-coach/index.ts. */
const parseDeps: ParseMealDeps = {
  anthropicApiKey: apiKey,
  model: "claude-haiku-5-5",
  maxTokens: 6500,
  timeoutMs: 60_000,
  webSearchEnabled: false,
  searchFoods: () => Promise.resolve([]),
  backfillOffFood: () => Promise.resolve(null),
  getFoodPer100: () => Promise.resolve(null),
};

const prepared = new Map<string, PhotoImage>();
async function prepare(path: string): Promise<PhotoImage> {
  const hit = prepared.get(path);
  if (hit) return hit;
  const out = await Deno.makeTempFile({ suffix: ".jpg" });
  const r = await new Deno.Command("sips", {
    args: ["-Z", "1568", "-s", "format", "jpeg", "-s", "formatOptions", "80", path, "--out", out],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!r.success) throw new Error(`sips failed on ${path}`);
  const bytes = await Deno.readFile(out);
  await Deno.remove(out);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const img: PhotoImage = { media_type: "image/jpeg", data: btoa(bin), bytes: bytes.length };
  prepared.set(path, img);
  return img;
}

// ── grading ─────────────────────────────────────────────────────────────────

interface Grade {
  kindOk: boolean;
  /** Absolute % error of grams, per weighed food that was found. */
  gramErrors: number[];
  inRange: boolean[];
  missed: string[];
  fatOk: boolean | null;
  labelOk: boolean | null;
}

const within = (got: number | null | undefined, want: number | undefined) =>
  want === undefined || (got !== null && got !== undefined && Math.abs(got - want) <= Math.max(1, want * 0.02));

function grade(c: Case, read: PhotoRead, note: string): Grade {
  const g: Grade = { kindOk: read.kind === c.kind, gramErrors: [], inRange: [], missed: [], fatOk: null, labelOk: null };
  const used = new Set<number>();
  for (const t of c.items ?? []) {
    const i = read.items.findIndex((it, idx) => !used.has(idx) && t.match.every((w) => it.name.toLowerCase().includes(w.toLowerCase())));
    if (i < 0 || !read.items[i].grams) {
      g.missed.push(t.match.join(" "));
      continue;
    }
    used.add(i);
    const r = read.items[i].grams!;
    g.gramErrors.push(Math.abs(r.best - t.grams) / t.grams * 100);
    g.inRange.push(t.grams >= r.low && t.grams <= r.high);
  }
  if (c.fat_added !== undefined) g.fatOk = (photoToText(read, note).assumed.length > 0) === c.fat_added;
  if (c.label) {
    const l = read.items[0]?.label;
    g.labelOk = !!l && within(l.kcal, c.label.kcal) && within(l.protein_g, c.label.protein_g) &&
      within(l.carb_g, c.label.carb_g) && within(l.fat_g, c.label.fat_g);
  }
  return g;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (xs: boolean[]) => (xs.length ? `${Math.round(xs.filter(Boolean).length / xs.length * 100)}% (${xs.filter(Boolean).length}/${xs.length})` : "-");

// ── run ─────────────────────────────────────────────────────────────────────

interface Row {
  model: string;
  case: string;
  ok: boolean;
  [k: string]: unknown;
}

const pctErr = (got: number, want: number) => (got - want) / want * 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const show = (n: number, unit = "%") => (Number.isNaN(n) ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(0)}${unit}`);

const rows: Row[] = [];
console.log(`${cases.length} cases | scale hint ${withScale ? "ON" : "off"} | note ${noteMode || "none"} | end to end ${e2e ? "Quick" : "off"} | API\n`);
for (const model of models) {
  const kinds: boolean[] = [];
  const labels: boolean[] = [];
  const massErr: number[] = []; // signed %
  const massIn: boolean[] = [];
  const kcalErr: number[] = [];
  const fatErr: number[] = []; // signed g
  const carbErr: number[] = [];
  const protErr: number[] = [];
  let inTok = 0, outTok = 0, calls = 0, failed = 0, tries2 = 0;
  const ms: number[] = [];

  const runCase = async (c: Case) => {
    const note = noteFor(c);
    const images: PhotoImage[] = [];
    for (const p of c.images) {
      const path = p.startsWith("/") ? p : `${casesDir}${p}`;
      const img = { ...(await prepare(path)) };
      if (withScale && c.rig) {
        const px = await pixelSize(path);
        if (px) {
          img.scale = {
            distance_cm: Math.round(c.rig.distance_cm),
            long_cm: Math.round(Math.max(px.w, px.h) * c.rig.cm_per_px),
            short_cm: Math.round(Math.min(px.w, px.h) * c.rig.cm_per_px),
          };
        }
      }
      images.push(img);
    }
    for (let k = 0; k < repeat; k++) {
      const res = await readFoodPhoto({ anthropicApiKey: apiKey, model, timeoutMs: 60_000, effort }, images, note);
      calls++;
      inTok += res.usage.input_tokens;
      outTok += res.usage.output_tokens;
      ms.push(res.ms);
      if (res.tries > 1) tries2++;
      if (!res.ok) {
        failed++;
        console.log(`  ${model} ${c.id}: FAILED ${res.error}`);
        rows.push({ model, case: c.id, ok: false, error: res.error });
        continue;
      }
      const g = grade(c, res.read, note);
      const made = photoToText(res.read, note);
      kinds.push(g.kindOk);
      if (g.labelOk !== null) labels.push(g.labelOk);
      const row: Row = { model, case: c.id, ok: true, read: res.read, text: made.text, grade: g, usage: res.usage, ms: res.ms };
      let line = `  ${model} ${c.id}: ${res.read.kind}${g.kindOk ? "" : ` (want ${c.kind})`}`;
      if (c.truth && res.read.kind === "plate" && !c.smoke) {
        const best = res.read.items.reduce((t, i) => t + (i.grams?.best ?? 0), 0);
        const low = res.read.items.reduce((t, i) => t + (i.grams?.low ?? 0), 0);
        const high = res.read.items.reduce((t, i) => t + (i.grams?.high ?? 0), 0);
        massErr.push(pctErr(best, c.truth.mass_g));
        massIn.push(c.truth.mass_g >= low && c.truth.mass_g <= high);
        row.mass = { read_g: Math.round(best), low: Math.round(low), high: Math.round(high), truth_g: c.truth.mass_g };
        line += ` | ${Math.round(best)} g (truth ${Math.round(c.truth.mass_g)})`;
        if (e2e && made.text) {
          try {
            const parsed = await runParseMeal(parseDeps, {
              text: made.text, localHour: 13, mealHint: null, mode: "fast",
              recentFoods: [], todayTotals: null, targets: null, photo: made.forParse,
            });
            // The assumed fat is on the card unless the user removes it, so it counts.
            const items = parsed.parsed ? markPhotoLines(parsed.parsed.items, res.read, made.assumed) : [];
            const sum = (f: (i: typeof items[number]) => number) => items.reduce((t, i) => t + (f(i) || 0), 0);
            const got = { kcal: sum((i) => i.kcal), fat_g: sum((i) => i.fat_g), carb_g: sum((i) => i.carb_g), protein_g: sum((i) => i.protein_g) };
            if (items.length) {
              kcalErr.push(pctErr(got.kcal, c.truth.kcal));
              fatErr.push(got.fat_g - c.truth.fat_g);
              carbErr.push(got.carb_g - c.truth.carb_g);
              protErr.push(got.protein_g - c.truth.protein_g);
              row.e2e = { ...got, truth: c.truth, items: items.map((i) => `${i.food_name} ${Math.round(i.grams)} g ${Math.round(i.kcal)} kcal`) };
              line += ` | ${Math.round(got.kcal)} kcal (truth ${Math.round(c.truth.kcal)})`;
            } else {
              row.e2e = { declined: parsed.declined?.message ?? "no items" };
              line += " | parse gave no items";
            }
          } catch (e) {
            row.e2e = { error: String(e).slice(0, 200) };
            line += ` | parse failed: ${String(e).slice(0, 80)}`;
          }
        }
      } else {
        line += ` | ${made.text || "(no words)"}`;
      }
      console.log(line);
      rows.push(row);
    }
  };

  // A small pool: cases are independent.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(pool, cases.length) }, async () => {
    while (next < cases.length) await runCase(cases[next++]);
  }));

  const abs = (xs: number[]) => xs.map(Math.abs);
  const [pi, po] = PRICE[model] ?? [NaN, NaN];
  const cost = (inTok * pi + outTok * po) / 1e6;
  console.log(`\n${model} (effort ${effort}, scale ${withScale ? "on" : "off"}, note ${noteMode || "none"}, API, ${calls} reads, ${failed} failed, ${tries2} needed a 2nd try)`);
  console.log(`  photo kind right        ${pct(kinds)}`);
  if (labels.length) console.log(`  label numbers right     ${pct(labels)}`);
  if (massErr.length) {
    console.log(`  WEIGHT  median error    ${median(abs(massErr)).toFixed(0)}%   (mean bias ${show(mean(massErr))}, n=${massErr.length})`);
    console.log(`          truth in range  ${pct(massIn)}`);
  }
  if (kcalErr.length) {
    console.log(`  CALORIES median error   ${median(abs(kcalErr)).toFixed(0)}%   (mean bias ${show(mean(kcalErr))}, n=${kcalErr.length})`);
    console.log(`          within 20%      ${pct(kcalErr.map((e) => Math.abs(e) <= 20))}`);
    console.log(`  fat bias ${show(mean(fatErr), " g")} | carb bias ${show(mean(carbErr), " g")} | protein bias ${show(mean(protErr), " g")}`);
  }
  console.log(`  tokens per read         ${Math.round(inTok / calls)} in, ${Math.round(outTok / calls)} out`);
  console.log(`  cost per read           $${(cost / calls).toFixed(5)}  (reads total $${cost.toFixed(4)})`);
  console.log(`  read latency, median    ${Math.round(median(ms))} ms (API)\n`);
}

const out = Deno.env.get("OUT");
if (out) {
  await Deno.writeTextFile(out, JSON.stringify(rows, null, 2));
  console.log(`Every read: ${out}`);
}
