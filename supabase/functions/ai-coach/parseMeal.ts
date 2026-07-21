// parse_meal mode: free-text food logging ("oats yogabar 50g and milk 500 ml")
// parsed into catalog-grounded meal entries. Kept separate from index.ts and
// runtime-agnostic (no Deno/jsr imports, dependencies injected) so the eval
// harness in scripts/parse-meal-eval/ can drive the exact production pipeline
// from Node against real catalog data.
//
// Architecture: extract -> resolve -> decide.
//   1. EXTRACT  one fast model call, no tools: segment the text into items
//               ({name, brand, quantity, unit, prep}), or decline non-food.
//   2. RESOLVE  pure code, all items in parallel: catalog search (trigram +
//               semantic fallback via deps.searchFoods), then live Open Food
//               Facts on a miss (backfilled into `foods`, source 'off', so
//               the catalog compounds with usage). Spoon anchors (1 tbsp =
//               cup/16) are synthesized here, in code.
//   3. DECIDE   one model call with candidates inline: pick per item,
//               convert to grams, emit log_meal. Server web_search remains
//               available for named products neither lookup has (capped);
//               model estimate is the flagged last resort (food_id null).
//
// The model only MATCHES candidates and converts quantities; macros for
// catalog/off rows are recomputed server-side (verifyItems) and every line
// passes the deterministic guardrails (density clamp, Atwater, prep-state),
// so catalog-backed numbers are never model-invented.

// ── Types ───────────────────────────────────────────────────────────────────

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface ServingOption {
  label: string;
  grams: number;
  is_default?: boolean;
}

// Candidate returned by both catalog search and the OFF lookup. Per-100
// basis matches the foods table (kcal/macros are per 100 base units).
export interface CandidateFood {
  food_id: string | null;
  name: string;
  brand: string | null;
  base_unit: "g" | "ml";
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  servings: ServingOption[];
  source: "catalog" | "off";
}

export interface ParsedItem {
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_label: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  // 'manual' never originates here: it comes back from the client when the user
  // corrected a line in the review card, and must round-trip intact.
  source: "catalog" | "off" | "web" | "estimate" | "manual";
  assumption: string | null;
  confidence: "high" | "medium" | "low";
}

// One entry in the agent's tool-call trail, captured for observability + eval.
// `input` is the tool's args; `result` is a compact summary of what it returned.
export interface ParseStep {
  iter: number;
  tool: string;
  input?: unknown;
  result?: unknown;
}

export interface ParseMealResult {
  parsed: {
    meal_type: MealType;
    items: ParsedItem[];
    drona_line: string;
    /** True when these items are a corrected version of the meal the client
     *  sent as `previousItems` and should REPLACE it. False (the default) means
     *  they are new food, so a client showing a pending meal appends them. */
    corrects_previous?: boolean;
  } | null;
  // Set when the model declined (non-food input) instead of logging.
  declined: { message: string } | null;
  /** A researched alternative the user should CHOOSE, not receive silently.
   *  Set when a web lookup materially disagrees with what is on screen -
   *  usually a different variant of the same product. The client offers it as
   *  "use these / keep mine"; applying it costs no further round trip. */
  proposal?: { items: ParsedItem[]; note: string } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    web_search_requests: number;
  };
  tool_calls: string[];
  // The full tool-call trail (search_foods / lookup_packaged_food / web_search /
  // log_meal) with args + result summaries, plus how many loop turns it took.
  steps: ParseStep[];
  iterations: number;
}

export interface RecentFoodContext {
  food_name: string;
  quantity: number;
  serving_unit: string;
}

/** A line from the meal still under review on the client, sent back with a
 *  follow-up so "make it a small one" can re-target it. */
export interface PreviousItem {
  food_id: string | null;
  food_name: string;
  quantity: number;
  serving_label: string;
  grams: number;
  // The line's current macros. Carried so an untouched line can be handed back
  // EXACTLY as it was: correction paths replace the whole meal, so anything we
  // cannot reconstruct would be silently deleted.
  kcal?: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  fiber_g?: number | null;
  source?: ParsedItem["source"];
  assumption?: string | null;
  confidence?: ParsedItem["confidence"];
}

/** An untouched previous line, rebuilt verbatim. */
function previousAsParsedItem(p: PreviousItem): ParsedItem {
  return {
    food_id: p.food_id,
    food_name: p.food_name,
    quantity: p.quantity,
    serving_label: p.serving_label,
    grams: p.grams,
    kcal: p.kcal ?? 0,
    protein_g: p.protein_g ?? 0,
    carb_g: p.carb_g ?? 0,
    fat_g: p.fat_g ?? 0,
    fiber_g: p.fiber_g ?? null,
    source: p.source ?? "estimate",
    assumption: p.assumption ?? null,
    confidence: p.confidence ?? "medium",
  };
}

/**
 * Guarantee a "corrected meal" still contains everything it replaces.
 *
 * Correction paths hand back a full item list that REPLACES the meal on screen,
 * and both the model and the fast path are merely *asked* to relist untouched
 * lines. That is a prompt instruction, not an invariant, so anything they omit
 * would silently delete food the user already reviewed. Any previous line not
 * represented in the result is appended back, unchanged.
 */
function keepUncoveredPrevious(items: ParsedItem[], previous: PreviousItem[]): ParsedItem[] {
  if (previous.length === 0) return items;
  const covered = (p: PreviousItem) =>
    items.some((it) =>
      (p.food_id && it.food_id === p.food_id) || wordsOverlap(it.food_name, p.food_name)
    );
  const missing = previous.filter((p) => !covered(p)).map(previousAsParsedItem);
  return missing.length > 0 ? [...items, ...missing] : items;
}

export interface ParseMealInput {
  text: string;
  localHour: number | null;
  mealHint: MealType | null;
  /** Set only when a parsed-but-unlogged meal is on screen. */
  previousText?: string | null;
  previousItems?: PreviousItem[];
  /** The last few turns of this logging conversation, oldest first. Without it
   *  Drona can see the meal but not what either side just SAID, so a reply like
   *  "yes do that" or "no the other one" has nothing to attach to. */
  recentTurns?: { role: "user" | "drona"; text: string }[];
  recentFoods: RecentFoodContext[];
  todayTotals: { kcal: number; protein_g: number } | null;
  targets: { daily_calorie_target: number | null; protein_target_g: number | null } | null;
  // Optional: when set, the recents/targets/totals above are placeholders and
  // these values are awaited AFTER the extract call — so the context DB queries
  // run concurrently with extraction instead of blocking before it. Only the
  // decide stage needs them. The eval harness passes resolved values + no promise.
  contextPromise?: Promise<{
    recentFoods: RecentFoodContext[];
    todayTotals: { kcal: number; protein_g: number } | null;
    targets: { daily_calorie_target: number | null; protein_target_g: number | null } | null;
  }>;
}

// Injected by index.ts (production) or the eval harness (dry run). Keeping
// this structural (no supabase-js types) is what makes the module portable.
export interface ParseMealDeps {
  anthropicApiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  webSearchEnabled: boolean;
  // Tier 1: catalog search (search_foods_ranked RPC + food_servings).
  searchFoods(query: string): Promise<CandidateFood[]>;
  // Tier 2 backfill hook: persist an OFF product as a global foods row.
  // Returns the new (or pre-existing) food id, or null on failure/dry-run.
  backfillOffFood(food: OffProduct): Promise<string | null>;
  // Tier 1/2 verification: per-100 macros for a food row, for the
  // server-side recompute. Null when the row can't be read.
  getFoodPer100(foodId: string): Promise<{
    base_unit: string;
    kcal: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    fiber_g: number | null;
  } | null>;
  /** A food's serving options, for resolving a correction ("a small one")
   *  against the row we already matched. Optional: without it the fast
   *  correction path simply falls back to the full pipeline. */
  getFoodServings?(foodId: string): Promise<ServingOption[]>;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}

// ── Open Food Facts lookup (tier 2) ─────────────────────────────────────────

export interface OffProduct {
  name: string;
  brand: string | null;
  barcode: string | null;
  base_unit: "g" | "ml";
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  sat_fat_g: number | null;
  sodium_mg: number | null;
  serving: ServingOption | null;
}

const OFF_TIMEOUT_MS = 4000;
// ODbL guardrail: identify the app on every live call.
const OFF_USER_AGENT = "Overload/1.0 (https://tryoverload.app; support@tryoverload.app)";

// De-SHOUT OFF/USDA style names ("YOGABAR MULTIGRAIN BAR" -> "Yogabar Multigrain Bar").
function titleCaseIfShouty(raw: string): string {
  const s = raw.trim();
  if (s.length < 4 || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
}

function asNum(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// "50 g" / "250ml" / "1 bar (50 g)" -> grams (or ml) count.
function parseServingSize(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(g|ml)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function searchOpenFoodFacts(
  query: string,
  fetchFn: typeof fetch,
  log?: (msg: string) => void,
): Promise<OffProduct[]> {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "8",
    fields: "code,product_name,brands,nutriments,serving_size,nutrition_data_per",
  });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS);
  try {
    const res = await fetchFn(
      `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`,
      { headers: { "User-Agent": OFF_USER_AGENT }, signal: controller.signal },
    );
    if (!res.ok) {
      log?.(`[parse_meal] OFF search ${res.status} for "${query}"`);
      return [];
    }
    const data = await res.json();
    const products: unknown[] = Array.isArray(data?.products) ? data.products : [];
    const out: OffProduct[] = [];
    for (const p of products) {
      if (out.length >= 3) break;
      const prod = p as Record<string, unknown>;
      const nutr = (prod.nutriments ?? {}) as Record<string, unknown>;
      const name = typeof prod.product_name === "string" ? prod.product_name.trim() : "";
      const kcal = asNum(nutr["energy-kcal_100g"]);
      const protein = asNum(nutr["proteins_100g"]);
      const carb = asNum(nutr["carbohydrates_100g"]);
      const fat = asNum(nutr["fat_100g"]);
      // Only products with a complete core macro panel are trustworthy
      // enough to log against (and to backfill into the catalog).
      if (!name || kcal === null || protein === null || carb === null || fat === null) continue;
      // Open Food Facts is crowd-sourced and carries mis-entered panels. Screen
      // them HERE so a bad row is never backfilled into our catalog, where it
      // would poison every future search for that product.
      const bad = implausiblePer100({ kcal, protein_g: protein, carb_g: carb, fat_g: fat });
      if (bad) {
        log?.(`[parse_meal] OFF row rejected ("${name}"): ${bad}`);
        continue;
      }
      const sodiumG = asNum(nutr["sodium_100g"]);
      const servingAmount = parseServingSize(prod.serving_size);
      out.push({
        name: titleCaseIfShouty(name),
        brand: typeof prod.brands === "string" && prod.brands.trim()
          ? titleCaseIfShouty(prod.brands.split(",")[0].trim())
          : null,
        barcode: typeof prod.code === "string" && prod.code ? prod.code : null,
        base_unit: prod.nutrition_data_per === "100ml" ? "ml" : "g",
        kcal,
        protein_g: protein,
        carb_g: carb,
        fat_g: fat,
        fiber_g: asNum(nutr["fiber_100g"]),
        sugar_g: asNum(nutr["sugars_100g"]),
        sat_fat_g: asNum(nutr["saturated-fat_100g"]),
        sodium_mg: sodiumG === null ? null : Math.round(sodiumG * 1000),
        serving: servingAmount
          ? { label: String(prod.serving_size).trim(), grams: servingAmount, is_default: true }
          : null,
      });
    }
    return out;
  } catch (e) {
    log?.(`[parse_meal] OFF search threw for "${query}": ${String(e).slice(0, 120)}`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ── Tool definitions ────────────────────────────────────────────────────────

export const PARSE_TERMINAL_TOOL = "log_meal";

// Stage 1 of the extract -> resolve -> decide workflow: segment the text into
// items. Forced via tool_choice, so declines are fields, not free text.
const EXTRACT_TOOL = {
  name: "extract_meal",
  description:
    "Report every distinct food or drink in the text as a separate item. Extraction only: " +
    "no nutrition numbers, no serving-size guessing beyond what the text says.",
  input_schema: {
    type: "object",
    properties: {
      declined: {
        type: "boolean",
        description:
          "true ONLY when the text contains NOTHING loggable as food or drink (a pure " +
          "question, an exercise log, or chatter). Any real food, however vague, is false.",
      },
      decline_message: {
        type: ["string", "null"],
        description:
          "When declined: one short sentence in Coach Drona's voice (direct, warm, no em " +
          "dashes) redirecting the user to log food. null otherwise.",
      },
      meal_type_from_text: {
        type: ["string", "null"],
        enum: ["breakfast", "lunch", "dinner", "snack", null],
        description:
          'The meal the TEXT names ("for lunch", "dinner was"). null when the text does not ' +
          "name one; never infer it from the food or the time.",
      },
      requests_research: {
        type: "boolean",
        description:
          "TRUE when the user is ACCEPTING an offer to go look the numbers up: \"yes\", " +
          '"yes please", "search for it", "look it up", "check again", "can you verify". ' +
          "Read it against the last thing Drona said in the conversation: if Drona just " +
          "offered to search and the user agreed, this is true. Only ever true when a " +
          "previous meal was given.",
      },
      asks_about_previous: {
        type: "boolean",
        description:
          "TRUE when the text QUESTIONS or CHALLENGES the meal already on screen instead of " +
          'logging or correcting it: "is that right?", "that seems high", "why is it 900 calories?", ' +
          '"are you sure it had 122 g protein?". The user is checking your numbers, not eating. ' +
          "Only ever true when a previous meal was given. Set declined FALSE in this case.",
      },
      corrects_previous: {
        type: "boolean",
        description:
          "TRUE when the text CORRECTS the meal already on screen rather than adding food: " +
          '"make it a small one", "that was 2 not 1", "actually paneer not tofu", "no sugar". ' +
          "FALSE when the user is naming NEW food to add (\"and a dosa\", \"also 2 roti\") or " +
          "logging an unrelated meal. Only ever true when a previous meal was given.",
      },
      items: {
        type: "array",
        description:
          "One entry per distinct food/drink. When corrects_previous is true, list the " +
          "corrected version of EVERY line of the previous meal (unchanged ones included), " +
          "so the result replaces it wholesale.",
        items: {
          type: "object",
          properties: {
            corrects_food_name: {
              type: ["string", "null"],
              description:
                "When correcting, the food_name of the previous line this entry replaces, " +
                "copied EXACTLY. null for a brand new item.",
            },
            name: {
              type: "string",
              description:
                'The food\'s COMMON name in 1-3 words, spelling corrected: "roasted edamame", ' +
                'not "2 tblspn roasted edameme"; "almonds", not "almonds raw whole". Keep a ' +
                "prep word only when it names a different food (roasted vs plain); drop " +
                "filler adjectives (raw, whole, fresh, homemade). No brand, no quantity.",
            },
            brand: { type: ["string", "null"], description: "Brand if the text names one." },
            quantity: { type: "number", description: "How many of unit, e.g. 2 for '2 rotis'. 1 if unstated." },
            unit: {
              type: "string",
              description:
                'The unit as the user gave it: "g", "ml", "tbsp", "tsp", "cup", "roti", ' +
                '"katori", "glass", "scoop", "piece"... "serving" when unstated.',
            },
            prep: {
              type: ["string", "null"],
              description:
                'Preparation state the text implies: "roasted", "fried", "cooked", "raw", ' +
                "etc. null when unstated.",
            },
          },
          required: ["name", "quantity", "unit"],
        },
      },
    },
    required: ["declined", "items"],
  },
};

const LOG_MEAL_TOOL = {
  name: PARSE_TERMINAL_TOOL,
  description:
    "Record the parsed meal. Call this EXACTLY ONCE as your final action, after resolving every " +
    "item. Do not describe the meal in text; this tool call is the only thing the app can log.",
  input_schema: {
    type: "object",
    properties: {
      meal_type: {
        type: "string",
        enum: ["breakfast", "lunch", "dinner", "snack"],
        description:
          "Use the meal named in the text if any; otherwise the meal_hint from context.",
      },
      items: {
        type: "array",
        description: "One entry per distinct food in the text.",
        items: {
          type: "object",
          properties: {
            food_id: {
              type: ["string", "null"],
              description:
                "The id of the chosen candidate from search_foods / lookup_packaged_food. " +
                "null ONLY for web-sourced or estimated items.",
            },
            food_name: { type: "string", description: "Display name for the log." },
            quantity: {
              type: "number",
              description: "How many of serving_label the user ate, e.g. 2 for '2 rotis'.",
            },
            serving_label: {
              type: "string",
              description:
                'Human-readable unit, e.g. "roti", "katori", "100 g", "scoop", "500 ml". ' +
                "Prefer a serving option label from the chosen candidate when one fits.",
            },
            grams: {
              type: "number",
              description:
                "TOTAL amount in grams (or ml for liquids) for this line: quantity times the " +
                "per-serving weight. This drives the macro math, so convert carefully.",
            },
            kcal: { type: "number", description: "TOTAL kcal. OMIT for catalog/off items (food_id set) — the app computes them from grams. REQUIRED only for estimate/web items." },
            protein_g: { type: "number", description: "TOTAL protein grams. Omit when food_id is set; required for estimate/web." },
            carb_g: { type: "number", description: "TOTAL carb grams. Omit when food_id is set; required for estimate/web." },
            fat_g: { type: "number", description: "TOTAL fat grams. Omit when food_id is set; required for estimate/web." },
            fiber_g: { type: ["number", "null"], description: "TOTAL fiber grams. Omit when food_id is set." },
            source: {
              type: "string",
              enum: ["catalog", "off", "web", "estimate"],
              description:
                "catalog = matched via search_foods. off = matched via lookup_packaged_food. " +
                "web = numbers read from a web_search result (cite the label site in assumption). " +
                "estimate = your own knowledge, last resort.",
            },
            assumption: {
              type: ["string", "null"],
              description:
                "Short user-facing note when you guessed a variant or size, in Coach Drona's " +
                'voice, e.g. "Took that as toned milk" or "Assumed a medium katori, 150 g". ' +
                "No em dashes. null when nothing was assumed.",
            },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          // Macros are intentionally NOT required: for catalog/off items the
          // server recomputes them from grams (verifyItems), so emitting them
          // just burns output tokens (latency). The prompt requires them for
          // estimate/web items, which have no food row to recompute from.
          required: [
            "food_id", "food_name", "quantity", "serving_label", "grams",
            "source", "confidence",
          ],
        },
      },
      drona_line: {
        type: "string",
        description:
          "One short sentence from Coach Drona reacting to this meal in the context of the day. " +
          "Protein-first mindset. Plain, direct, no emoji, no em dashes, max ~15 words.",
      },
    },
    required: ["meal_type", "items", "drona_line"],
  },
};

// Basic (non-filtering) variant: the newer web_search versions are
// Opus/Sonnet-only and parse_meal runs on Haiku.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 2,
};

// Terminal tool for the HEDGED web lookup: a compact side-call that races the
// decide call for items the catalog could not resolve. The decide model
// estimates those items immediately; if this lookup lands label data within
// the grace window, the estimate lines are upgraded server-side.
const WEB_LOOKUP_TOOL = {
  name: "report_labels",
  description:
    "Report the official nutrition-label data you found for each food, exactly once, " +
    "after your web searches. found=false when no trustworthy label surfaced.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            for_item: { type: "string", description: "The item name EXACTLY as given to you." },
            found: { type: "boolean" },
            per_100: {
              type: ["object", "null"],
              description: "Label macros per 100 g (or 100 ml for liquids). null when not found.",
              properties: {
                kcal: { type: "number" },
                protein_g: { type: "number" },
                carb_g: { type: "number" },
                fat_g: { type: "number" },
                fiber_g: { type: ["number", "null"] },
              },
              required: ["kcal", "protein_g", "carb_g", "fat_g"],
            },
            source_note: {
              type: ["string", "null"],
              description: 'Short source for the user, e.g. "per the Britannia label". No URLs.',
            },
          },
          required: ["for_item", "found"],
        },
      },
    },
    required: ["results"],
  },
};

interface WebLabel {
  per_100: { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null };
  source_note: string | null;
}

// Typo-tolerant word overlap ("edameme" vs "Edamame, cooked"): any pair of
// content words sharing a 4-char prefix. Shared by the prep-state guard and
// the web-label merge.
/**
 * Do two food names refer to the same food?
 *
 * A single shared word is not enough: "milk tea" and "milk coffee" share
 * "milk", and treating that as identity lets one drink take the other's label
 * or mask it as already-covered. Require the names to agree on the whole of
 * the shorter one, so a modifier ("roasted edamame" vs "edamame") still
 * matches while two different foods that merely share an ingredient do not.
 */
export function wordsOverlap(a: string, b: string): boolean {
  // Three characters, not four: "tea", "dal" and "egg" are whole foods, and
  // dropping them collapses "milk tea" to "milk", which then matches every
  // milk drink there is.
  const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  const aw = words(a), bw = words(b);
  if (aw.length === 0 || bw.length === 0) return false;
  const [short, long] = aw.length <= bw.length ? [aw, bw] : [bw, aw];
  const near = (x: string, y: string) => x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4));
  return short.every((x) => long.some((y) => near(x, y)));
}

const WEB_LOOKUP_MAX_TURNS = 4;
const WEB_LOOKUP_TIMEOUT_MS = 20000;
// How long past the decide call the hedge may hold the response. Web label
// lookups typically take 4-10s; the decide call ~4s. A short grace converts
// most of that overlap into "free" — anything slower ships as an estimate.
const WEB_MERGE_GRACE_MS = 4000;

// Runs concurrently with the decide call (the hedge). Own bounded mini-loop:
// server web_search pauses resume, and the final turn forces report_labels.
async function runWebLookup(
  deps: ParseMealDeps,
  items: ExtractedItem[],
  onUsage: (data: any) => void,
  onCall: () => void,
): Promise<Map<string, WebLabel> | null> {
  const webDeps = { ...deps, timeoutMs: Math.min(deps.timeoutMs, WEB_LOOKUP_TIMEOUT_MS) };
  const system =
    "You look up nutrition labels for foods a fitness app could not find in its catalog. " +
    'For EACH item, run ONE web search for the official label ("<brand> <product> nutrition facts per 100g"), ' +
    "read numbers only from the brand's own site or a reputable label listing, then call report_labels " +
    "exactly once with per-100 macros for everything you found. Speed matters: no extra searches, no prose.";
  const conversation: AnthropicMsg[] = [{
    role: "user",
    content: JSON.stringify(items.map((i) => ({ name: i.name, ...(i.brand ? { brand: i.brand } : {}) }))),
  }];

  for (let turn = 0; turn < WEB_LOOKUP_MAX_TURNS; turn++) {
    const lastTurn = turn === WEB_LOOKUP_MAX_TURNS - 1;
    const result = await callAnthropicOnce(webDeps, {
      model: deps.model,
      max_tokens: 800,
      system,
      tools: [WEB_SEARCH_TOOL, WEB_LOOKUP_TOOL],
      messages: conversation,
      ...(lastTurn ? { tool_choice: { type: "tool", name: "report_labels" } } : {}),
    });
    if (!result.ok) {
      deps.log?.(`[parse_meal] web lookup failed: ${result.status}`);
      return null;
    }
    onCall();
    onUsage(result.data);
    const blocks: Array<Record<string, any>> = result.data.content ?? [];

    if (result.data.stop_reason === "pause_turn") {
      conversation.push({ role: "assistant", content: blocks });
      continue;
    }
    const report = blocks.find((b) => b.type === "tool_use" && b.name === "report_labels");
    if (!report) {
      conversation.push({ role: "assistant", content: blocks });
      conversation.push({ role: "user", content: "Call report_labels now with what you have." });
      continue;
    }
    const out = new Map<string, WebLabel>();
    const results = (report.input as Record<string, unknown>)?.results;
    for (const r of Array.isArray(results) ? results : []) {
      const o = r as Record<string, any>;
      const p = o.per_100;
      if (o.found !== true || !p || typeof o.for_item !== "string") continue;
      const nums = [p.kcal, p.protein_g, p.carb_g, p.fat_g];
      if (!nums.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && (n as number) >= 0)) continue;
      out.set(o.for_item, {
        per_100: {
          kcal: p.kcal, protein_g: p.protein_g, carb_g: p.carb_g, fat_g: p.fat_g,
          // Merging happens after sanitizeItems, so a negative fiber value
          // here would reach the result unclamped.
          fiber_g: typeof p.fiber_g === "number" && Number.isFinite(p.fiber_g) && p.fiber_g >= 0 ? p.fiber_g : null,
        },
        source_note: typeof o.source_note === "string" && o.source_note.trim()
          ? scrubDashes(o.source_note).slice(0, 80)
          : null,
      });
    }
    return out.size > 0 ? out : null;
  }
  return null;
}

// Upgrade estimate lines with label data the hedge brought back in time.
// Grams stay the model's (portioning already went through the guardrails);
// only the per-gram nutrition is replaced.
function mergeWebLabels(items: ParsedItem[], labels: Map<string, WebLabel>): ParsedItem[] {
  return items.map((item) => {
    if (item.source !== "estimate" || !(item.grams > 0)) return item;
    for (const [forItem, label] of labels) {
      if (!wordsOverlap(item.food_name, forItem)) continue;
      const f = item.grams / 100;
      return {
        ...item,
        kcal: round1(label.per_100.kcal * f),
        protein_g: round1(label.per_100.protein_g * f),
        carb_g: round1(label.per_100.carb_g * f),
        fat_g: round1(label.per_100.fat_g * f),
        fiber_g: label.per_100.fiber_g === null ? item.fiber_g : round1(label.per_100.fiber_g * f),
        source: "web" as const,
        confidence: "medium" as const,
        assumption: appendAssumption(item, label.source_note ?? "Macros from a web label lookup"),
      };
    }
    return item;
  });
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const HOUR_TO_MEAL: Array<[number, number, MealType]> = [
  [5, 11, "breakfast"],
  [11, 16, "lunch"],
  [16, 19, "snack"],
  [19, 29, "dinner"], // wraps past midnight; hours 0-5 also read as dinner
];

export function mealForHour(hour: number | null): MealType {
  if (hour === null || !Number.isFinite(hour)) return "snack";
  const h = ((hour % 24) + 24) % 24;
  const probe = h < 5 ? h + 24 : h;
  for (const [from, to, meal] of HOUR_TO_MEAL) {
    if (probe >= from && probe < to) return meal;
  }
  return "snack";
}

const EXTRACT_CORRECTION_RULES = `

A meal the user just logged may be shown to you as previous_meal (it is on screen, not yet saved). If so, decide what the new text is doing:
- CORRECTION of that meal (set corrects_previous true): it changes a size, amount, or identity of something already there, and names no new food. "make it a small one", "that was 2", "actually paneer not tofu", "no sugar in the tea". Re-list EVERY line of previous_meal with the correction applied, copying each line's exact food_name into corrects_food_name (unchanged lines included, unchanged).
- ADDITION or a new meal (corrects_previous false): the text names food that is not already in previous_meal. "and a dosa", "also 2 roti". List ONLY the new food; the app keeps the existing lines.
- QUESTION about that meal (set asks_about_previous true, declined false, items empty): the user is challenging or checking your numbers rather than eating. "is that correct?", "that seems high", "are you sure it had 122 g protein?". Never treat this as non-food chatter: the app answers it with the real numbers.
- ACCEPTING A LOOKUP (set requests_research true, declined false, items empty): Drona offered to search for the real label and the user said yes. Judge this from recent_turns, not the words alone: a bare "yes" or "please" right after that offer is an acceptance.
When in doubt between correction and addition, prefer addition: adding a wrong item is easier for the user to spot and fix than silently rewriting what they already checked.`;

const EXTRACT_SYSTEM = `You segment free-text food logs for OVERLOAD, a lifting app. Report what the user ate via the extract_meal tool: one item per distinct food or drink, with the quantity and unit exactly as given. Correct spelling in item names ("edameme" is "edamame", "panner" is "paneer") and expand shorthand ("tblspn" is "tbsp"). Indian context: unqualified "tea" or "chai" means milk tea, extract the name as "milk tea"; unqualified "coffee" as "milk coffee" (keep "black tea", "green tea", "black coffee" as stated). Do NOT resolve nutrition, do NOT guess amounts the text does not state (use unit "serving" and quantity 1), and do NOT drop items. Composite dishes stay one item ("rajma chawal"), separately listed foods split ("paneer and 2 roti" is two).`;

export function buildDecideSystemPrompt(input: ParseMealInput): string {
  const hint = input.mealHint ?? mealForHour(input.localHour);

  const recents = input.recentFoods.length > 0
    ? input.recentFoods
      .slice(0, 20)
      .map((r) => `- ${r.food_name} (last: ${r.quantity} ${r.serving_unit})`)
      .join("\n")
    : "(none yet)";

  const day = (() => {
    const target = input.targets?.protein_target_g ?? null;
    const kcalTarget = input.targets?.daily_calorie_target ?? null;
    const totals = input.todayTotals;
    const parts: string[] = [];
    if (totals) parts.push(`So far today: ${Math.round(totals.kcal)} kcal, ${Math.round(totals.protein_g)} g protein.`);
    if (target) parts.push(`Protein target: ${Math.round(target)} g/day.`);
    if (kcalTarget) parts.push(`Calorie target: ${Math.round(kcalTarget)} kcal/day.`);
    return parts.length > 0 ? parts.join(" ") : "No targets set.";
  })();

  return `You finalize food log entries for OVERLOAD, a lifting app. Each extracted item below carries CANDIDATE foods (per-100 macros plus serving options) already fetched from the catalog. Pick the right candidate per item, convert the quantity to grams, and log everything with ONE log_meal call. Coach Drona's voice appears only in drona_line and assumption strings: direct, warm, coach-like, never robotic. Never use em dashes anywhere in user-facing strings.

<candidate_rules>
- Choose the candidate that IS the food, not one merely similar. For generic Indian foods prefer the curated staples (Roti, Toor Dal, Curd, Toned Milk) over obscure branded rows. For a plain whole food ("chicken breast", "rice", "milk") prefer the plain/cooked/generic row over processed, fat-free, dried, deli, or flavored variants unless the user named that variant.
- Respect the item's prep state: never log a roasted/dried/fried item against a cooked/boiled candidate (2-3x density difference). If only a wrong-state candidate exists, estimate instead.
- Indian beverage defaults: unqualified "tea" or "chai" means MILK tea (the Chai / Milk Tea row, ~45 kcal/100 ml), and unqualified "coffee" means milk coffee. Herbal, black, green, or lemon tea ONLY when the user says so; picking a 1-2 kcal plain-tea row for unqualified "tea" is wrong. Any such default is never confidence high; name it in assumption.
- No acceptable candidate: estimate from your own knowledge. food_id null, source "estimate", confidence low or medium, assumption naming what you assumed. Never refuse to log a real food.
</candidate_rules>

<quantity_rules>
- Macros output: for any item you matched to a candidate (food_id set, source catalog or off), give ONLY grams and OMIT kcal/protein_g/carb_g/fat_g/fiber_g — the app computes them from grams and the food row. For estimate or web items (food_id null) you MUST include all four macros, since there is no row to compute from.
- Candidates list macros PER 100 of base_unit (g or ml). grams on each logged item is the TOTAL amount eaten; when you do provide macros (estimate/web only) compute them as per100 * grams / 100.
- Use the candidate's serving options to convert household units. When the user gives an explicit amount ("50g", "500 ml"), that wins over any serving default.
- Spoon and cup weights DEPEND ON THE FOOD; a tablespoon is 15 g only for water-like liquids. If the candidate has a cup serving, derive from it (1 cup = 16 tbsp = 48 tsp). Otherwise: 1 tbsp of nuts, seeds, or roasted snacks ~8 g; powders (protein, flour, spices) ~7-9 g; oil or ghee ~14 g; nut butter, honey ~16-20 g. A guessed spoon weight is never confidence high.
- Indian household defaults when the user gives no amount and no serving option fits: 1 roti ~40 g, 1 katori ~150 g cooked, 1 glass ~250 ml, 1 cup ~200 ml, 1 bowl ~250 g, 1 scoop whey ~32 g, 1 egg ~50 g. Record any such guess in assumption.
- Piece counts for small foods use the candidate's per-piece serving when one exists; otherwise: 1 almond ~1.2 g, 1 cashew ~1.5 g, 1 walnut half ~2 g, 1 peanut ~0.9 g, 1 kimia date ~8 g, 1 medjool date ~24 g, 1 small packaged biscuit (Good Day, Marie, Parle-G) ~5-10 g. "5 almonds" is ~6 g, never 25; "2 biscuits" is ~15-20 g, never 90.
- Match the preparation state the user typed: "roasted" or "dried" foods are 2-3x more calorie-dense per gram than "cooked" or "boiled" ones. Never log a roasted/dried item against a cooked/boiled candidate row; prefer a correct-state candidate or estimate instead.
- "half" quantities are fine (quantity 0.5).
</quantity_rules>

<behavior>
- The user's recent foods (below) are strong hints: "milk" from someone who always logs Toned Milk means toned milk. Say so in assumption when you rely on this.
- meal_type: if the text names a meal ("for lunch", "dinner was"), use that. Otherwise use the hint EXACTLY: ${hint}. Do NOT infer the meal from what the food "usually" is: paneer bhurji at 9pm is dinner, not breakfast. Time of day decides, never the dish.
- Multiple foods in one text = multiple items in ONE log_meal call.
- NEVER ask the user a question. This is a one-shot logger, not a chat: the user gets no chance to reply. If an amount is missing, assume ONE standard serving (use the household defaults above) and note it in assumption, e.g. "Took that as one katori, 150 g." If a brand/variant is ambiguous, pick the most common one and say so. Estimate and log; do not stall for clarification.
- An item with no candidates is NEVER dropped: estimate the macros from your own knowledge (source "estimate"), note it in assumption, and log it. A branded snack you recognize (Haldiram's bhujia, Epigamia yogurt, etc.) always gets logged with an estimate, never skipped.
- You MUST finish by calling log_meal exactly once, covering every extracted item. Never write the parsed meal, macros, or a follow-up question as assistant text.
- drona_line reacts to the meal against the day so far (see context): protein lands first, praise effort, nudge gaps. One sentence, max ~15 words.
</behavior>

<user_context>
Recent foods this user logs:
${recents}

${day}
</user_context>`;
}

// ── Anthropic plumbing ──────────────────────────────────────────────────────

interface AnthropicMsg {
  role: "user" | "assistant";
  content: string | unknown[];
}

// Prompt caching: the decide system prompt and tool schemas are large and
// identical across a user's meals, so mark them as a cache breakpoint. The
// first log in a ~5 min window writes the cache; the rest read it, cutting
// input-processing latency (and cost) on every follow-up log.
function cacheableSystem(text: string): unknown {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}
function withToolCache(tools: unknown[]): unknown[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 && t && typeof t === "object" && !("type" in (t as object))
      ? { ...(t as object), cache_control: { type: "ephemeral" } }
      : t
  );
}

async function callAnthropicOnce(
  deps: ParseMealDeps,
  payload: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const response = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": deps.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, body: await response.text() };
    }
    return { ok: true, data: await response.json() };
  } catch (e) {
    const isAbort = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      status: isAbort ? 504 : 502,
      body: isAbort ? `Anthropic call exceeded ${deps.timeoutMs}ms timeout` : `fetch threw: ${String(e)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function candidatePayload(c: CandidateFood): Record<string, unknown> {
  return {
    food_id: c.food_id,
    name: c.name,
    ...(c.brand ? { brand: c.brand } : {}),
    base_unit: c.base_unit,
    per_100: {
      kcal: c.kcal,
      protein_g: c.protein_g,
      carb_g: c.carb_g,
      fat_g: c.fat_g,
      ...(c.fiber_g !== null ? { fiber_g: c.fiber_g } : {}),
    },
    servings: c.servings.slice(0, 6),
    source: c.source,
  };
}

// ── Stage 2: resolve (pure code, all items in parallel) ─────────────────────

export interface ExtractedItem {
  name: string;
  brand: string | null;
  quantity: number;
  unit: string;
  prep: string | null;
  /** When this entry corrects a line of the meal under review, that line's
   *  food_name verbatim — the handle we re-target it by. */
  correctsFoodName?: string | null;
}

interface ResolvedItem extends ExtractedItem {
  candidates: CandidateFood[];
}

// A cup serving anchors every spoon: 1 cup = 16 tbsp = 48 tsp. Deriving the
// spoon weights in code hands the decide model real numbers instead of a
// water-density guess (the 2x roasted-edamame bug).
/**
 * True only for a serving that is exactly ONE cup.
 *
 * The anchors below divide the cup weight by 16 and 48, so any other multiple
 * silently poisons every spoon it derives: "1/2 cup" yields a half-weight
 * tablespoon, "2 cup" a doubled one. That is the same failure mode this whole
 * function exists to prevent, so the match has to be exact rather than a
 * substring test for "cup".
 */
export function isOneCupLabel(label: string): boolean {
  const l = label.toLowerCase().trim();
  if (/\bcups\b/.test(l)) return false;                 // "2 cups"
  const m = l.match(/^(.*?)\bcup\b/);
  if (!m) return false;
  const prefix = m[1].trim();
  // Bare "cup", or a quantity that is precisely 1. Anything else - "1/2",
  // "0.5", "2", "3/4" - is rejected rather than guessed at.
  return prefix === "" || /(^|\s)1$/.test(prefix);
}

function synthesizeVolumeAnchors(c: CandidateFood): CandidateFood {
  if (c.base_unit !== "g") return c;
  const has = (re: RegExp) => c.servings.some((s) => re.test(s.label.toLowerCase()));
  const cup = c.servings.find((s) => isOneCupLabel(s.label) && s.grams > 30 && s.grams < 400);
  if (!cup) return c;
  const derived: ServingOption[] = [];
  if (!has(/\b(tbsp|tablespoon)\b/)) derived.push({ label: "1 tbsp", grams: round1(cup.grams / 16) });
  if (!has(/\b(tsp|teaspoon)\b/)) derived.push({ label: "1 tsp", grams: round1(cup.grams / 48) });
  return derived.length > 0 ? { ...c, servings: [...c.servings, ...derived] } : c;
}

async function resolveOneItem(
  deps: ParseMealDeps,
  item: ExtractedItem,
  steps: ParseStep[],
  toolCalls: string[],
): Promise<ResolvedItem> {
  // Query ladder: full name, brand-qualified, then progressively fewer words
  // (the 0079 search requires EVERY word to match, so an over-specified name
  // like "almonds raw whole" returns nothing while "almonds" hits). A
  // generalized retry only fires when the specific query found zero rows.
  const queries: string[] = [];
  const push = (q: string) => { if (q && !queries.includes(q)) queries.push(q); };
  // Brand-qualified FIRST. The loop below stops at the first query that
  // returns anything, so leading with the generic name lets a generic row
  // win for a branded item whose own row exists and is never searched for.
  if (item.brand) push(`${item.brand} ${item.name}`);
  push(item.name);
  const words = item.name.split(/\s+/).filter(Boolean);
  // Drop LEADING words before trailing ones. Prep state is written as a
  // prefix ("roasted edamame", "boiled egg"), so trimming from the front
  // keeps the food and sheds the modifier; trimming from the back does the
  // reverse and searches for "roasted", losing the identity entirely.
  for (let i = 1; i < words.length; i++) push(words.slice(i).join(" "));
  for (let n = words.length - 1; n >= 1; n--) push(words.slice(0, n).join(" "));
  let candidates: CandidateFood[] = [];
  for (const q of queries.slice(0, 4)) {
    if (candidates.length > 0) break;
    toolCalls.push("search_foods");
    try {
      candidates = (await deps.searchFoods(q)).slice(0, 6);
    } catch (e) {
      deps.log?.(`[parse_meal] searchFoods threw for "${q}": ${String(e).slice(0, 120)}`);
    }
    steps.push({
      iter: 1,
      tool: "search_foods",
      input: { query: q },
      result: { count: candidates.length, top: candidates.slice(0, 5).map((c) => c.name) },
    });
  }

  // OFF fallback on a total catalog miss (branded or not; OFF carries both).
  // Backfill first so the candidate carries a real food_id and the NEXT
  // user's catalog search finds it at tier 1.
  if (candidates.length === 0) {
    const q = item.brand ? `${item.brand} ${item.name}` : item.name;
    toolCalls.push("lookup_packaged_food");
    try {
      const fetchFn = deps.fetchFn ?? fetch;
      const products = await searchOpenFoodFacts(q, fetchFn, deps.log);
      for (const p of products) {
        const foodId = await deps.backfillOffFood(p);
        candidates.push({
          food_id: foodId,
          name: p.name,
          brand: p.brand,
          base_unit: p.base_unit,
          kcal: p.kcal,
          protein_g: p.protein_g,
          carb_g: p.carb_g,
          fat_g: p.fat_g,
          fiber_g: p.fiber_g,
          servings: p.serving ? [p.serving] : [],
          source: "off",
        });
      }
    } catch (e) {
      deps.log?.(`[parse_meal] OFF resolve threw for "${q}": ${String(e).slice(0, 120)}`);
    }
    steps.push({
      iter: 1,
      tool: "lookup_packaged_food",
      input: { query: q },
      result: { count: candidates.length, top: candidates.slice(0, 5).map((c) => c.name) },
    });
  }

  // Never offer the model a physically impossible row: it cannot tell a bad
  // label from a good one, and picking it produces confident nonsense. Dropping
  // it here means a saner candidate wins, or the item honestly falls to an
  // estimate. (Keep them if EVERY candidate is junk, so we still show something
  // and the verify-stage flag warns the user.)
  const sane = candidates.filter((c) =>
    implausiblePer100({ kcal: c.kcal, protein_g: c.protein_g, carb_g: c.carb_g, fat_g: c.fat_g }) === null
  );
  if (sane.length !== candidates.length) {
    const dropped = candidates.length - sane.length;
    deps.log?.(`[parse_meal] dropped ${dropped} implausible candidate(s) for "${item.name}"`);
    steps.push({ iter: 1, tool: "implausible_filtered", input: { item: item.name, dropped } });
  }
  const usable = sane.length > 0 ? sane : candidates;
  return { ...item, candidates: usable.map(synthesizeVolumeAnchors) };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// House rule: no em/en dashes in any user-facing string. The prompt asks for
// this, but a deterministic scrub beats hoping the model complies.
function scrubDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
}

type Per100 = { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null };

// The receipts step: for items the model matched to a real food row, recompute
// line macros from the row's per-100 values so catalog-backed numbers are
// deterministic, never model arithmetic.
//
// `fallback` carries the per-100 values the resolve stage already fetched for
// each candidate. It matters because the decide schema tells the model to OMIT
// macros whenever food_id is set, and sanitizeItems defaults anything missing
// to 0: if the row read then fails, there are no model numbers to fall back on
// and the line would ship as a silent 0 kcal food. The candidate we offered in
// the first place is the right answer there, and costs no extra query.
export async function verifyItems(
  deps: ParseMealDeps,
  items: ParsedItem[],
  fallback?: Map<string, Per100>,
): Promise<ParsedItem[]> {
  return await Promise.all(items.map(async (item) => {
    if (item.source !== "catalog" && item.source !== "off") return item;
    const usable = item.food_id && Number.isFinite(item.grams) && item.grams > 0;
    const per100 = usable ? await deps.getFoodPer100(item.food_id!) : null;
    // A catalog/OFF claim we cannot check is not a catalog/OFF number. Fall
    // back to the candidate's own per-100 basis; failing that, call the line
    // what it is - an estimate - rather than let the UI present an unverified
    // number with the authority of a looked-up row.
    if (!per100) {
      const alt = usable ? fallback?.get(item.food_id!) : undefined;
      if (!alt) {
        const zeroed = item.kcal === 0 && item.protein_g === 0 && item.carb_g === 0 && item.fat_g === 0;
        return {
          ...item,
          source: "estimate" as const,
          food_id: null,
          confidence: "low" as const,
          // Never ship a silent zero: the model was told to omit these.
          assumption: zeroed
            ? appendAssumption(item, "I could not read this food's nutrition, the numbers here are not reliable")
            : item.assumption,
        };
      }
      const g = item.grams / 100;
      return {
        ...item,
        kcal: round1(alt.kcal * g),
        protein_g: round1(alt.protein_g * g),
        carb_g: round1(alt.carb_g * g),
        fat_g: round1(alt.fat_g * g),
        fiber_g: alt.fiber_g === null ? item.fiber_g : round1(alt.fiber_g * g),
        confidence: "medium" as const,
      };
    }
    const f = item.grams / 100;
    const scaled = {
      ...item,
      kcal: round1(per100.kcal * f),
      protein_g: round1(per100.protein_g * f),
      carb_g: round1(per100.carb_g * f),
      fat_g: round1(per100.fat_g * f),
      fiber_g: per100.fiber_g === null ? item.fiber_g : round1(per100.fiber_g * f),
    };
    // Last line of defence. Deliberately understated: we mark the line low
    // confidence (so the UI can show it as unverified) but do NOT editorialise
    // on the card. Volunteering doubt about our own numbers on every borderline
    // meal teaches the user to trust none of them, which is worse than being
    // occasionally wrong. The rigour belongs in the challenge path — when the
    // user says "that looks off", we go and check properly.
    const bad = implausiblePer100(per100) ?? implausibleLine(scaled);
    if (!bad) return scaled;
    deps.log?.(`[parse_meal] implausible row used for "${item.food_name}": ${bad}`);
    return { ...scaled, confidence: "low" as const };
  }));
}

// Clamp/normalize whatever the model handed us before it touches the DB or UI.
function sanitizeItems(raw: unknown): ParsedItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ParsedItem[] = [];
  for (const r of raw.slice(0, 12)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = typeof o.food_name === "string" ? o.food_name.trim().slice(0, 120) : "";
    if (!name) continue;
    const num = (v: unknown, max: number): number => {
      const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
      return Math.min(Math.max(n, 0), max);
    };
    const source = o.source === "catalog" || o.source === "off" || o.source === "web" || o.source === "estimate"
      ? o.source
      : "estimate";
    items.push({
      food_id: typeof o.food_id === "string" && o.food_id.length > 0 ? o.food_id : null,
      food_name: name,
      quantity: num(o.quantity, 100) || 1,
      serving_label: typeof o.serving_label === "string" && o.serving_label.trim()
        ? o.serving_label.trim().slice(0, 40)
        : "serving",
      grams: num(o.grams, 5000),
      kcal: num(o.kcal, 10000),
      protein_g: num(o.protein_g, 1000),
      carb_g: num(o.carb_g, 1500),
      fat_g: num(o.fat_g, 1000),
      fiber_g: typeof o.fiber_g === "number" && Number.isFinite(o.fiber_g)
        ? Math.min(Math.max(o.fiber_g, 0), 300)
        : null,
      source,
      assumption: typeof o.assumption === "string" && o.assumption.trim()
        ? scrubDashes(o.assumption).slice(0, 160)
        : null,
      confidence: o.confidence === "high" || o.confidence === "medium" || o.confidence === "low"
        ? o.confidence
        : "medium",
    });
  }
  return items;
}

// ── Nutrient plausibility ───────────────────────────────────────────────────
// Every other guardrail checks CONSISTENCY (do the numbers agree with each
// other?). This one checks PLAUSIBILITY (can this food exist?), which is the
// gap crowd-sourced data walks through: a row claiming 25 g protein per 100 ml
// for a coffee latte is internally consistent and completely wrong. It logged
// 163 g protein for two lattes (prod, 2026-07-19) and every existing check
// passed it.
//
// The rules are split by CONSEQUENCE, because the cost of being wrong differs:
//
//   REJECT  — only the physically impossible. Rejecting drops a food from the
//             candidates entirely, so a false positive silently deletes a real
//             food. These thresholds are therefore unarguable physics.
//   FLAG    — merely implausible. Flagging just lowers confidence and adds a
//             note, so a false positive costs the user a glance, not a wrong
//             log. This is where judgement calls live.
//
// Why not a "drinks can't have 25 g protein per 100 ml" rule, which is what the
// Super Coffee latte actually violated? Because neither base_unit nor
// food_category reliably marks a drink in this catalog: tuna in olive oil and
// soya chunks are stored as 'ml', and protein POWDERS are categorised
// 'beverage' with a legitimate 80 g protein per 100 g. Any such rule rejects
// real foods. The per-LINE flag below catches the same case without that risk:
// whatever the food, 163 g of protein on one line deserves a second look.
const PLAUSIBLE = {
  maxKcalPer100: 920,      // USDA lists pure fats (lard, tallow, fish oil) at
                           // 902, so 900 would have deleted real foods. 9 kcal
                           // per gram is the physical ceiling; this allows the
                           // rounding above it and nothing more.
  maxMacroSumPer100: 105,  // macros cannot outweigh the food (+5 for rounding)
  maxProteinPer100: 100,   // the hard ceiling: 100 g of food cannot hold more
                           // than 100 g of protein. Real ultra-filtered isolates
                           // label as high as 98.9, so anything below this bound
                           // would delete a genuine product.
  flagLineProtein: 100,    // one line: a 300 g chicken breast is only ~90 g
  flagLineKcal: 2000,      // one line above a day's worth of food
};

/** Why this per-100 basis cannot describe ANY real food, or null if it could.
 *  Used to reject: keep it to physics, never taste. */
export function implausiblePer100(
  per100: { kcal: number; protein_g: number; carb_g: number; fat_g: number },
): string | null {
  const { kcal, protein_g, carb_g, fat_g } = per100;
  if ([kcal, protein_g, carb_g, fat_g].some((v) => !Number.isFinite(v) || v < 0)) {
    return "negative or missing values";
  }
  if (protein_g + carb_g + fat_g > PLAUSIBLE.maxMacroSumPer100) {
    return `its macros total ${Math.round(protein_g + carb_g + fat_g)} g per 100, more than the food weighs`;
  }
  if (kcal > PLAUSIBLE.maxKcalPer100) return `${Math.round(kcal)} kcal per 100 is more than pure fat`;
  if (protein_g > PLAUSIBLE.maxProteinPer100) {
    return `${Math.round(protein_g)} g protein per 100 is more than pure isolate`;
  }
  return null;
}

/** A zero line, for checking totals without a full ParsedItem to hand. */
const EMPTY_LINE: ParsedItem = {
  food_id: null, food_name: "", quantity: 1, serving_label: "", grams: 0,
  kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: null,
  source: "estimate", assumption: null, confidence: "medium",
};

/** Why a LOGGED line looks wrong for a single food, or null. Used to flag, not
 *  reject — this is the net that caught 163 g of protein from two lattes. */
export function implausibleLine(item: ParsedItem): string | null {
  if (item.protein_g > PLAUSIBLE.flagLineProtein) {
    return `${Math.round(item.protein_g)} g of protein in one item is a lot`;
  }
  if (item.kcal > PLAUSIBLE.flagLineKcal) {
    return `${Math.round(item.kcal)} calories in one item is a lot`;
  }
  return null;
}

// ── Deterministic guardrails ────────────────────────────────────────────────
// Pure-code checks on model output. These are safety nets for whole CLASSES of
// error (impossible densities, kcal that contradicts the macros, roasted-vs-
// cooked mismatches), not precision tools; precision comes from catalog
// serving anchors and server-side macro recompute.

const ML_PER_SPOON_UNIT: Record<string, number> = {
  tsp: 4.93, teaspoon: 4.93, tbsp: 14.79, tablespoon: 14.79, cup: 236.59,
};
// Broad food-density envelope in g/ml: puffed cereal ~0.15 up to honey ~1.5.
const DENSITY_MIN = 0.15;
const DENSITY_MAX = 1.6;

// "tbsp" / "2 tbsp" / "1 tablespoon" -> total ml for the label itself.
function labelVolumeMl(label: string): number | null {
  const m = label.toLowerCase().match(/^(\d+(?:\.\d+)?)?\s*(tsp|teaspoon|tbsp|tablespoon|cup)s?\b/);
  if (!m) return null;
  return (m[1] ? parseFloat(m[1]) : 1) * ML_PER_SPOON_UNIT[m[2]];
}

function appendAssumption(item: ParsedItem, note: string): string {
  return item.assumption ? `${item.assumption}. ${note}` : note;
}

// Volumetric sanity: grams for a spoon/cup line must imply a physically
// possible density. Runs BEFORE verifyItems so corrected grams drive the
// macro recompute; estimate items get their macros scaled proportionally.
export function clampVolumetricGrams(items: ParsedItem[]): ParsedItem[] {
  return items.map((item) => {
    const perLabelMl = labelVolumeMl(item.serving_label);
    if (perLabelMl === null || !(item.grams > 0) || !(item.quantity > 0)) return item;
    // A label may or may not already include its own count ("2 tbsp" vs "tbsp"),
    // and the model is not consistent about it, so multiplying by quantity can
    // double-count. This guard exists to catch the IMPOSSIBLE, so read it both
    // ways and only act when neither reading is physically possible - a false
    // clamp would corrupt a perfectly good line.
    const candidates = [perLabelMl * item.quantity, perLabelMl];
    const plausible = candidates.some((ml) => {
      const d = item.grams / ml;
      return d >= DENSITY_MIN && d <= DENSITY_MAX;
    });
    if (plausible) return item;
    // Clamp against the reading that needs the least correction.
    const totalMl = candidates.reduce((best, ml) =>
      Math.abs(item.grams / ml - 1) < Math.abs(item.grams / best - 1) ? ml : best
    );
    const density = item.grams / totalMl;
    const bound = density > DENSITY_MAX ? DENSITY_MAX : DENSITY_MIN;
    const grams = round1(totalMl * bound);
    const scale = grams / item.grams;
    return {
      ...item,
      grams,
      kcal: round1(item.kcal * scale),
      protein_g: round1(item.protein_g * scale),
      carb_g: round1(item.carb_g * scale),
      fat_g: round1(item.fat_g * scale),
      fiber_g: item.fiber_g === null ? null : round1(item.fiber_g * scale),
      confidence: "low",
      assumption: appendAssumption(item, `Adjusted to ${grams} g, the logged weight was not physically possible for ${item.serving_label}`),
    };
  });
}

// Atwater consistency: kcal must roughly match 4P + 4C + 9F. Runs AFTER
// verifyItems. Generous 30% tolerance absorbs fiber/rounding conventions.
// Only a model-INVENTED line gets its kcal recomputed from its own macros.
// Anything that came from a real label - catalog, OFF, or a web lookup - is
// flagged instead: a printed panel legitimately breaks strict Atwater (fiber
// netting, sugar alcohols, alcohol, rounding), and overwriting it would
// replace a real number with a computed guess. That matters most on the
// research path, where the user challenged a number and explicitly asked us
// to go read the label.
export function checkAtwater(items: ParsedItem[]): ParsedItem[] {
  return items.map((item) => {
    const atwater = 4 * item.protein_g + 4 * item.carb_g + 9 * item.fat_g;
    if (atwater < 20 && item.kcal < 20) return item;
    const ref = Math.max(item.kcal, atwater);
    if (ref <= 0 || Math.abs(item.kcal - atwater) / ref <= 0.3) return item;
    if (item.source === "estimate") {
      return { ...item, kcal: round1(atwater) };
    }
    return {
      ...item,
      confidence: "low",
      assumption: appendAssumption(item, "Calories and macros disagree on the source label, treat this line as rough"),
    };
  });
}

// Quantity/serving reconciliation: `grams` is the authoritative total (it
// drives every macro via verifyItems), but the model also emits quantity +
// serving_label for DISPLAY. Those can disagree when the serving label already
// encodes a count: "2 pc gulab jamun" logged quantity 2 against the "2 pieces"
// serving (130 g) while grams stayed 130 — the UI then reads "2 x 2 pieces",
// i.e. double what was actually logged. Nutrition is never touched here; we
// only rewrite the displayed quantity so quantity x serving == grams holds.
export function reconcileQuantity(
  items: ParsedItem[],
  servingsByFood: Map<string, ServingOption[]>,
): ParsedItem[] {
  return items.map((item) => {
    if (!item.food_id || !(item.grams > 0)) return item;
    const servings = servingsByFood.get(item.food_id);
    if (!servings || servings.length === 0) return item;
    const match = servings.find((s) => s.label.toLowerCase() === item.serving_label.toLowerCase());
    if (!match || !(match.grams > 0)) return item;
    const implied = item.grams / match.grams;
    // Tolerate rounding; only rewrite when the stated quantity is genuinely
    // inconsistent with the logged grams.
    if (Math.abs(implied - item.quantity) <= 0.05) return item;
    const q = implied >= 1 ? Math.round(implied * 100) / 100 : Math.round(implied * 1000) / 1000;
    return { ...item, quantity: q > 0 ? q : item.quantity };
  });
}

// Preparation-state mismatch: the user typed roasted/dried/fried but the
// matched row is a cooked/boiled food (or vice versa). Water content differs
// 2-3x, so macros are systematically wrong; surface it and drop confidence.
const DRY_PREP_RE = /\b(roasted|dry.?roasted|toasted|dried|dehydrated|fried|crispy|crunchy)\b/i;
const WET_PREP_RE = /\b(cooked|boiled|steamed|stewed)\b/i;

export function flagPrepMismatch(items: ParsedItem[], inputText: string): ParsedItem[] {
  const textDry = DRY_PREP_RE.test(inputText);
  return items.map((item) => {
    if (!textDry || !WET_PREP_RE.test(item.food_name)) return item;
    // Only flag when the mismatch is about THIS item: some content word of the
    // matched food name must appear in the user's text. Prefix match (>=4
    // chars) rather than exact: logs are typo-heavy ("edameme", "panner").
    const foodWords = item.food_name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !WET_PREP_RE.test(w));
    const textWords = inputText.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
    const overlaps = foodWords.some((fw) =>
      textWords.some((tw) => tw.startsWith(fw.slice(0, 4)) || fw.startsWith(tw.slice(0, 4)))
    );
    if (!overlaps) return item;
    return {
      ...item,
      confidence: "low",
      assumption: appendAssumption(item, "You said roasted or dried but I matched a cooked entry, calories may read low"),
    };
  });
}

/**
 * Answer "is that right?" about the meal on screen, with receipts.
 *
 * Built in CODE from the food rows, not by the model: the whole point is to
 * show where a number actually came from, and a model asked to justify its own
 * output will happily invent a justification. One catalog read per line, no
 * extra model call, so a challenge is answered in about a second.
 *
 * When the underlying row is implausible we say so outright — the user
 * challenging the number is usually right, and admitting it beats defending it.
 */
async function answerAboutPrevious(
  deps: ParseMealDeps,
  previous: PreviousItem[],
  canResearch: boolean,
): Promise<string> {
  const parts: string[] = [];
  for (const p of previous.slice(0, 3)) {
    if (!p.food_id) {
      parts.push(`${p.food_name}: my own estimate for ${round1(p.grams)} g, no label behind it.`);
      continue;
    }
    const per100 = await deps.getFoodPer100(p.food_id).catch(() => null);
    if (!per100) continue;
    const unit = per100.base_unit === "ml" ? "ml" : "g";
    const total = round1(per100.protein_g * (p.grams / 100));
    const totalKcal = round1(per100.kcal * (p.grams / 100));
    parts.push(
      `${p.food_name}: the label says ${round1(per100.protein_g)} g protein and ` +
      `${Math.round(per100.kcal)} kcal per 100 ${unit}, times ${round1(p.grams)} ${unit} = ${total} g protein.`,
    );
    // Both nets: an impossible per-100 basis, or a total that is a lot for one
    // item (the case the user actually catches, like 163 g of protein).
    const bad = implausiblePer100(per100)
      ?? implausibleLine({ ...EMPTY_LINE, protein_g: total, kcal: totalKcal });
    if (bad) parts.push(`Worth flagging: ${bad}.`);
  }
  if (parts.length === 0) return "I could not trace those numbers. Tap a line to set it yourself.";
  // The user has told us the cheap answer looks wrong, so this is exactly when
  // to offer the expensive one. Offered only here, never unprompted: volunteering
  // doubt on every meal would just teach them to distrust every number.
  parts.push(
    canResearch
      ? "Want me to look up the label online, or would you rather set it yourself?"
      : "Tap the line to set it yourself and I will use your numbers.",
  );
  return scrubDashes(parts.join(" ")).slice(0, 400);
}

/**
 * The user accepted an offer to go and check: look the label up on the web and
 * rebuild their lines from it.
 *
 * This is the one place we spend real time on purpose. Normally a web search is
 * a last resort because it costs seconds, but here the user has explicitly told
 * us the cheap answer was wrong — so the expensive answer is the right one.
 * Keeps their grams (they know what they ate) and replaces only the per-100
 * basis, which is the part that was in doubt.
 */
async function researchPrevious(
  deps: ParseMealDeps,
  previous: PreviousItem[],
  onUsage: (data: any) => void,
  onCall: () => void,
): Promise<{ items: ParsedItem[]; note: string; conflict: string | null } | null> {
  if (!deps.webSearchEnabled || previous.length === 0) return null;
  const targets: ExtractedItem[] = previous.slice(0, 3).map((p) => ({
    name: p.food_name,
    brand: null,
    quantity: p.quantity,
    unit: p.serving_label,
    prep: null,
  }));
  const labels = await runWebLookup(deps, targets, onUsage, onCall).catch(() => null);
  if (!labels || labels.size === 0) return null;

  const items: ParsedItem[] = [];
  let changed = 0;
  const conflicts: string[] = [];
  for (const p of previous) {
    let label: WebLabel | null = null;
    for (const [forItem, l] of labels) {
      if (wordsOverlap(p.food_name, forItem)) { label = l; break; }
    }
    if (!label || !(p.grams > 0)) {
      // No label for this line (not looked up, or no name match). Keep it as it
      // was: the caller replaces the whole meal with what we return.
      items.push(previousAsParsedItem(p));
      continue;
    }
    const f = p.grams / 100;

    // Does the web disagree MATERIALLY with the row we already had? Brands ship
    // near-identical names for very different products (Super Coffee sells both
    // a 60 kcal Vanilla Latte and a 150 kcal Protein+ Vanilla Latte), so a big
    // gap usually means the lookup found a DIFFERENT VARIANT rather than a
    // better number. Silently swapping there turns a right answer into a wrong
    // one, so the user gets to choose instead.
    if (p.food_id) {
      const current = await deps.getFoodPer100(p.food_id).catch(() => null);
      if (current) {
        const curKcal = current.kcal * f;
        const webKcal = label.per_100.kcal * f;
        const ref = Math.max(curKcal, webKcal);
        if (ref > 40 && Math.abs(curKcal - webKcal) / ref > 0.3) {
          conflicts.push(
            `${p.food_name}: you have ${Math.round(curKcal)} kcal logged, the label I found gives ` +
            `${Math.round(webKcal)} kcal. Brands sell close variants under the same name, so check which one you had.`,
          );
        }
      }
    }
    changed++;
    items.push({
      // food_id drops: these macros are the web label's, not that catalog row's,
      // so verifyItems must not overwrite them with the numbers we distrusted.
      food_id: null,
      food_name: p.food_name,
      quantity: p.quantity,
      serving_label: p.serving_label,
      grams: p.grams,
      kcal: round1(label.per_100.kcal * f),
      protein_g: round1(label.per_100.protein_g * f),
      carb_g: round1(label.per_100.carb_g * f),
      fat_g: round1(label.per_100.fat_g * f),
      fiber_g: label.per_100.fiber_g === null ? null : round1(label.per_100.fiber_g * f),
      source: "web",
      assumption: label.source_note ?? "Checked against the label online",
      confidence: "medium",
    });
  }
  if (changed === 0) return null;
  return {
    items,
    note: "Checked the label online and updated these numbers.",
    conflict: conflicts.length > 0 ? scrubDashes(conflicts.join(" ")).slice(0, 400) : null,
  };
}

/** Match a user's phrasing of an amount ("small", "1 medium", "2 pieces")
 *  against a food's real serving labels. Exact first, then substring both
 *  ways so "small" finds "1 small/individual". */
function matchServing(servings: ServingOption[], unit: string): ServingOption | null {
  const u = unit.trim().toLowerCase();
  if (!u) return null;
  const norm = (s: string) => s.toLowerCase().replace(/^\d+(\.\d+)?\s*/, "").trim();
  return servings.find((s) => s.label.toLowerCase() === u)
    ?? servings.find((s) => norm(s.label) === u)
    ?? servings.find((s) => norm(s.label).includes(u) || u.includes(norm(s.label)))
    ?? null;
}

/**
 * Resolve a correction WITHOUT a decide call.
 *
 * A correction like "make it a small one" changes only how much of an
 * already-identified food was eaten. The food row is known (food_id from the
 * line on screen), so its servings and per-100 macros are all we need: pick the
 * serving the user named, scale, done. That turns a ~6s reparse into ~2s (one
 * extract call plus one catalog read), which matters because corrections come
 * in bursts while the user is looking at the card.
 *
 * Returns null when anything is ambiguous — an unknown food, a serving we
 * cannot match, a changed food identity — so the caller falls back to the full
 * pipeline rather than guessing.
 */
export async function tryFastCorrection(
  deps: ParseMealDeps,
  extItems: ExtractedItem[],
  previous: PreviousItem[],
): Promise<ParsedItem[] | null> {
  const byName = new Map(previous.map((p) => [p.food_name.toLowerCase(), p]));
  const out: ParsedItem[] = [];

  for (const item of extItems) {
    const prev = item.correctsFoodName ? byName.get(item.correctsFoodName.toLowerCase()) : undefined;
    // Every line must map to a known, catalog-backed previous line.
    if (!prev || !prev.food_id) return null;
    // A changed identity ("paneer not tofu") needs a real re-resolve.
    if (!wordsOverlap(item.name, prev.food_name)) return null;

    const per100 = await deps.getFoodPer100(prev.food_id);
    if (!per100) return null;

    let grams: number | null = null;
    let servingLabel = prev.serving_label;
    const massUnit = item.unit.trim().toLowerCase();
    if (massUnit === "g" || massUnit === "ml" || massUnit === "gram" || massUnit === "grams") {
      grams = item.quantity;
      servingLabel = massUnit === "ml" ? "ml" : "g";
    } else {
      const servings = await deps.getFoodServings?.(prev.food_id) ?? [];
      const sv = matchServing(servings, item.unit)
        // "make it 2" keeps the serving and only changes the count.
        ?? (item.unit === "serving" ? matchServing(servings, prev.serving_label) : null);
      if (!sv || !(sv.grams > 0)) return null;
      grams = sv.grams * item.quantity;
      servingLabel = sv.label;
    }
    if (!(grams > 0)) return null;

    // A line the user edited by hand is authoritative. Recomputing it from the
    // catalog would silently discard the numbers they typed - the exact thing
    // ParsedItemEditor promises never happens - and relabel their line
    // "catalog". Rescale THEIR macros to the new weight and keep the
    // provenance. Without a usable previous basis there is nothing to scale,
    // so fall back to the full pipeline rather than quietly substituting the
    // catalog's numbers.
    if (prev.source === "manual") {
      if (!(prev.grams > 0) || typeof prev.kcal !== "number") return null;
      const s = grams / prev.grams;
      out.push({
        food_id: prev.food_id,
        food_name: prev.food_name,
        quantity: item.quantity,
        serving_label: servingLabel,
        grams: round1(grams),
        kcal: round1(prev.kcal * s),
        protein_g: round1((prev.protein_g ?? 0) * s),
        carb_g: round1((prev.carb_g ?? 0) * s),
        fat_g: round1((prev.fat_g ?? 0) * s),
        fiber_g: typeof prev.fiber_g === "number" ? round1(prev.fiber_g * s) : null,
        source: "manual",
        assumption: prev.assumption ?? null,
        confidence: prev.confidence ?? "high",
      });
      continue;
    }

    const f = grams / 100;
    out.push({
      food_id: prev.food_id,
      food_name: prev.food_name,
      quantity: item.quantity,
      serving_label: servingLabel,
      grams: round1(grams),
      kcal: round1(per100.kcal * f),
      protein_g: round1(per100.protein_g * f),
      carb_g: round1(per100.carb_g * f),
      fat_g: round1(per100.fat_g * f),
      fiber_g: per100.fiber_g === null ? null : round1(per100.fiber_g * f),
      source: "catalog",
      assumption: null,
      confidence: "high",
    });
  }
  return out.length > 0 ? out : null;
}

// Extract -> resolve -> decide. Two model calls on the common path (three
// or four only when server web_search fires), with every catalog lookup a
// deterministic parallel fetch between them — versus 3-6 sequential model
// turns in the old tool-loop design.
export async function runParseMeal(
  deps: ParseMealDeps,
  input: ParseMealInput,
): Promise<ParseMealResult> {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
  };
  const toolCalls: string[] = [];
  const steps: ParseStep[] = [];
  let anthropicCalls = 0;
  // Stage timing (temporary #1 latency instrumentation, folded into steps).
  const T: Record<string, number> = {};

  const accumulate = (data: any) => {
    const u = data.usage ?? {};
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.web_search_requests += u.server_tool_use?.web_search_requests ?? 0;
  };
  const declineResult = (message: string): ParseMealResult => ({
    parsed: null,
    declined: { message },
    usage,
    tool_calls: toolCalls,
    steps,
    iterations: anthropicCalls,
  });

  // ── Stage 1: extract ──────────────────────────────────────────────────────
  const prevItems = input.previousItems ?? [];
  const hasPrevious = prevItems.length > 0;
  // The prep-state guard looks for words like "roasted" in what the user wrote.
  // On a follow-up the current text is "yes" or "make it 3", so the describing
  // words live in the ORIGINAL message: match against both.
  const prepText = [input.previousText ?? "", input.text].filter(Boolean).join(" ");
  const tExtract0 = Date.now();
  const extractRes = await callAnthropicOnce(deps, {
    model: deps.model,
    max_tokens: 700,
    // The correction rules only matter when a meal is on screen, so they stay
    // out of the prompt otherwise (smaller prompt, no behaviour to misfire).
    system: cacheableSystem(hasPrevious ? EXTRACT_SYSTEM + EXTRACT_CORRECTION_RULES : EXTRACT_SYSTEM),
    tools: withToolCache([EXTRACT_TOOL]),
    tool_choice: { type: "tool", name: "extract_meal" },
    messages: [{
      role: "user",
      content: hasPrevious
        ? JSON.stringify({
          text: input.text.trim().slice(0, 500),
          // What was actually SAID, so "yes" / "no, the other one" resolve.
          recent_turns: (input.recentTurns ?? []).slice(-4).map((t) => ({
            [t.role === "user" ? "user" : "drona"]: t.text.slice(0, 240),
          })),
          previous_meal: {
            text: input.previousText ?? "",
            items: prevItems.map((p) => ({
              food_name: p.food_name,
              quantity: p.quantity,
              serving_label: p.serving_label,
              grams: p.grams,
            })),
          },
        })
        : input.text.trim().slice(0, 500),
    }],
  });
  if (!extractRes.ok) {
    throw new Error(`anthropic_${extractRes.status}: ${extractRes.body.slice(0, 300)}`);
  }
  anthropicCalls++;
  accumulate(extractRes.data);
  toolCalls.push("extract_meal");

  const extractBlock = ((extractRes.data.content ?? []) as Array<Record<string, any>>)
    .find((b) => b.type === "tool_use" && b.name === "extract_meal");
  const ext = (extractBlock?.input ?? {}) as Record<string, unknown>;
  const extItems: ExtractedItem[] = (Array.isArray(ext.items) ? ext.items : [])
    .slice(0, 12)
    .flatMap((r: unknown): ExtractedItem[] => {
      if (!r || typeof r !== "object") return [];
      const o = r as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
      if (!name) return [];
      return [{
        name,
        brand: typeof o.brand === "string" && o.brand.trim() ? o.brand.trim().slice(0, 60) : null,
        // NOT capped at 100: for a mass/volume unit the quantity IS the amount,
        // so "500 ml milk" or "250 g chicken" would be silently truncated. The
        // bound only exists to stop absurd input reaching the model.
        quantity: typeof o.quantity === "number" && Number.isFinite(o.quantity) && o.quantity > 0
          ? Math.min(o.quantity, 10000)
          : 1,
        unit: typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().slice(0, 30) : "serving",
        prep: typeof o.prep === "string" && o.prep.trim() ? o.prep.trim().slice(0, 30) : null,
        correctsFoodName: typeof o.corrects_food_name === "string" && o.corrects_food_name.trim()
          ? o.corrects_food_name.trim().slice(0, 120)
          : null,
      }];
    });
  // Only trust the correction flag when a previous meal was actually supplied.
  const correctsPrevious = hasPrevious && ext.corrects_previous === true;
  const mealFromText: MealType | null =
    ext.meal_type_from_text === "breakfast" || ext.meal_type_from_text === "lunch" ||
    ext.meal_type_from_text === "dinner" || ext.meal_type_from_text === "snack"
      ? ext.meal_type_from_text
      : null;
  steps.push({
    iter: 0,
    tool: "extract_meal",
    input: { item_count: extItems.length, declined: ext.declined === true },
  });

  // The user accepted the offer to go and check. This is the one path that
  // spends web-search time on purpose: they have told us the fast answer was
  // wrong, so the slow one is worth it.
  if (hasPrevious && ext.requests_research === true) {
    const researched = await researchPrevious(deps, prevItems, accumulate, () => anthropicCalls++)
      .catch(() => null);
    steps.push({ iter: 1, tool: "research_previous", input: { found: researched ? researched.items.length : 0 } });
    if (researched?.conflict) {
      // The web found something materially different, most likely another
      // variant. Offer it rather than apply it: a wrong silent swap is worse
      // than the number they already had.
      const items = flagPrepMismatch(checkAtwater(researched.items), prepText);
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: true } });
      return {
        parsed: null,
        declined: { message: researched.conflict },
        proposal: { items, note: "Use the label I found" },
        usage,
        tool_calls: [...toolCalls, "research_previous"],
        steps,
        iterations: anthropicCalls,
      };
    }
    if (researched) {
      const items = flagPrepMismatch(checkAtwater(researched.items), prepText);
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: true } });
      return {
        parsed: {
          meal_type: mealFromText ?? input.mealHint ?? mealForHour(input.localHour),
          items,
          drona_line: researched.note,
          corrects_previous: true,
        },
        declined: null,
        usage,
        tool_calls: [...toolCalls, "research_previous"],
        steps,
        iterations: anthropicCalls,
      };
    }
    // Nothing trustworthy online: say so plainly instead of inventing a number.
    T.decide_ms = 0;
    steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: true } });
    return {
      parsed: null,
      declined: {
        message: "I could not find a label I trust for that one. Tap the line and set the numbers yourself, and I will use them.",
      },
      usage,
      tool_calls: [...toolCalls, "research_previous"],
      steps,
      iterations: anthropicCalls,
    };
  }

  // A question about the meal on screen is answered with its real provenance,
  // never brushed off as chatter. The client keeps the card and shows this as
  // a notice, so challenging a number costs the user nothing.
  if (hasPrevious && ext.asks_about_previous === true) {
    const answer = await answerAboutPrevious(deps, prevItems, deps.webSearchEnabled).catch(() => "");
    if (answer) {
      steps.push({ iter: 1, tool: "answer_about_previous", input: { items: prevItems.length } });
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: false } });
      return {
        parsed: null,
        declined: { message: answer },
        usage,
        tool_calls: [...toolCalls, "answer_about_previous"],
        steps,
        iterations: anthropicCalls,
      };
    }
  }

  if (ext.declined === true || extItems.length === 0) {
    const msg = typeof ext.decline_message === "string" && ext.decline_message.trim()
      ? scrubDashes(ext.decline_message).slice(0, 200)
      : "That did not look like food to me. Tell me what you ate and I will log it.";
    return declineResult(msg);
  }

  T.extract_ms = tExtract0 ? Date.now() - tExtract0 : 0;

  // Correction fast path: a pure serving/quantity change on already-identified
  // foods needs no search and no decide call — just that food's servings and
  // per-100 macros. ~2s instead of ~6s. Falls through on anything ambiguous.
  if (correctsPrevious) {
    const tFast0 = Date.now();
    const correctedRaw = await tryFastCorrection(deps, extItems, prevItems).catch(() => null);
    const corrected = correctedRaw ? keepUncoveredPrevious(correctedRaw, prevItems) : null;
    T.fast_correction_ms = Date.now() - tFast0;
    if (corrected) {
      T.fast_correction = 1;
      steps.push({ iter: 1, tool: "fast_correction", input: { items: corrected.length } });
      const items = flagPrepMismatch(checkAtwater(corrected), prepText);
      T.decide_ms = 0;
      steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: false } });
      return {
        parsed: {
          meal_type: mealFromText ?? input.mealHint ?? mealForHour(input.localHour),
          items,
          drona_line: "Updated. Numbers adjusted.",
          corrects_previous: true,
        },
        declined: null,
        usage,
        tool_calls: [...toolCalls, "fast_correction"],
        steps,
        iterations: anthropicCalls,
      };
    }
    T.fast_correction = 0;
  }

  // Context (recents/targets/totals) was fired concurrently with the extract
  // call in index.ts; only the decide stage needs it. Awaiting here means those
  // DB queries overlapped extraction instead of blocking before the parse.
  if (input.contextPromise) {
    const tCtx0 = Date.now();
    try {
      const ctx = await input.contextPromise;
      input.recentFoods = ctx.recentFoods;
      input.todayTotals = ctx.todayTotals;
      input.targets = ctx.targets;
    } catch { /* non-fatal: decide runs with empty context */ }
    T.context_wait_ms = Date.now() - tCtx0;
  }

  // ── Stage 2: resolve, all items in parallel ───────────────────────────────
  const tResolve0 = Date.now();
  const resolved = await Promise.all(
    extItems.map((item) => resolveOneItem(deps, item, steps, toolCalls)),
  );
  T.resolve_ms = Date.now() - tResolve0;
  const tDecide0 = Date.now();

  // ── Stage 3: decide + hedged web lookup ───────────────────────────────────
  // The decide call is ALWAYS one forced log_meal call: unresolved items get
  // an immediate model estimate, never a blocking web turn. When web search
  // is enabled and something resolved to zero candidates, a compact label
  // lookup RACES the decide call; if it lands within the grace window its
  // label data upgrades the estimate lines server-side. Web results never
  // delay a fully-resolved meal and add at most the grace window otherwise.
  const unresolvedItems = resolved.filter((r) => r.candidates.length === 0);
  const webPromise: Promise<Map<string, WebLabel> | null> | null =
    deps.webSearchEnabled && unresolvedItems.length > 0
      ? runWebLookup(deps, unresolvedItems, accumulate, () => anthropicCalls++)
        .catch((e) => {
          deps.log?.(`[parse_meal] web lookup threw: ${String(e).slice(0, 120)}`);
          return null;
        })
      : null;
  if (webPromise) {
    toolCalls.push("web_lookup");
    steps.push({ iter: 2, tool: "web_lookup", input: { items: unresolvedItems.map((i) => i.name) } });
  }

  const decideSystem = buildDecideSystemPrompt(input);
  const decidePayload = {
    user_text: input.text.trim().slice(0, 500),
    meal_type_from_text: mealFromText,
    items: resolved.map((r) => ({
      name: r.name,
      ...(r.brand ? { brand: r.brand } : {}),
      quantity: r.quantity,
      unit: r.unit,
      ...(r.prep ? { prep: r.prep } : {}),
      // Top 4 candidates: the ranked search already puts the right row first;
      // extra candidates only inflate decide-call input tokens (latency).
      candidates: r.candidates.slice(0, 4).map(candidatePayload),
    })),
  };

  const result = await callAnthropicOnce(deps, {
    model: deps.model,
    max_tokens: deps.maxTokens,
    system: cacheableSystem(decideSystem),
    tools: withToolCache([LOG_MEAL_TOOL]),
    tool_choice: { type: "tool", name: PARSE_TERMINAL_TOOL },
    messages: [{ role: "user", content: JSON.stringify(decidePayload) }],
  });
  if (!result.ok) {
    throw new Error(`anthropic_${result.status}: ${result.body.slice(0, 300)}`);
  }
  anthropicCalls++;
  accumulate(result.data);

  const blocks: Array<Record<string, any>> = result.data.content ?? [];
  const terminal = blocks.find((b) => b.type === "tool_use" && b.name === PARSE_TERMINAL_TOOL);
  if (!terminal) {
    // Forced tool_choice makes this near-impossible; fail soft as a decline.
    return declineResult(
      "I could not pull any food out of that. Give me the foods and amounts and I will log them.",
    );
  }

  toolCalls.push(PARSE_TERMINAL_TOOL);
  const raw = (terminal.input ?? {}) as Record<string, unknown>;
  steps.push({
    iter: 2,
    tool: PARSE_TERMINAL_TOOL,
    input: { item_count: Array.isArray(raw.items) ? raw.items.length : 0 },
  });

  // Per-100 basis for every candidate we showed the model, so a failed row
  // read falls back to the numbers we already had rather than to zero.
  const candidatePer100 = new Map<string, Per100>();
  for (const r of resolved) {
    for (const c of r.candidates) {
      if (c.food_id && !candidatePer100.has(c.food_id)) {
        candidatePer100.set(c.food_id, {
          kcal: c.kcal, protein_g: c.protein_g, carb_g: c.carb_g, fat_g: c.fat_g, fiber_g: c.fiber_g,
        });
      }
    }
  }
  let items = await verifyItems(deps, clampVolumetricGrams(sanitizeItems(raw.items)), candidatePer100);
  // A correction REPLACES the reviewed meal, so never let the model quietly
  // drop a line it was told to relist.
  if (correctsPrevious) items = keepUncoveredPrevious(items, prevItems);

  // Hedge settlement: give the parallel lookup a short grace beyond the
  // decide call, then take whatever it brought (or move on without it).
  if (webPromise) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const labels = await Promise.race([
      webPromise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), WEB_MERGE_GRACE_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    steps.push({ iter: 2, tool: "web_lookup_merge", result: { found: labels ? labels.size : 0 } });
    if (labels) items = mergeWebLabels(items, labels);
  }

  // Serving options for every candidate we offered, so the display quantity can
  // be reconciled against the logged grams (see reconcileQuantity).
  const servingsByFood = new Map<string, ServingOption[]>();
  for (const r of resolved) {
    for (const c of r.candidates) {
      if (c.food_id && c.servings.length > 0 && !servingsByFood.has(c.food_id)) {
        servingsByFood.set(c.food_id, c.servings);
      }
    }
  }

  items = flagPrepMismatch(checkAtwater(reconcileQuantity(items, servingsByFood)), input.text);
  if (items.length === 0) {
    return declineResult(
      "I could not pull any food out of that. Give me the foods and amounts and I will log them.",
    );
  }
  const mealType: MealType =
    raw.meal_type === "breakfast" || raw.meal_type === "lunch" ||
    raw.meal_type === "dinner" || raw.meal_type === "snack"
      ? raw.meal_type
      : (mealFromText ?? input.mealHint ?? mealForHour(input.localHour));
  const dronaLine = typeof raw.drona_line === "string" && raw.drona_line.trim()
    ? scrubDashes(raw.drona_line).slice(0, 200)
    : "Logged. Keep the protein coming.";
  T.decide_ms = Date.now() - tDecide0;
  steps.push({ iter: 9, tool: "__timing", input: { ...T, web_fired: webPromise !== null } });
  return {
    parsed: { meal_type: mealType, items, drona_line: dronaLine, corrects_previous: correctsPrevious },
    declined: null,
    usage,
    tool_calls: toolCalls,
    steps,
    iterations: anthropicCalls,
  };
}
