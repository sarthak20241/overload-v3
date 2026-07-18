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
  source: "catalog" | "off" | "web" | "estimate";
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
  } | null;
  // Set when the model declined (non-food input) instead of logging.
  declined: { message: string } | null;
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

export interface ParseMealInput {
  text: string;
  localHour: number | null;
  mealHint: MealType | null;
  recentFoods: RecentFoodContext[];
  todayTotals: { kcal: number; protein_g: number } | null;
  targets: { daily_calorie_target: number | null; protein_target_g: number | null } | null;
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
      items: {
        type: "array",
        description: "One entry per distinct food/drink. Empty when declined.",
        items: {
          type: "object",
          properties: {
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
            kcal: { type: "number", description: "TOTAL kcal for this line (not per-100)." },
            protein_g: { type: "number", description: "TOTAL protein grams for this line." },
            carb_g: { type: "number", description: "TOTAL carb grams for this line." },
            fat_g: { type: "number", description: "TOTAL fat grams for this line." },
            fiber_g: { type: ["number", "null"], description: "TOTAL fiber grams, if known." },
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
          required: [
            "food_id", "food_name", "quantity", "serving_label", "grams",
            "kcal", "protein_g", "carb_g", "fat_g", "source", "confidence",
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

const EXTRACT_SYSTEM = `You segment free-text food logs for OVERLOAD, a lifting app. Report what the user ate via the extract_meal tool: one item per distinct food or drink, with the quantity and unit exactly as given. Correct spelling in item names ("edameme" is "edamame", "panner" is "paneer") and expand shorthand ("tblspn" is "tbsp"). Do NOT resolve nutrition, do NOT guess amounts the text does not state (use unit "serving" and quantity 1), and do NOT drop items. Composite dishes stay one item ("rajma chawal"), separately listed foods split ("paneer and 2 roti" is two).`;

export function buildDecideSystemPrompt(input: ParseMealInput, webSearchEnabled: boolean): string {
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

  const webTier = webSearchEnabled
    ? `- web_search (max 2, LAST resort): only for a NAMED product or restaurant item with no acceptable candidate. Search the official nutrition label ("<brand> <product> nutrition facts per 100g"), read numbers only from the brand's own site or a label listing, set source "web", name the source in assumption.\n`
    : "";

  return `You finalize food log entries for OVERLOAD, a lifting app. Each extracted item below carries CANDIDATE foods (per-100 macros plus serving options) already fetched from the catalog. Pick the right candidate per item, convert the quantity to grams, and log everything with ONE log_meal call. Coach Drona's voice appears only in drona_line and assumption strings: direct, warm, coach-like, never robotic. Never use em dashes anywhere in user-facing strings.

<candidate_rules>
- Choose the candidate that IS the food, not one merely similar. For generic Indian foods prefer the curated staples (Roti, Toor Dal, Curd, Toned Milk) over obscure branded rows. For a plain whole food ("chicken breast", "rice", "milk") prefer the plain/cooked/generic row over processed, fat-free, dried, deli, or flavored variants unless the user named that variant.
- Respect the item's prep state: never log a roasted/dried/fried item against a cooked/boiled candidate (2-3x density difference). If only a wrong-state candidate exists, estimate instead.
- No acceptable candidate: estimate from your own knowledge. food_id null, source "estimate", confidence low or medium, assumption naming what you assumed. Never refuse to log a real food.
${webTier}</candidate_rules>

<quantity_rules>
- Candidates list macros PER 100 of base_unit (g or ml). grams on each logged item is the TOTAL amount eaten; compute line macros as per100 * grams / 100, times nothing else (quantity is already inside grams).
- Use the candidate's serving options to convert household units. When the user gives an explicit amount ("50g", "500 ml"), that wins over any serving default.
- Spoon and cup weights DEPEND ON THE FOOD; a tablespoon is 15 g only for water-like liquids. If the candidate has a cup serving, derive from it (1 cup = 16 tbsp = 48 tsp). Otherwise: 1 tbsp of nuts, seeds, or roasted snacks ~8 g; powders (protein, flour, spices) ~7-9 g; oil or ghee ~14 g; nut butter, honey ~16-20 g. A guessed spoon weight is never confidence high.
- Indian household defaults when the user gives no amount and no serving option fits: 1 roti ~40 g, 1 katori ~150 g cooked, 1 glass ~250 ml, 1 cup ~200 ml, 1 bowl ~250 g, 1 scoop whey ~32 g, 1 egg ~50 g. Record any such guess in assumption.
- Piece counts for small foods use the candidate's per-piece serving when one exists; otherwise: 1 almond ~1.2 g, 1 cashew ~1.5 g, 1 walnut half ~2 g, 1 peanut ~0.9 g, 1 kimia date ~8 g, 1 medjool date ~24 g. "5 almonds" is ~6 g, never 25.
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
}

interface ResolvedItem extends ExtractedItem {
  candidates: CandidateFood[];
}

// A cup serving anchors every spoon: 1 cup = 16 tbsp = 48 tsp. Deriving the
// spoon weights in code hands the decide model real numbers instead of a
// water-density guess (the 2x roasted-edamame bug).
function synthesizeVolumeAnchors(c: CandidateFood): CandidateFood {
  if (c.base_unit !== "g") return c;
  const has = (re: RegExp) => c.servings.some((s) => re.test(s.label.toLowerCase()));
  const cup = c.servings.find((s) => /(^|\b)1?\s*cup\b/.test(s.label.toLowerCase()) && s.grams > 30 && s.grams < 400);
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
  const queries = [item.name];
  if (item.brand) queries.push(`${item.brand} ${item.name}`);
  const words = item.name.split(/\s+/).filter(Boolean);
  for (let n = words.length - 1; n >= 1; n--) {
    const q = words.slice(0, n).join(" ");
    if (!queries.includes(q)) queries.push(q);
  }
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

  return { ...item, candidates: candidates.map(synthesizeVolumeAnchors) };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// House rule: no em/en dashes in any user-facing string. The prompt asks for
// this, but a deterministic scrub beats hoping the model complies.
function scrubDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
}

// The receipts step: for items the model matched to a real food row, recompute
// line macros from the row's per-100 values so catalog-backed numbers are
// deterministic, never model arithmetic. Items whose row can't be read keep
// the model's numbers (their grams still came from the same candidates).
async function verifyItems(deps: ParseMealDeps, items: ParsedItem[]): Promise<ParsedItem[]> {
  return await Promise.all(items.map(async (item) => {
    if (!item.food_id || (item.source !== "catalog" && item.source !== "off")) return item;
    if (!Number.isFinite(item.grams) || item.grams <= 0) return item;
    const per100 = await deps.getFoodPer100(item.food_id);
    if (!per100) return item;
    const f = item.grams / 100;
    return {
      ...item,
      kcal: round1(per100.kcal * f),
      protein_g: round1(per100.protein_g * f),
      carb_g: round1(per100.carb_g * f),
      fat_g: round1(per100.fat_g * f),
      fiber_g: per100.fiber_g === null ? item.fiber_g : round1(per100.fiber_g * f),
    };
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
    const totalMl = perLabelMl * item.quantity;
    const density = item.grams / totalMl;
    if (density >= DENSITY_MIN && density <= DENSITY_MAX) return item;
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
// Model-estimated lines get kcal recomputed from their macros; catalog/off
// lines that fail have a bad source row, so flag rather than trust.
export function checkAtwater(items: ParsedItem[]): ParsedItem[] {
  return items.map((item) => {
    const atwater = 4 * item.protein_g + 4 * item.carb_g + 9 * item.fat_g;
    if (atwater < 20 && item.kcal < 20) return item;
    const ref = Math.max(item.kcal, atwater);
    if (ref <= 0 || Math.abs(item.kcal - atwater) / ref <= 0.3) return item;
    if (item.source === "estimate" || item.source === "web") {
      return { ...item, kcal: round1(atwater) };
    }
    return {
      ...item,
      confidence: "low",
      assumption: appendAssumption(item, "Calories and macros disagree on the source label, treat this line as rough"),
    };
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
  const extractRes = await callAnthropicOnce(deps, {
    model: deps.model,
    max_tokens: 700,
    system: cacheableSystem(EXTRACT_SYSTEM),
    tools: withToolCache([EXTRACT_TOOL]),
    tool_choice: { type: "tool", name: "extract_meal" },
    messages: [{ role: "user", content: input.text.trim().slice(0, 500) }],
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
        quantity: typeof o.quantity === "number" && Number.isFinite(o.quantity) && o.quantity > 0
          ? Math.min(o.quantity, 100)
          : 1,
        unit: typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().slice(0, 30) : "serving",
        prep: typeof o.prep === "string" && o.prep.trim() ? o.prep.trim().slice(0, 30) : null,
      }];
    });
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

  if (ext.declined === true || extItems.length === 0) {
    const msg = typeof ext.decline_message === "string" && ext.decline_message.trim()
      ? scrubDashes(ext.decline_message).slice(0, 200)
      : "That did not look like food to me. Tell me what you ate and I will log it.";
    return declineResult(msg);
  }

  // ── Stage 2: resolve, all items in parallel ───────────────────────────────
  const resolved = await Promise.all(
    extItems.map((item) => resolveOneItem(deps, item, steps, toolCalls)),
  );

  // ── Stage 3: decide (single forced-tool call on the common path) ──────────
  // web_search only earns its latency when an item resolved to NOTHING; with a
  // candidate in hand the model just picks and converts. Gating it here means
  // the common fully-resolved meal is one forced log_meal call (no auto-tool
  // deliberation, no web tool schema) instead of an open-ended turn.
  const anyUnresolved = resolved.some((r) => r.candidates.length === 0);
  const useWebSearch = deps.webSearchEnabled && anyUnresolved;
  const decideSystem = buildDecideSystemPrompt(input, useWebSearch);
  const decideTools: unknown[] = [LOG_MEAL_TOOL];
  if (useWebSearch) decideTools.push(WEB_SEARCH_TOOL);
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
  const conversation: AnthropicMsg[] = [
    { role: "user", content: JSON.stringify(decidePayload) },
  ];

  const MAX_DECIDE_TURNS = 3;
  for (let turn = 0; turn < MAX_DECIDE_TURNS; turn++) {
    // Web search needs tool_choice auto to be usable; without it (or on the
    // final turn) force log_meal so the flow always terminates in one shot.
    const forceLog = !useWebSearch || turn === MAX_DECIDE_TURNS - 1;
    const result = await callAnthropicOnce(deps, {
      model: deps.model,
      max_tokens: deps.maxTokens,
      system: cacheableSystem(decideSystem),
      tools: withToolCache(decideTools),
      messages: conversation,
      ...(forceLog ? { tool_choice: { type: "tool", name: PARSE_TERMINAL_TOOL } } : {}),
    });
    if (!result.ok) {
      throw new Error(`anthropic_${result.status}: ${result.body.slice(0, 300)}`);
    }
    anthropicCalls++;
    accumulate(result.data);

    const stopReason = result.data.stop_reason;
    const blocks: Array<Record<string, any>> = result.data.content ?? [];

    // Server-side web search paused the turn: re-send as-is to resume.
    if (stopReason === "pause_turn") {
      toolCalls.push("web_search");
      steps.push({ iter: 2, tool: "web_search" });
      conversation.push({ role: "assistant", content: blocks });
      continue;
    }

    const terminal = blocks.find((b) => b.type === "tool_use" && b.name === PARSE_TERMINAL_TOOL);
    if (!terminal) {
      // Text or an unexpected stop: push the turn and force log_meal next.
      conversation.push({ role: "assistant", content: blocks });
      conversation.push({ role: "user", content: "Call log_meal now with your best final entries for every item." });
      continue;
    }

    toolCalls.push(PARSE_TERMINAL_TOOL);
    const raw = (terminal.input ?? {}) as Record<string, unknown>;
    steps.push({
      iter: 2,
      tool: PARSE_TERMINAL_TOOL,
      input: { item_count: Array.isArray(raw.items) ? raw.items.length : 0 },
    });
    const items = flagPrepMismatch(
      checkAtwater(await verifyItems(deps, clampVolumetricGrams(sanitizeItems(raw.items)))),
      input.text,
    );
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
    return {
      parsed: { meal_type: mealType, items, drona_line: dronaLine },
      declined: null,
      usage,
      tool_calls: toolCalls,
      steps,
      iterations: anthropicCalls,
    };
  }

  throw new Error(`parse_meal decide stage hit the ${MAX_DECIDE_TURNS}-turn cap without logging`);
}
