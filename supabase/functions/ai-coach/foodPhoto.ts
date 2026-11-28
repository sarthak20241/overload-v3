// Photo food logging (FOOD_PHOTO).
//
// The food box can send one or two photos with an optional note. ONE vision
// call reads them into a list of foods and weights. Code then turns that list
// into the words the text pipeline already reads, with each weight as a typed
// weight ("grilled chicken breast (~150 g)", statedNumbers.ts readTypedWeight).
// From there it is an ordinary food message: the catalog supplies calories and
// macros, Quick and Precise both work, threads record it, and "the rice was
// one cup" corrects it like any other card.
//
// WHY THIS SHAPE (research read 2026-11-28, sources in the PR):
// - The model names foods and weights and never states calories for a plate.
//   Recognition errors cascade when the model also prices the food; a database
//   lookup after itemising is what the accurate trackers do.
// - The user's note is the biggest accuracy lever (dish mass most of all), so
//   the note is ground truth and overrides the picture, in the prompt AND in
//   code (assumedFats reads the note itself).
// - Hidden cooking fat is the main systematic miss. A fried or curry-style
//   dish with no fat in the note gets ONE assumed line the user can remove,
//   the same "assume it, show it, ask once" rule as recipe.ts.
// - A packaged label is copied as printed. A field that could not be read is
//   left out and flagged. It is never written as 0.
//
// The request is a shape every current model takes, so the model can be
// switched by measurement (FOOD_PHOTO_MODEL): structured output through
// output_config.format, no forced tool_choice (Sonnet 5.5 rejects it), no
// thinking or sampling fields.
//
// The base64 never leaves this file except inside the model request: not in a
// log line, not in an error, not on a trace.
//
// No Deno globals and no IO except the injected fetch in readFoodPhoto.

import { assumedAmount } from "./recipe.ts";

// ── The flag, the capability, the model ─────────────────────────────────────

export type FoodPhotoMode = "off" | "on";

/** FOOD_PHOTO: anything but "on" is off. */
export function parseFoodPhotoMode(raw: string | undefined): FoodPhotoMode {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

/** What a build sends in `supports` to say it has the camera step. A build
 *  without it never sends `images`, and is never served a photo answer. */
export const CLIENT_CAP_FOOD_PHOTO = "food_photo";

/** The models the photo read may run on. The request shape below is one both
 *  take; scripts/food-photo-eval compares them. */
export const FOOD_PHOTO_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
/** Haiku until the eval says otherwise: the same model the text parse uses,
 *  at a twentieth of Sonnet's price per token. Not yet measured on photos. */
export const FOOD_PHOTO_DEFAULT_MODEL: string = "claude-haiku-5-5";

/** FOOD_PHOTO_MODEL: a listed model, else the default. */
export function foodPhotoModel(raw: string | undefined): string {
  const want = raw?.trim();
  return want && (FOOD_PHOTO_MODELS as readonly string[]).includes(want) ? want : FOOD_PHOTO_DEFAULT_MODEL;
}

// ── The request gate ────────────────────────────────────────────────────────

export const FOOD_PHOTO_MAX_IMAGES = 2;
/** Per image, decoded. The app sends about 0.3 to 0.6 MB (1568 px long edge,
 *  JPEG quality 80); this leaves room and still keeps a request small. */
export const FOOD_PHOTO_MAX_BYTES = 3_000_000;
/** Same cap as a typed food message (parseMeal.ts USER_TEXT_MAX_CHARS). */
const NOTE_MAX_CHARS = 2000;

export type PhotoMediaType = "image/jpeg" | "image/png" | "image/webp";
const MEDIA_TYPES = new Set<string>(["image/jpeg", "image/png", "image/webp"]);

export interface PhotoImage {
  media_type: PhotoMediaType;
  /** Base64, no data: prefix. */
  data: string;
  bytes: number;
}

export type PhotoGate =
  /** No images: exactly today's request. */
  | { kind: "none" }
  /** Images, but the flag is off or the client did not claim the capability. */
  | { kind: "unavailable" }
  | { kind: "bad"; error: "too_many_images" | "image_type" | "image_data" | "image_too_large" }
  | { kind: "photo"; images: PhotoImage[]; note: string };

/** The first bytes of the image, to check the type it claims. */
function sniff(b64: string): PhotoMediaType | null {
  let head: string;
  try {
    head = atob(b64.slice(0, 16));
  } catch {
    return null;
  }
  const c = (i: number) => head.charCodeAt(i);
  if (c(0) === 0xff && c(1) === 0xd8 && c(2) === 0xff) return "image/jpeg";
  if (c(0) === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Read `images` off a parse_meal body. Never throws. */
export function readPhotoRequest(body: Record<string, unknown>, opts: { mode: FoodPhotoMode }): PhotoGate {
  const raw = body?.images;
  if (!Array.isArray(raw) || raw.length === 0) return { kind: "none" };
  const claims = Array.isArray(body.supports) && (body.supports as unknown[]).includes(CLIENT_CAP_FOOD_PHOTO);
  if (opts.mode !== "on" || !claims) return { kind: "unavailable" };
  if (raw.length > FOOD_PHOTO_MAX_IMAGES) return { kind: "bad", error: "too_many_images" };
  const images: PhotoImage[] = [];
  for (const r of raw) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    if (typeof o.media_type !== "string" || !MEDIA_TYPES.has(o.media_type)) return { kind: "bad", error: "image_type" };
    const data = o.data;
    if (typeof data !== "string" || data.length < 16 || data.length % 4 !== 0) return { kind: "bad", error: "image_data" };
    const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = (data.length / 4) * 3 - pad;
    if (bytes > FOOD_PHOTO_MAX_BYTES) return { kind: "bad", error: "image_too_large" };
    if (!BASE64.test(data)) return { kind: "bad", error: "image_data" };
    if (sniff(data) !== o.media_type) return { kind: "bad", error: "image_type" };
    images.push({ media_type: o.media_type as PhotoMediaType, data, bytes });
  }
  const note = typeof body.text === "string" ? body.text.trim().slice(0, NOTE_MAX_CHARS) : "";
  return { kind: "photo", images, note };
}

/**
 * What the server answers before any model call and before a parse slot is
 * spent, or null to go on. No images: null, so every other request is exactly
 * today's. Flag off (or a client that did not claim the camera step): a plain
 * reply, since the photo is not the user's mistake. A photo beside a card
 * under review is refused: the app opens the camera only with no card, and
 * marking a correction's kept lines as photo reads would be wrong.
 */
export function photoRefusal(
  gate: PhotoGate,
  ctx: { cardLines: number },
): { status: number; body: Record<string, unknown> } | null {
  if (gate.kind === "none") return null;
  if (gate.kind === "unavailable") {
    return {
      status: 200,
      body: {
        parsed: null,
        declined: { message: "I can't read photos on your account yet. Type what you ate and I'll log it." },
        proposal: null,
      },
    };
  }
  if (gate.kind === "bad") return { status: 400, body: { error: gate.error } };
  if (ctx.cardLines > 0) return { status: 400, body: { error: "photo_with_card" } };
  return null;
}

// ── What the model returns ──────────────────────────────────────────────────

export type PhotoKind = "plate" | "label" | "not_food" | "unclear";
type Meal = "breakfast" | "lunch" | "dinner" | "snack";
type Confidence = "high" | "medium" | "low";
export type HiddenName = "oil" | "ghee" | "butter" | "dressing" | "sugar" | "cream" | "mayonnaise";
const HIDDEN_NAMES: HiddenName[] = ["oil", "ghee", "butter", "dressing", "sugar", "cream", "mayonnaise"];
const COOKING_FATS = new Set<HiddenName>(["oil", "ghee", "butter"]);
export type UnreadField = "calories" | "protein" | "carbs" | "fat";

export interface PhotoLabel {
  basis: "per_100g" | "per_100ml" | "per_serving";
  serving_g: number | null;
  kcal: number | null;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  /** The fields that could not be read, in a fixed order. Fiber is not one:
   *  many labels do not print it. */
  unread: UnreadField[];
}

export interface PhotoItem {
  name: string;
  brand: string | null;
  method: string | null;
  count: number | null;
  unit: string | null;
  grams: { low: number; best: number; high: number } | null;
  /** Where the weight came from. `note`: the user gave it, so it is not an
   *  estimate. */
  grams_from: "note" | "photo" | "label";
  scale_cue: string | null;
  confidence: Confidence;
  hidden: { name: HiddenName; in_note: boolean }[];
  /** Printed values. Only ever set on a label photo. */
  label: PhotoLabel | null;
}

export interface PhotoRead {
  kind: PhotoKind;
  meal: Meal | null;
  items: PhotoItem[];
  question: string | null;
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The structured output form. A plate item has no field for calories or
 *  macros on purpose: printed values live only under `label`. */
export const PHOTO_READ_SCHEMA: Record<string, unknown> = obj({
  kind: {
    type: "string",
    enum: ["plate", "label", "not_food", "unclear"],
    description: "plate: prepared or served food or drink. label: a package with printed nutrition values. not_food: nothing to log. unclear: too dark, blurred or cropped to read.",
  },
  meal: nullable({ type: "string", enum: ["breakfast", "lunch", "dinner", "snack"], description: "Only when the note names the meal." }),
  items: {
    type: "array",
    items: obj({
      name: { type: "string", description: "The food as a person would search for it in a food database. Not a description of the picture." },
      brand: nullable({ type: "string", description: "Only when printed on a package or given in the note." }),
      method: nullable({ type: "string", description: "Cooking method in one word when it matters: grilled, fried, boiled, steamed, sauteed, roasted, baked, raw." }),
      count: nullable({ type: "number", description: "For countable food: how many (2 rotis is 2)." }),
      unit: nullable({ type: "string", description: "The counted unit: piece, slice, bowl, cup, glass." }),
      grams: nullable(obj({
        low: { type: "number" },
        best: { type: "number" },
        high: { type: "number" },
      })),
      grams_from: { type: "string", enum: ["note", "photo", "label"], description: "note: the note gave the amount. photo: estimated from the picture. label: a printed serving." },
      scale_cue: nullable({ type: "string", description: "The visible object the weight was judged against, or null when there was none." }),
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      hidden: {
        type: "array",
        description: "Fat or sugar likely added that the camera cannot see and the name does not already cover.",
        items: obj({
          name: { type: "string", enum: HIDDEN_NAMES },
          in_note: { type: "boolean", description: "True when the note names it, gives its amount, or says there was none." },
        }),
      },
      label: nullable(obj({
        basis: { type: "string", enum: ["per_100g", "per_100ml", "per_serving"] },
        serving_g: nullable({ type: "number", description: "The printed serving weight in grams." }),
        kcal: nullable({ type: "number" }),
        protein_g: nullable({ type: "number" }),
        carb_g: nullable({ type: "number" }),
        fat_g: nullable({ type: "number" }),
        fiber_g: nullable({ type: "number" }),
        unread: { type: "array", items: { type: "string", enum: ["calories", "protein", "carbs", "fat"] }, description: "Printed fields you could not read." },
      })),
    }),
  },
  question: nullable({ type: "string", description: "One short question, only when its answer would change the log a lot and the note does not give it." }),
});

export const PHOTO_SYSTEM = `You read food photos for a calorie tracking app. A person photographed what they ate and may have added a note. Your reading becomes a food log that the person checks and corrects, and a nutrition database supplies the calories afterwards. So your job is to say what the food is and how much of it there is, as accurately as the picture and the note allow. Do not estimate calories or macros for a plate of food: the database does that from your names and weights, and a number from you would only get in its way.

The note is the truth. The person knows what they cooked and ate; the camera does not. When the note and the picture disagree, follow the note: its food names, its amounts, its cooking method, and what was or was not eaten ("ate half", "no rice", "left the bread"). Put every food the note names into items even when you cannot see it, and leave out anything the note says was not eaten. For each weight say where it came from: note, photo, or label.

First decide what the picture is:
- plate: prepared or served food or drink.
- label: a package showing printed nutrition values.
- not_food: nothing edible to log.
- unclear: there may be food, but the picture is too dark, blurred or cropped to read.
Two images show the same meal from a second angle, or a product and its label. Read them together and list each food once.

For a plate:
- One item per distinct food. Name it the way a person would search a food database, specific enough to find the right entry ("grilled chicken breast", "dal tadka", "steamed basmati rice"). Sauces, chutneys, dressings and drinks are items too.
- Give the weight in grams of the portion as served: your best estimate, with a low and a high you would be surprised to see broken. Judge it against something you can actually see whose size you know: a fork or spoon, a hand, the plate or bowl, a can, an egg, a slice of bread. Name the cue you used. With no cue, say so and widen the range. A second angle helps with depth; use it.
- When the food is countable (2 rotis, 3 eggs, 1 slice), give the count and the unit as well as the total weight.
- Confidence covers both what the food is and how much there is.
- Hidden additions: food is often cooked or finished with fat or sugar the camera cannot see. For each item list what was likely added that its name does not already cover: oil, ghee or butter for fried, sauteed, tempered or curry-style dishes; butter or ghee on breads; dressing on salad; sugar in drinks; cream; mayonnaise. For each one say whether the note already covers it, meaning the note names it, gives its amount, or says there was none. List nothing for plainly boiled, steamed, raw or packaged food.

For a label:
- Copy the printed values exactly as printed. If you cannot read a value, leave it null and list it in unread. Never write 0 for a value you could not read; write 0 only where the label prints 0.
- Give the basis the label prints (per 100 g, per 100 ml, or per serving) and the printed serving weight when there is one. Prefer the per 100 g column when both are printed.
- The amount eaten comes from the note. If the note gives none, leave the weight null.
- Name and brand as printed.

If one thing you cannot tell would change the log a lot (paneer or tofu, regular or diet, how much of a shared dish was theirs) and the note does not answer it, ask one short question. Otherwise leave the question null.`;

/** The model request. Images first, labelled when there are two, the note
 *  last (vision guide: image before text). */
export function buildPhotoPayload(
  images: PhotoImage[],
  note: string,
  model: string,
  opts: { effort?: "low" | "medium" | "high"; maxTokens?: number } = {},
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  images.forEach((img, i) => {
    if (images.length > 1) content.push({ type: "text", text: `Image ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  });
  content.push({
    type: "text",
    text: note ? `The person's note: ${note}` : "The person added no note.",
  });
  return {
    model,
    // Thinking tokens count against this. A read is a few hundred tokens.
    max_tokens: opts.maxTokens ?? 6000,
    system: PHOTO_SYSTEM,
    output_config: {
      effort: opts.effort ?? "medium",
      format: { type: "json_schema", schema: PHOTO_READ_SCHEMA },
    },
    messages: [{ role: "user", content }],
  };
}

// ── Reading the answer ──────────────────────────────────────────────────────

const MAX_ITEMS = 12;

const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A name or unit that cannot break the sentence it is put in: letters,
 *  digits, spaces, and - ' & % only. */
function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[^\p{L}\p{N}\s\-'&%]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

const UNREAD_ORDER: UnreadField[] = ["calories", "protein", "carbs", "fat"];

function readLabel(raw: unknown): PhotoLabel | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const basis = o.basis;
  if (basis !== "per_100g" && basis !== "per_100ml" && basis !== "per_serving") return null;
  const flagged = new Set(Array.isArray(o.unread) ? o.unread.filter((u): u is UnreadField => UNREAD_ORDER.includes(u as UnreadField)) : []);
  // A field the model said it could not read carries no number, whatever it
  // also wrote there; a null it did not flag is flagged here.
  const field = (v: unknown, name: UnreadField): number | null => {
    const n = flagged.has(name) ? null : nonNeg(v);
    if (n === null) flagged.add(name);
    return n;
  };
  const serving = posNum(o.serving_g);
  return {
    basis,
    serving_g: serving !== null && serving <= 2000 ? r1(serving) : null,
    kcal: field(o.kcal, "calories"),
    protein_g: field(o.protein_g, "protein"),
    carb_g: field(o.carb_g, "carbs"),
    fat_g: field(o.fat_g, "fat"),
    fiber_g: nonNeg(o.fiber_g),
    unread: UNREAD_ORDER.filter((u) => flagged.has(u)),
  };
}

function readGrams(raw: unknown): PhotoItem["grams"] {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const best = posNum(o.best);
  if (best === null || best < 1 || best > 3000) return null;
  const low = posNum(o.low) ?? best * 0.7;
  const high = posNum(o.high) ?? best * 1.3;
  // Inside a real portion (a bound past it falls back to best), and around
  // best: best is never moved, since it may be the user's own weight.
  // Swapped bounds are put back in order first.
  const fit = (n: number) => (n >= 0.5 && n <= 5000 ? n : best);
  const lo = Math.min(fit(low), fit(high));
  const hi = Math.max(fit(low), fit(high));
  return { low: r1(Math.min(lo, best)), best: r1(best), high: r1(Math.max(hi, best)) };
}

/** The model's JSON as a PhotoRead, or null when it is not one. Everything
 *  the rest of this file trusts is checked here. */
export function parsePhotoRead(raw: unknown): PhotoRead | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "plate" && kind !== "label" && kind !== "not_food" && kind !== "unclear") return null;
  const meal = o.meal === "breakfast" || o.meal === "lunch" || o.meal === "dinner" || o.meal === "snack" ? o.meal : null;
  const items: PhotoItem[] = [];
  for (const r of Array.isArray(o.items) ? o.items.slice(0, MAX_ITEMS) : []) {
    const it = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const name = clean(it.name, 80);
    if (!name) continue;
    const count = posNum(it.count);
    const hidden: PhotoItem["hidden"] = [];
    for (const h of Array.isArray(it.hidden) ? it.hidden : []) {
      const ho = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
      if (HIDDEN_NAMES.includes(ho.name as HiddenName) && !hidden.some((x) => x.name === ho.name)) {
        hidden.push({ name: ho.name as HiddenName, in_note: ho.in_note === true });
      }
    }
    items.push({
      name,
      brand: clean(it.brand, 40) || null,
      method: clean(it.method, 20).toLowerCase() || null,
      count: count !== null && count <= 60 ? r1(count) : null,
      unit: count !== null && count <= 60 ? clean(it.unit, 20).toLowerCase() || "piece" : null,
      grams: readGrams(it.grams),
      grams_from: it.grams_from === "note" || it.grams_from === "label" ? it.grams_from : "photo",
      scale_cue: clean(it.scale_cue, 40) || null,
      confidence: it.confidence === "high" || it.confidence === "medium" ? it.confidence : "low",
      hidden,
      // Printed values exist only on a label photo. A plate never carries
      // calories from the model, whatever it sent.
      label: kind === "label" ? readLabel(it.label) : null,
    });
  }
  const question = typeof o.question === "string" ? o.question.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  return { kind, meal, items: kind === "plate" || kind === "label" ? items : [], question: question || null };
}

// ── The call ────────────────────────────────────────────────────────────────

export interface PhotoReadDeps {
  anthropicApiKey: string;
  model: string;
  /** Per try. A broken try is tried once more, so the worst case is twice. */
  timeoutMs: number;
  effort?: "low" | "medium" | "high";
  fetchFn?: typeof fetch;
  /** Wait before the second try. Tests pass 0. */
  retryDelayMs?: number;
}

export interface PhotoUsage {
  input_tokens: number;
  output_tokens: number;
}

export type PhotoReadResult =
  | { ok: true; read: PhotoRead; usage: PhotoUsage; model: string; ms: number; tries: number }
  | { ok: false; error: string; status: number; usage: PhotoUsage; model: string; ms: number; tries: number };

/** HTTP answers worth one more try: the service was busy or broke, not the
 *  request. 400s (a bad request) would fail the same way again. */
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

type Attempt =
  | { ok: true; read: PhotoRead }
  | { ok: false; error: string; status: number; retry: boolean };

/** One call. Never throws. Says whether a failure is worth one more try. */
async function attemptRead(
  deps: PhotoReadDeps,
  body: string,
  usage: PhotoUsage,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await (deps.fetchFn ?? fetch)("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": deps.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, retry: RETRY_STATUS.has(res.status), error: `photo_read_http_${res.status}: ${await res.text()}` };
    }
    // deno-lint-ignore no-explicit-any
    const data = (await res.json()) as any;
    usage.input_tokens += Number(data?.usage?.input_tokens) || 0;
    usage.output_tokens += Number(data?.usage?.output_tokens) || 0;
    // A refusal would refuse again; a cut-off answer is worth one more try.
    if (data?.stop_reason === "refusal") return { ok: false, status: 502, retry: false, error: "photo_read_stop_refusal" };
    if (data?.stop_reason !== "end_turn") {
      return { ok: false, status: 502, retry: true, error: `photo_read_stop_${String(data?.stop_reason).slice(0, 30)}` };
    }
    const text = (Array.isArray(data.content) ? data.content : [])
      // deno-lint-ignore no-explicit-any
      .filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: 502, retry: true, error: "photo_read_not_json" };
    }
    const read = parsePhotoRead(json);
    if (!read) return { ok: false, status: 502, retry: true, error: "photo_read_bad_shape" };
    return { ok: true, read };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      retry: true,
      error: aborted ? `photo_read_timeout_${deps.timeoutMs}ms` : `photo_read_threw: ${String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The vision call, tried at most twice: a busy or broken service, a network
 *  error, a timeout or a garbled answer gets one more try; a bad request or a
 *  refusal does not. Never throws, and never returns a guess. The error text
 *  is short and never holds image data. Tokens of both tries are counted. */
export async function readFoodPhoto(deps: PhotoReadDeps, images: PhotoImage[], note: string): Promise<PhotoReadResult> {
  const t0 = Date.now();
  const usage: PhotoUsage = { input_tokens: 0, output_tokens: 0 };
  const body = JSON.stringify(buildPhotoPayload(images, note, deps.model, { effort: deps.effort }));
  let last: Attempt | null = null;
  let tries = 0;
  for (tries = 1; tries <= 2; tries++) {
    last = await attemptRead(deps, body, usage);
    if (last.ok || !last.retry) break;
    if (tries < 2) await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 800));
  }
  tries = Math.min(tries, 2);
  const base = { usage, model: deps.model, ms: Date.now() - t0, tries };
  if (last && last.ok) return { ok: true, read: last.read, ...base };
  let text = last?.error ?? "photo_read_failed";
  for (const img of images) text = text.split(img.data).join("[image]");
  // Any other long run of base64 (a cut copy of the image) goes too.
  text = text.replace(/[A-Za-z0-9+/=]{64,}/g, "[data]").slice(0, 200);
  return { ok: false, error: text, status: last?.status ?? 502, ...base };
}

// ── Hidden cooking fat ──────────────────────────────────────────────────────

export interface AssumedFat {
  /** As it is written into the words: "cooking oil", "ghee", "butter". */
  name: string;
  grams: number;
  /** "1 tsp", "2 tsp", "1 tbsp". */
  label: string;
  /** The dishes it was assumed for. */
  for: string[];
}

const FAT_WORDS: Record<string, string> = { oil: "cooking oil", ghee: "ghee", butter: "butter" };
/** One tablespoon. More dishes mean more fat, but an assumption stays small:
 *  it is a floor the user can raise, not a guess at a restaurant's pan. */
const ASSUMED_FAT_MAX_G = 15;

/** The note speaks about cooking fat at all: it names one, or says how the
 *  food was cooked without one. Then nothing is assumed; the note is the truth
 *  and the model has already read the amount from it. */
const NOTE_COVERS_FAT = /\b(?:oil|oily|oils|ghee|butter|buttery|makhan|air[- ]?fr(?:ied|yer|y))\b/i;
const NOTE_COVERS: Partial<Record<HiddenName, RegExp>> = {
  dressing: /\bdressing\b/i,
  sugar: /\b(?:sugar|sweetened|unsweetened|sweetener|jaggery|honey)\b/i,
  cream: /\b(?:cream|malai)\b/i,
  mayonnaise: /\bmayo(?:nnaise)?\b/i,
};

const lastWord = (name: string) => name.toLowerCase().trim().split(/\s+/).pop() ?? "";
/** The item is itself a cooking fat ("ghee", "olive oil"), not "peanut butter". */
const isFatItem = (it: PhotoItem) => lastWord(it.name) in FAT_WORDS && assumedAmount(it.name) !== null;

const spoonLabel = (grams: number) => (grams >= 15 ? "1 tbsp" : `${Math.round(grams / 5)} tsp`);

function hiddenOf(read: PhotoRead, note: string): { assumed: AssumedFat[]; ask: HiddenName[] } {
  if (read.kind !== "plate") return { assumed: [], ask: [] };
  const fatCovered = NOTE_COVERS_FAT.test(note) || read.items.some(isFatItem);
  const assumed: AssumedFat[] = [];
  const ask: HiddenName[] = [];
  for (const it of read.items) {
    for (const h of it.hidden) {
      if (h.in_note) continue;
      if (COOKING_FATS.has(h.name)) {
        if (fatCovered) continue;
        const per = assumedAmount(h.name)?.grams ?? 5;
        const have = assumed.find((a) => a.name === FAT_WORDS[h.name]);
        if (have) {
          have.grams = Math.min(ASSUMED_FAT_MAX_G, have.grams + per);
          have.label = spoonLabel(have.grams);
          have.for.push(it.name);
        } else {
          assumed.push({ name: FAT_WORDS[h.name], grams: per, label: spoonLabel(per), for: [it.name] });
        }
      } else if (!NOTE_COVERS[h.name]?.test(note) && !ask.includes(h.name)) {
        ask.push(h.name);
      }
    }
  }
  return { assumed, ask };
}

// ── The read as words ───────────────────────────────────────────────────────

const g = (n: number) => String(n >= 10 ? Math.round(n) : r1(n));

/** "sauteed aloo gobi", never "grilled grilled chicken". */
function namedWith(it: PhotoItem): string {
  const name = it.brand && !it.name.toLowerCase().includes(it.brand.toLowerCase()) ? `${it.brand} ${it.name}` : it.name;
  return it.method && !name.toLowerCase().includes(it.method) && it.method !== "raw" ? `${it.method} ${name}` : name;
}

/** A label item with no amount from the note is one printed serving. */
export const assumesOneServing = (it: PhotoItem) => !!it.label && !it.grams && !it.count && it.label.basis === "per_serving";

function amountOf(it: PhotoItem): string {
  const weight = it.grams ? ` (~${g(it.grams.best)} g)` : "";
  if (it.count) return ` - ${g(it.count)} ${it.unit ?? "piece"}${weight}`;
  if (weight) return weight;
  return assumesOneServing(it) ? " - 1 serving" : "";
}

/** The printed panel as the words the stated-numbers rule reads ("Per 100 g:
 *  130 kcal, 22.5 g protein"). Only what was read: a missing field is left
 *  out, so the tier looks it up instead of logging a 0. No calories read
 *  means no panel at all. */
function panelOf(l: PhotoLabel): string {
  if (l.kcal === null) return "";
  const head = l.basis === "per_100g" ? "Per 100 g" : l.basis === "per_100ml" ? "Per 100 ml" : l.serving_g ? `Per serving (${g(l.serving_g)} g)` : "Per serving";
  const parts = [`${g(l.kcal)} kcal`];
  if (l.protein_g !== null) parts.push(`${r1(l.protein_g)} g protein`);
  if (l.carb_g !== null) parts.push(`${r1(l.carb_g)} g carbs`);
  if (l.fat_g !== null) parts.push(`${r1(l.fat_g)} g fat`);
  if (l.fiber_g !== null) parts.push(`${r1(l.fiber_g)} g fiber`);
  return `. ${head}: ${parts.join(", ")}.`;
}

export interface PhotoText {
  /** The food message the text pipeline parses. */
  text: string;
  assumed: AssumedFat[];
  /** Hidden additions that are asked about, never assumed. */
  ask: HiddenName[];
}

/** The read as a food message. Plate foods are joined by commas, each with
 *  its weight as a typed weight; a label item is its own sentence with the
 *  printed panel. Nothing here states a calorie for plate food. */
export function photoToText(read: PhotoRead, note: string): PhotoText {
  const { assumed, ask } = hiddenOf(read, note);
  const plain: string[] = [];
  const labelled: string[] = [];
  for (const it of read.items) {
    const panel = it.label ? panelOf(it.label) : "";
    (panel ? labelled : plain).push(`${it.label ? (it.brand && !it.name.toLowerCase().includes(it.brand.toLowerCase()) ? `${it.brand} ${it.name}` : it.name) : namedWith(it)}${amountOf(it)}${panel}`);
  }
  for (const a of assumed) plain.push(`${a.name} (~${g(a.grams)} g)`);
  let text = [...labelled, plain.join(", ")].filter(Boolean).join(" ");
  if (read.meal && text) text = `${text.replace(/\.$/, "")} for ${read.meal}${labelled.length && !plain.length ? "." : ""}`;
  return { text, assumed, ask };
}

// ── The card ────────────────────────────────────────────────────────────────

/** The fields of a parsed line this file reads and writes. */
export interface PhotoLine {
  food_name: string;
  grams: number;
  assumption: string | null;
  confidence: Confidence;
  said_name?: string;
}

/** The card shows and sends back this many characters of a line's note. */
const ASSUMPTION_MAX = 160;

const STOP = new Set(["the", "and", "with", "of", "in", "a", "an", "cooked", "raw", "fresh", "plain"]);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
function overlap(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

const capConfidence = (c: Confidence, max: Confidence): Confidence => {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[c] > rank[max] ? max : c;
};

type Target =
  | { type: "item"; name: string; grams: number | null; item: PhotoItem }
  | { type: "fat"; name: string; grams: number; fat: AssumedFat };

function noteFor(t: Target, line: PhotoLine): { text: string | null; max: Confidence } {
  if (t.type === "fat") {
    return { text: `Assumed, not seen: ${t.fat.label} ${t.fat.name} for cooking. Remove it if there was none.`, max: "low" };
  }
  const it = t.item;
  if (it.label && it.label.kcal === null) {
    // No panel went to the parse (panelOf), so the numbers are not the label's.
    return { text: "I could not read the label's numbers, so these are from our food list.", max: "medium" };
  }
  if (it.label) {
    const bits = ["Numbers from the label in your photo."];
    if (it.label.unread.length) bits.push(`I could not read ${it.label.unread.join(" or ")}.`);
    if (assumesOneServing(it)) bits.push("I assumed 1 serving.");
    return { text: bits.join(" "), max: it.label.unread.length ? "medium" : "high" };
  }
  // The user gave this weight. It is theirs, not an estimate.
  if (it.grams_from === "note") return { text: null, max: "high" };
  if (!it.grams) return { text: "I could not judge the amount from your photo. This is a usual serving.", max: "medium" };
  // The card's weight is the photo's read: say its range. A tier that landed
  // somewhere else keeps the plain line, so the numbers never disagree.
  const same = Math.abs(line.grams - it.grams.best) <= Math.max(1, it.grams.best * 0.02);
  return {
    text: same
      ? `Portion read from your photo: about ${g(it.grams.best)} g (${g(it.grams.low)} to ${g(it.grams.high)} g).`
      : "Portion read from your photo. Check the amount.",
    max: capConfidence(it.confidence, "medium"),
  };
}

/**
 * Mark the parsed lines that came from the photo, so the card reads as what
 * it is: a weight read from a picture is an estimate, an assumed fat is an
 * assumption, a label's numbers are the label's. A line is matched to the
 * photo's food by its weight (the typed weight sets the line's grams in every
 * tier) and its name, best match first, each food used once. A weight the
 * user gave in the note is left alone.
 */
export function markPhotoLines<T extends PhotoLine>(lines: T[], read: PhotoRead, assumed: AssumedFat[]): T[] {
  const targets: Target[] = [
    ...read.items.map((item): Target => ({
      type: "item",
      name: item.brand ? `${item.brand} ${item.name}` : item.name,
      grams: item.grams?.best ?? (assumesOneServing(item) ? item.label!.serving_g : null),
      item,
    })),
    ...assumed.map((fat): Target => ({ type: "fat", name: fat.name, grams: fat.grams, fat })),
  ];
  const pairs: { li: number; ti: number; score: number }[] = [];
  lines.forEach((line, li) => {
    targets.forEach((t, ti) => {
      const name = Math.max(overlap(line.food_name, t.name), line.said_name ? overlap(line.said_name, t.name) : 0);
      const weight = t.grams !== null && Math.abs(line.grams - t.grams) <= Math.max(0.5, t.grams * 0.02) ? 1 : 0;
      // An assumed fat is only ever a fat line: weight alone is not enough.
      if (t.type === "fat" && name === 0) return;
      if (name + weight > 0) pairs.push({ li, ti, score: name + weight });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.li - b.li || a.ti - b.ti);
  const lineTarget = new Map<number, Target>();
  const usedTargets = new Set<number>();
  for (const p of pairs) {
    if (lineTarget.has(p.li) || usedTargets.has(p.ti)) continue;
    lineTarget.set(p.li, targets[p.ti]);
    usedTargets.add(p.ti);
  }
  const estimated = read.kind === "plate" && read.items.some((i) => i.grams_from === "photo");
  return lines.map((line, li) => {
    const t = lineTarget.get(li);
    // A line no food matched (the parse split or merged one): still from the
    // photo, so it still says so when any weight was an estimate.
    const mark = t ? noteFor(t, line) : estimated ? { text: "Read from your photo. Check the amount.", max: "medium" as Confidence } : { text: null, max: "high" as Confidence };
    if (!mark.text) return line;
    const assumption = [mark.text, line.assumption].filter(Boolean).join(" ").slice(0, ASSUMPTION_MAX).trim();
    return { ...line, assumption, confidence: capConfidence(line.confidence, mark.max) };
  });
}

const HIDDEN_SAID: Partial<Record<HiddenName, string>> = { dressing: "dressing", sugar: "sugar", cream: "cream", mayonnaise: "mayo" };

/**
 * Drona's line for a photo meal: the parse's own line, then that the portions
 * are a read, then ONE question. The model's own question comes first (its
 * answer changes the most); else the assumed fat is asked about, the way
 * recipe.ts asks ("I assumed 1 tsp oil. Change it?"); else a hidden addition.
 */
export function photoDronaLine(base: string, read: PhotoRead, assumed: AssumedFat[], ask: HiddenName[]): string {
  const said: string[] = [base.trim()];
  if (read.kind === "plate" && read.items.some((i) => i.grams_from === "photo")) {
    said.push("The portions are my read of your photo, so check them.");
  }
  const fats = assumed.map((a) => `${a.label} ${a.name}`);
  const fatSaid = fats.length
    ? `I assumed ${fats.join(" and ")}${assumed.length === 1 && assumed[0].for.length === 1 ? ` for the ${assumed[0].for[0]}` : ""}`
    : null;
  if (read.question) {
    if (fatSaid) said.push(`${fatSaid}.`);
    said.push(read.question.endsWith("?") ? read.question : `${read.question.replace(/[.!]+$/, "")}?`);
  } else if (fatSaid) {
    said.push(`${fatSaid}. Change ${fats.length === 1 ? "it" : "them"}?`);
  } else if (ask.length) {
    said.push(`Was there any ${ask.map((a) => HIDDEN_SAID[a] ?? a).join(" or ")} on it?`);
  }
  return said.filter(Boolean).join(" ");
}

/** Why this photo is not a meal, in Drona's words, or null when it is one. */
export function photoDecline(read: PhotoRead): string | null {
  if (read.kind === "not_food") {
    return "I can't find food in that photo. Take it again with the whole plate in frame, or type what you ate.";
  }
  if (read.kind === "unclear" || read.items.length === 0) {
    return "That photo is too dark or too close for me to read. Take it again from above, in good light, with the whole plate in frame.";
  }
  return null;
}

/** What the trace keeps of a photo request: sizes and counts, never the image. */
export function photoTraceView(images: PhotoImage[], res: PhotoReadResult | null): Record<string, unknown> {
  return {
    images: images.map((i) => ({ media_type: i.media_type, bytes: i.bytes })),
    ...(res
      ? {
        model: res.model,
        ms: res.ms,
        tries: res.tries,
        ok: res.ok,
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        ...(res.ok
          ? {
            kind: res.read.kind,
            items: res.read.items.map((i) => ({
              name: i.name, grams: i.grams, grams_from: i.grams_from, cue: i.scale_cue, confidence: i.confidence,
              hidden: i.hidden, label: i.label,
            })),
            question: res.read.question,
          }
          : { error: res.error, status: res.status }),
      }
      : {}),
  };
}
