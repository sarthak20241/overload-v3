// Photo food logging: compare the photo-read models (FOOD_PHOTO_MODEL).
//
//   ANTHROPIC_API_KEY=... deno run -A scripts/food-photo-eval/run.ts
//   MODELS=claude-haiku-5-5 ONLY=label-bar deno run -A ...      # one model, some cases
//   CASES=~/.config/overload/food-photos/cases.json deno run -A ...  # the weighed set
//   REPEAT=3 deno run -A ...                                      # how steady a read is
//   OUT=/tmp/photo-eval.json deno run -A ...                      # every read, for a closer look
//
// It runs the READ stage only: the vision call (foodPhoto.ts readFoodPhoto),
// then the words it makes (photoToText). It grades what the read controls:
// the photo kind, each weighed food's grams against the scale, whether the
// truth falls inside the read's low..high range, an assumed fat where one
// was used, and a label's printed numbers. Calories come from the catalog
// after this stage, so a calorie error here would measure the catalog too;
// that end-to-end number is a follow-up (feed `text` to parse-meal-eval).
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
  photoToText,
  type PhotoImage,
  type PhotoRead,
  readFoodPhoto,
} from "../../supabase/functions/ai-coach/foodPhoto.ts";

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
}

const here = new URL(".", import.meta.url).pathname;
const casesPath = Deno.env.get("CASES") ?? `${here}cases.json`;
const casesDir = casesPath.slice(0, casesPath.lastIndexOf("/") + 1);
const only = (Deno.env.get("ONLY") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const models = (Deno.env.get("MODELS") ?? FOOD_PHOTO_MODELS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const repeat = Math.max(1, Number(Deno.env.get("REPEAT") ?? 1) || 1);
const effort = (Deno.env.get("EFFORT") ?? "medium") as "low" | "medium" | "high";
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

const rows: Record<string, unknown>[] = [];
for (const model of models) {
  const kinds: boolean[] = [];
  const errs: number[] = [];
  const ranges: boolean[] = [];
  const fats: boolean[] = [];
  const labels: boolean[] = [];
  const missed: string[] = [];
  let inTok = 0, outTok = 0, calls = 0, failed = 0;
  const ms: number[] = [];
  for (const c of cases) {
    const images = await Promise.all(c.images.map((p) => prepare(p.startsWith("/") ? p : `${casesDir}${p}`)));
    for (let k = 0; k < repeat; k++) {
      const res = await readFoodPhoto({ anthropicApiKey: apiKey, model, timeoutMs: 60_000, effort }, images, c.note ?? "");
      calls++;
      inTok += res.usage.input_tokens;
      outTok += res.usage.output_tokens;
      ms.push(res.ms);
      if (!res.ok) {
        failed++;
        console.log(`  ${model} ${c.id}: FAILED ${res.error}`);
        rows.push({ model, case: c.id, ok: false, error: res.error });
        continue;
      }
      const g = grade(c, res.read, c.note ?? "");
      const text = photoToText(res.read, c.note ?? "").text;
      console.log(`  ${model} ${c.id}: ${res.read.kind}${g.kindOk ? "" : ` (want ${c.kind})`} | ${text || "(no words)"}${res.read.question ? ` | asks: ${res.read.question}` : ""}`);
      rows.push({ model, case: c.id, ok: true, read: res.read, text, grade: g, usage: res.usage, ms: res.ms });
      kinds.push(g.kindOk);
      if (c.smoke) continue;
      errs.push(...g.gramErrors);
      ranges.push(...g.inRange);
      missed.push(...g.missed.map((m) => `${c.id}:${m}`));
      if (g.fatOk !== null) fats.push(g.fatOk);
      if (g.labelOk !== null) labels.push(g.labelOk);
    }
  }
  const [pi, po] = PRICE[model] ?? [NaN, NaN];
  const cost = (inTok * pi + outTok * po) / 1e6;
  console.log(`\n${model} (effort ${effort}, API, ${calls} reads, ${failed} failed)`);
  console.log(`  photo kind right      ${pct(kinds)}`);
  console.log(`  grams, median error   ${Number.isNaN(median(errs)) ? "-" : `${median(errs).toFixed(0)}%`} over ${errs.length} weighed foods`);
  console.log(`  truth inside range    ${pct(ranges)}`);
  console.log(`  weighed foods missed  ${missed.length ? missed.join(", ") : "none"}`);
  console.log(`  assumed fat right     ${pct(fats)}`);
  console.log(`  label numbers right   ${pct(labels)}`);
  console.log(`  tokens per read       ${Math.round(inTok / calls)} in, ${Math.round(outTok / calls)} out`);
  console.log(`  cost per read         $${(cost / calls).toFixed(5)}  (run total $${cost.toFixed(4)})`);
  console.log(`  latency, median       ${Math.round(median(ms))} ms (API)\n`);
}

const out = Deno.env.get("OUT");
if (out) {
  await Deno.writeTextFile(out, JSON.stringify(rows, null, 2));
  console.log(`Every read: ${out}`);
}
