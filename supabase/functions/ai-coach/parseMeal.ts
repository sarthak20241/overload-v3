// parse_meal mode: free-text food logging ("oats yogabar 50g and milk 500 ml")
// parsed into catalog-grounded meal entries. Kept separate from index.ts and
// runtime-agnostic (no Deno/jsr imports, dependencies injected) so the eval
// harness in scripts/parse-meal-eval/ can drive the exact production pipeline
// from Node against real catalog data.
//
// The trust model is a fallback LADDER, not a single guess:
//   Tier 1  search_foods         -> our catalog (macros come from the row)
//   Tier 2  lookup_packaged_food -> live Open Food Facts, backfilled into
//                                   `foods` (source 'off') so the catalog
//                                   compounds with usage
//   Tier 3  web_search           -> Anthropic server tool, label data for
//                                   named items neither lookup has (capped)
//   Tier 4  model estimate       -> flagged, food_id null, lowest trust
//
// For tier 1/2 items the model only MATCHES and converts quantity to grams;
// the macros are recomputed server-side from the food row (verifyItems), so
// catalog-backed numbers are never model-invented.

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

const SEARCH_FOODS_TOOL = {
  name: "search_foods",
  description:
    "Search the Overload food catalog (USDA + Open Food Facts India + curated Indian staples). " +
    "ALWAYS call this first for EVERY food item in the user's text, using plain food words " +
    '("toor dal", "roti", "whey protein") rather than the user\'s full phrasing. For multi-item ' +
    "meals you MUST batch: emit ALL search_foods calls together in your FIRST tool turn, one per " +
    "item, in parallel. Never search one item, wait, then search the next. Returns candidates " +
    "with per-100 macros and named serving options (label plus grams).",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: 'Short generic food name, e.g. "curd" not "a small bowl of homemade curd".',
      },
    },
    required: ["query"],
  },
};

const LOOKUP_PACKAGED_TOOL = {
  name: "lookup_packaged_food",
  description:
    "Look up a BRANDED or packaged product in the live Open Food Facts database. Use ONLY when " +
    "search_foods returned no acceptable match for a branded/packaged item (bars, drinks, snacks, " +
    'supplements). Query with brand plus product words, e.g. "yogabar multigrain energy bar". ' +
    "Slower than search_foods; never use it for generic foods like rice or dal.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Brand + product words." },
    },
    required: ["query"],
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

export function buildParseSystemPrompt(input: ParseMealInput, webSearchEnabled: boolean): string {
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
    ? `3. web_search (LAST network resort, max 2 searches): only for a NAMED product or restaurant item that both lookups missed. Search for the official nutrition label ("<brand> <product> nutrition facts per 100g"). Read numbers only from the brand's own site or a label photo listing; set source "web" and name the source in assumption.\n`
    : "";
  const estimateTier = webSearchEnabled ? "4" : "3";

  return `You parse free-text food logs for OVERLOAD, a lifting app. The user typed what they ate; you resolve it into precise entries and log them with the log_meal tool. Coach Drona's voice appears only in drona_line and assumption strings: direct, warm, coach-like, never robotic. Never use em dashes anywhere in user-facing strings.

<resolution_ladder>
Resolve every item down this ladder, stopping at the first tier that gives a trustworthy match:
1. search_foods (ALWAYS first, every item): match against the catalog. Prefer exact/close name matches; for generic Indian foods prefer the curated staples (Roti, Toor Dal, Curd, Toned Milk) over obscure branded rows. When the user names a plain whole food ("chicken breast", "rice", "milk"), prefer the plain/cooked/generic row over processed, fat-free, dried, deli, or flavored variants unless they actually named that variant. A match is acceptable when the food is genuinely the same thing, not merely similar.
2. lookup_packaged_food: branded/packaged items only, when tier 1 misses.
${webTier}${estimateTier}. Estimate from your own knowledge: set food_id null, source "estimate", confidence low or medium, and write an assumption naming what you assumed. Never refuse to log a real food just because lookups missed.

Search budget: at most TWO search rounds total. Round one: search_foods for every item at once. Round two (only if needed): retry misses with ONE alternate phrasing or lookup_packaged_food. After that, estimate whatever is still unresolved and log. Never keep re-searching variants of the same dish.
</resolution_ladder>

<quantity_rules>
- Candidates list macros PER 100 of base_unit (g or ml). grams on each logged item is the TOTAL amount eaten; compute line macros as per100 * grams / 100, times nothing else (quantity is already inside grams).
- Use the candidate's serving options to convert household units. When the user gives an explicit amount ("50g", "500 ml"), that wins over any serving default.
- Spoon and cup weights DEPEND ON THE FOOD; a tablespoon is 15 g only for water-like liquids. If the candidate has a cup serving, derive from it (1 cup = 16 tbsp = 48 tsp). Otherwise: 1 tbsp of nuts, seeds, or roasted snacks ~8 g; powders (protein, flour, spices) ~7-9 g; oil or ghee ~14 g; nut butter, honey ~16-20 g. A guessed spoon weight is never confidence high.
- Indian household defaults when the user gives no amount and no serving option fits: 1 roti ~40 g, 1 katori ~150 g cooked, 1 glass ~250 ml, 1 cup ~200 ml, 1 bowl ~250 g, 1 scoop whey ~32 g, 1 egg ~50 g. Record any such guess in assumption.
- Match the preparation state the user typed: "roasted" or "dried" foods are 2-3x more calorie-dense per gram than "cooked" or "boiled" ones. Never log a roasted/dried item against a cooked/boiled candidate row; prefer a correct-state candidate or estimate instead.
- "half" quantities are fine (quantity 0.5).
</quantity_rules>

<behavior>
- The user's recent foods (below) are strong hints: "milk" from someone who always logs Toned Milk means toned milk. Say so in assumption when you rely on this.
- meal_type: if the text names a meal ("for lunch", "dinner was"), use that. Otherwise use the hint EXACTLY: ${hint}. Do NOT infer the meal from what the food "usually" is: paneer bhurji at 9pm is dinner, not breakfast. Time of day decides, never the dish.
- Multiple foods in one text = multiple items in ONE log_meal call.
- NEVER ask the user a question. This is a one-shot logger, not a chat: the user gets no chance to reply. If an amount is missing, assume ONE standard serving (use the household defaults above) and note it in assumption, e.g. "Took that as one katori, 150 g." If a brand/variant is ambiguous, pick the most common one and say so. Estimate and log; do not stall for clarification.
- "No catalog match" is NEVER a reason to stop. If search_foods and lookup_packaged_food both miss, estimate the macros from your own knowledge (source "estimate"), note it in assumption, and log anyway. A branded snack you recognize (Haldiram's bhujia, Epigamia yogurt, etc.) always gets logged with an estimate, never declined.
- ONLY decline (reply with text instead of log_meal) when the text contains NOTHING loggable as food or drink at all: a pure question, an exercise, or chatter. Any real food or drink, however vague, MUST be logged. When you decline, reply with one short Drona-voice sentence redirecting them to log food.
- Except for that decline case, you MUST finish by calling log_meal exactly once. Never write the parsed meal, macros, or a follow-up question as assistant text.
- drona_line reacts to the meal against the day so far (see context): protein lands first, praise effort, nudge gaps. One sentence, max ~15 words.
</behavior>

<user_context>
Recent foods this user logs:
${recents}

${day}
</user_context>`;
}

// ── Tool loop ───────────────────────────────────────────────────────────────

const MAX_PARSE_ITERATIONS = 6;

interface AnthropicMsg {
  role: "user" | "assistant";
  content: string | unknown[];
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

async function executeParseTool(
  deps: ParseMealDeps,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  try {
    if (name === "search_foods") {
      const q = String(input.query ?? "").trim();
      if (!q) return { candidates: [] };
      const candidates = await deps.searchFoods(q);
      return { candidates: candidates.slice(0, 6).map(candidatePayload) };
    }
    if (name === "lookup_packaged_food") {
      const q = String(input.query ?? "").trim();
      if (!q) return { candidates: [] };
      const fetchFn = deps.fetchFn ?? fetch;
      const products = await searchOpenFoodFacts(q, fetchFn, deps.log);
      const candidates: CandidateFood[] = [];
      for (const p of products) {
        // Backfill first so the candidate carries a real food_id and the
        // NEXT user's search_foods finds it at tier 1.
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
      return { candidates: candidates.map(candidatePayload) };
    }
    return { error: `unknown tool: ${name}` };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
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

// Compact a tool result for the trace: arrays -> {count, top names}; big objects
// -> a truncated preview. Keeps parse_traces.steps small + readable for eval.
function summarizeToolResult(result: unknown): unknown {
  if (Array.isArray(result)) {
    return {
      count: result.length,
      top: result.slice(0, 5).map((r) => (r as Record<string, unknown>)?.name ?? (r as Record<string, unknown>)?.food_name ?? r),
    };
  }
  if (result && typeof result === "object") {
    const s = JSON.stringify(result);
    if (s.length > 600) return { preview: s.slice(0, 600) };
  }
  return result;
}

export async function runParseMeal(
  deps: ParseMealDeps,
  input: ParseMealInput,
): Promise<ParseMealResult> {
  const system = buildParseSystemPrompt(input, deps.webSearchEnabled);
  const tools: unknown[] = [SEARCH_FOODS_TOOL, LOOKUP_PACKAGED_TOOL, LOG_MEAL_TOOL];
  if (deps.webSearchEnabled) tools.push(WEB_SEARCH_TOOL);

  const conversation: AnthropicMsg[] = [
    { role: "user", content: input.text.trim().slice(0, 500) },
  ];

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
  };
  const toolCalls: string[] = [];
  const steps: ParseStep[] = [];

  for (let iter = 0; iter < MAX_PARSE_ITERATIONS; iter++) {
    // Last iteration: force log_meal so a model stuck re-searching settles
    // with what it has (estimates included) instead of erroring out. The
    // eval's composite-dish cases (rajma chawal) hit exactly this.
    const lastIteration = iter === MAX_PARSE_ITERATIONS - 1;
    const result = await callAnthropicOnce(deps, {
      model: deps.model,
      max_tokens: deps.maxTokens,
      system,
      tools,
      messages: conversation,
      ...(lastIteration ? { tool_choice: { type: "tool", name: PARSE_TERMINAL_TOOL } } : {}),
    });
    if (!result.ok) {
      throw new Error(`anthropic_${result.status}: ${result.body.slice(0, 300)}`);
    }

    const data = result.data;
    const u = data.usage ?? {};
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.web_search_requests += u.server_tool_use?.web_search_requests ?? 0;

    const stopReason = data.stop_reason;
    const blocks: Array<Record<string, any>> = data.content ?? [];

    // Server-side web search paused mid-loop: re-send as-is to resume.
    if (stopReason === "pause_turn") {
      toolCalls.push("web_search");
      steps.push({ iter, tool: "web_search" });
      conversation.push({ role: "assistant", content: blocks });
      continue;
    }

    if (stopReason !== "tool_use") {
      // No tool call: the model declined (non-food) or drifted. Either way,
      // nothing was logged; surface the text as the decline message.
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
        .trim();
      return {
        parsed: null,
        declined: {
          message: text || "That did not look like food to me. Tell me what you ate and I will log it.",
        },
        usage,
        tool_calls: toolCalls,
        steps,
        iterations: iter + 1,
      };
    }

    const toolUses = blocks.filter((b) => b.type === "tool_use");
    const terminal = toolUses.find((b) => b.name === PARSE_TERMINAL_TOOL);

    if (terminal) {
      toolCalls.push(PARSE_TERMINAL_TOOL);
      const raw = (terminal.input ?? {}) as Record<string, unknown>;
      steps.push({
        iter,
        tool: PARSE_TERMINAL_TOOL,
        input: { item_count: Array.isArray(raw.items) ? raw.items.length : 0 },
      });
      const items = flagPrepMismatch(
        checkAtwater(await verifyItems(deps, clampVolumetricGrams(sanitizeItems(raw.items)))),
        input.text,
      );
      if (items.length === 0) {
        return {
          parsed: null,
          declined: {
            message: "I could not pull any food out of that. Give me the foods and amounts and I will log them.",
          },
          usage,
          tool_calls: toolCalls,
          steps,
          iterations: iter + 1,
        };
      }
      const mealType: MealType =
        raw.meal_type === "breakfast" || raw.meal_type === "lunch" ||
        raw.meal_type === "dinner" || raw.meal_type === "snack"
          ? raw.meal_type
          : (input.mealHint ?? mealForHour(input.localHour));
      const dronaLine = typeof raw.drona_line === "string" && raw.drona_line.trim()
        ? scrubDashes(raw.drona_line).slice(0, 200)
        : "Logged. Keep the protein coming.";
      return {
        parsed: { meal_type: mealType, items, drona_line: dronaLine },
        declined: null,
        usage,
        tool_calls: toolCalls,
        steps,
        iterations: iter + 1,
      };
    }

    // Client tools (search_foods / lookup_packaged_food): execute in parallel.
    // Any server web_search blocks in this turn were already handled by the
    // API itself; we only answer the client-tool blocks.
    const toolResults = await Promise.all(
      toolUses.map(async (block) => {
        const toolName = String(block.name ?? "<unknown>");
        toolCalls.push(toolName);
        const result = await executeParseTool(deps, toolName, block.input ?? {});
        steps.push({ iter, tool: toolName, input: block.input ?? {}, result: summarizeToolResult(result) });
        return {
          type: "tool_result" as const,
          tool_use_id: String(block.id ?? ""),
          content: JSON.stringify(result),
        };
      }),
    );

    conversation.push({ role: "assistant", content: blocks });
    conversation.push({ role: "user", content: toolResults });
  }

  throw new Error(`parse_meal hit the ${MAX_PARSE_ITERATIONS}-iteration cap without logging`);
}
