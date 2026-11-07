// The live adapter: today's food box (Precise mode), run on one case.
//
//   EVAL_VIA_CLI=1 ADAPTER=live npx tsx scripts/food-box-eval/run.mts
//
// What runs is the production code, unchanged: the router (Jev, then the Haiku
// fallback), the parse (supabase/functions/ai-coach/parseMeal.ts) in Precise,
// the food agent beside a card, and resolveFoodBarOutcome picking what to serve
// (all in foodBar.ts). Then lib/foodBarCard.ts turns the answer into the card
// the app would show, the same function the Nutrition screen uses.
//
// What is the case's, not the account's: saved meals, food memory and the
// diary come from the case fixtures. The catalog and the shared label cache
// are the live ones, READ only. Nothing here writes: no diary, no cache, no
// memory, no trace.
//
// What differs from production, and why:
//   - Model calls go through `claude -p` with EVAL_VIA_CLI=1 (owner rule).
//     Times and token counts are then the CLI's, never the pipeline's.
//   - A CLI process that dies (HTTP 502 from the shim) is retried once. That
//     can also hide a real 502, which the pipeline never sees in production
//     from the CLI anyway: read a case's failure detail before blaming either.
//   - The web label lookup is off unless EVAL_WEB=1 (Tavily, spends credits).
//     Production uses Anthropic's server web search, which the CLI cannot run.
//   - FOOD_THREADS (off by default, as live) decides whether the thread store
//     is in play. With FOOD_THREADS=on the case's `thread.earlierCards` and its
//     card on screen are loaded into an in-memory store (foodThreads.ts
//     memoryThreadStore, the same rules as the tables), and the agent gets the
//     index line, copy_lines and read_card (and restore_card with no card on
//     screen). Off: earlier cards are not sent, as today. copy_lines from the
//     diary works either way (it reads the case's diary fixture).
//   - FOOD_AGENT_LATER (off by default, as live): on sends every later
//     message of a thread (earlier turns, a card open, or a question waiting)
//     to the food agent, as index.ts does in Precise (foodBar.ts
//     runLaterMessage). A case's openQuestion is the app's pending_meal.
//   - Cost and turns per message: every model call a case makes is counted
//     (AsyncLocalStorage, so concurrent cases do not mix) and priced at the
//     model_pricing rows. Through the CLI the token counts are the CLI's.
//   - The secrets the live function reads are not visible here. Defaults:
//     FOOD_INTENT_MODE=on, THOROUGH_MATCH_MODE / PRECISE_MATCH_MODE off.
//     Each can be set in the environment to match a deploy.

import "../parse-meal-eval/denoShim";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { makeClaudeCliFetch } from "../parse-meal-eval/claude-cli-fetch";
import {
  type AnthropicCallResult,
  configureFoodBar,
  noParseResult,
  resolveFoodBarOutcome,
  runFirstMessage,
  runLaterMessage,
  startFoodAgent,
  startFoodIntent,
} from "../../supabase/functions/ai-coach/foodBar";
import type { CardLine, FoodConversationContext } from "../../supabase/functions/ai-coach/foodContext";
import { cardMayBeCut, readFoodContext } from "../../supabase/functions/ai-coach/foodContext";
import {
  continuesPendingMeal,
  firstMessageGoesToGate,
  isPreciseRequest,
  laterMessageGoesToAgent,
  parseFoodAgentLaterMode,
  parseFoodFirstGateMode,
  parseFoodIntentMode,
} from "../../supabase/functions/ai-coach/foodIntent";
import type { PendingFoodMeal } from "../../supabase/functions/ai-coach/foodContext";
import {
  type CandidateFood,
  type ParsedItem,
  type ParseMealDeps,
  type PreviousItem,
  runParseMeal,
} from "../../supabase/functions/ai-coach/parseMeal";
import type { SavedMealForParse } from "../../supabase/functions/ai-coach/savedMeals";
import type { MemoryEntry } from "../../supabase/functions/ai-coach/userFoodMemory";
import { listLoggedMeals, type MealRowIn } from "../../supabase/functions/ai-coach/loggedMeals";
import { SONNET_MODEL } from "../../supabase/functions/_shared/sonnet";
import {
  cardAsLines,
  memoryThreadStore,
  parseFoodThreadsMode,
  threadForAgent,
} from "../../supabase/functions/ai-coach/foodThreads";
import type { FoodBarThread } from "../../supabase/functions/ai-coach/foodBar";
import { randomUUID } from "node:crypto";
import { cardAfter } from "../../lib/foodBarCard";
import type { Action, CaseMetrics, FoodBoxCase, Line, Outcome, SavedMeal } from "./types";

// ── Env ─────────────────────────────────────────────────────────────────────

/** The main checkout of this repo, from git (a worktree's common .git sits in
 *  it), so a worktree with no .env.local can use the main one. Null outside git. */
function mainCheckout(): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
  } catch {
    return null;
  }
}

function dotEnv(): Record<string, string> {
  // EVAL_ENV_FILE, then this checkout's .env.local, then the main checkout's
  // (a git worktree has none of its own). Which one is read is printed.
  const main = mainCheckout();
  const paths = [process.env.EVAL_ENV_FILE, ".env.local", main ? `${main}/.env.local` : null].filter((p): p is string => !!p);
  for (const path of paths) {
    try {
      const text = readFileSync(path, "utf8");
      console.log(`[eval] env from ${path}`);
      const out: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      return out;
    } catch { /* next */ }
  }
  return {};
}
const dot = dotEnv();
const env = (k: string) => process.env[k] ?? dot[k] ?? "";

const PARSE_MODEL = "claude-haiku-5-5"; // PARSE_MEAL_MODEL in index.ts
const VIA_CLI = env("EVAL_VIA_CLI") === "1";
const API_KEY = env("ANTHROPIC_API_KEY");
const JEV_API_KEY = env("JEV_API_KEY");
const WEB = env("EVAL_WEB") === "1" && !!env("TAVILY_API_KEY");
const INTENT_MODE = parseFoodIntentMode(env("FOOD_INTENT_MODE") || "on");
const THREADS = parseFoodThreadsMode(env("FOOD_THREADS"));
const LATER = parseFoodAgentLaterMode(env("FOOD_AGENT_LATER"));
const FIRST_GATE = parseFoodFirstGateMode(env("FOOD_FIRST_GATE"));
const match = (k: string): "off" | "shadow" | "on" => (["shadow", "on"] as const).find((m) => m === env(k)) ?? "off";

const SUPABASE_URL = env("EXPO_PUBLIC_SUPABASE_URL");
const ANON = env("EXPO_PUBLIC_SUPABASE_ANON_KEY");
// The shared label cache is revoked from anon (0109): its read needs the
// service role. Its ONLY use below is the precise_cache_get rpc (a select).
// Do not hand this client to anything that writes.
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");

/** The adapter's name, and its BASELINE.md section: the thread store changes
 *  what is measured, so a run with it on keeps its own section. */
export function liveName(): string {
  return FIRST_GATE === "on" ? "live_first" : LATER === "on" ? "live_later" : THREADS === "on" ? "live_threads" : "live";
}

export function liveReady(): string | null {
  if (!SUPABASE_URL || !ANON) return "Missing EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY (env or .env.local).";
  if (!VIA_CLI && !API_KEY) return "Set EVAL_VIA_CLI=1 (owner rule), or ANTHROPIC_API_KEY for a latency run.";
  // live_later is measured with the thread store on; a run without it would
  // write its numbers under the same name.
  if (LATER === "on" && THREADS !== "on") return "FOOD_AGENT_LATER=on is measured with FOOD_THREADS=on. Set both.";
  // live_first is step 3 on top of step 2: the gate's numbers are only
  // comparable with live_later.
  if (FIRST_GATE === "on" && LATER !== "on") return "FOOD_FIRST_GATE=on is measured with FOOD_AGENT_LATER=on and FOOD_THREADS=on. Set all three.";
  return null;
}

const anon = createClient(SUPABASE_URL || "http://x", ANON || "x", { auth: { persistSession: false, autoRefreshToken: false } });
/** The one thing the service role is used for. The client stays inside this
 *  closure, so nothing else in the eval can reach it to write. */
const preciseCacheRead: ((key: string) => Promise<unknown>) | null = SERVICE
  ? (() => {
    const service = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    return async (key: string) => (await service.rpc("precise_cache_get", { p_key: key }).maybeSingle()).data ?? null;
  })()
  : null;

// Each body names its own model (Haiku for the parse and the router, Sonnet
// for the agent), so the CLI runs each on that one.
// A CLI process that died is the harness, not the pipeline: one retry, so a
// flaky spawn does not score as a failed case. Never on the API path.
const rawCliFetch = VIA_CLI ? makeClaudeCliFetch(PARSE_MODEL, { modelFromBody: true, freeChoice: true }) : null;

// ── Cost and turns per case ─────────────────────────────────────────────────

/** $ per million tokens: input, output, cache read, cache write. A copy of
 *  the model_pricing rows (20261011120000, 20261011150000): update both. */
const PRICE: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.10, 0.50, 0.01, 0.125],
  "claude-sonnet-5-5": [2.00, 10.00, 0.20, 2.50],
};
interface Meter {
  calls: number;
  byModel: Record<string, { calls: number; input: number; output: number; cache_read: number; cache_write: number }>;
}
const meter = new AsyncLocalStorage<Meter>();

/** Count one model call against the case that made it. */
function metered(f: typeof fetch): typeof fetch {
  return (async (url, init) => {
    const r = await f(url as never, init);
    const m = meter.getStore();
    if (!m || !r.ok) return r;
    try {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      const data = await r.clone().json() as {
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      };
      // A body with no model runs on the parse model (the CLI shim's default).
      const model = body.model ?? PARSE_MODEL;
      const row = (m.byModel[model] ??= { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 });
      row.calls++;
      row.input += data.usage?.input_tokens ?? 0;
      row.output += data.usage?.output_tokens ?? 0;
      // API runs only: the CLI does not exercise prompt caching.
      row.cache_read += data.usage?.cache_read_input_tokens ?? 0;
      row.cache_write += data.usage?.cache_creation_input_tokens ?? 0;
      m.calls++;
    } catch { /* metering never fails a case */ }
    return r;
  }) as typeof fetch;
}

const cliFetch: typeof fetch | null = rawCliFetch
  ? metered((async (url, init) => {
    const r = await rawCliFetch(url as never, init);
    return r.status === 502 ? rawCliFetch(url as never, init) : r;
  }) as typeof fetch)
  : null;
const fetchFn: typeof fetch = cliFetch ?? metered(fetch);

const warnedModels = new Set<string>();

function metricsOf(m: Meter, route: CaseMetrics["route"], agentTurns: number, gate?: CaseMetrics["gate"]): CaseMetrics {
  let cost = 0;
  for (const [model, v] of Object.entries(m.byModel)) {
    // A model with no price row here is costed at 0: say so once, so a model
    // change cannot make the cost look lower without anyone seeing it. The
    // rates copy model_pricing; update both together.
    if (!PRICE[model] && !warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`[eval] no price for model "${model}": its calls count as $0 (add it to PRICE in live.ts)`);
    }
    const [i, o, cr, cw] = PRICE[model] ?? [0, 0, 0, 0];
    cost += (v.input * i + v.output * o + v.cache_read * cr + v.cache_write * cw) / 1_000_000;
  }
  return { route, agentTurns, calls: m.calls, costUsd: Math.round(cost * 100000) / 100000, byModel: m.byModel, ...(gate ? { gate } : {}) };
}

async function callAnthropic(payload: Record<string, unknown>, timeoutMs = 80_000): Promise<AnthropicCallResult> {
  const ac = new AbortController();
  // The CLI is slower than the API by seconds per call; its own timeout rules.
  const t = VIA_CLI ? null : setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 502, body: String(e) };
  } finally {
    if (t) clearTimeout(t);
  }
}

configureFoodBar({
  intentMode: INTENT_MODE,
  anthropicApiKey: API_KEY || (VIA_CLI ? "cli" : undefined),
  parseModel: PARSE_MODEL,
  agentModel: SONNET_MODEL,
  jev: JEV_API_KEY ? { apiKey: JEV_API_KEY, timeoutMs: 5000 } : null,
  callAnthropic,
});

// ── Fixtures as the pipeline's inputs ───────────────────────────────────────

const TZ: Record<string, { zone: string; offsetMin: number }> = {
  india: { zone: "Asia/Kolkata", offsetMin: 330 },
  us: { zone: "America/New_York", offsetMin: -300 },
  uk: { zone: "Europe/London", offsetMin: 0 },
};

function clockOf(c: FoodBoxCase): { zone: string; localDate: string; localHour: number } {
  const tz = TZ[c.region ?? "india"] ?? TZ.india;
  const at = Date.parse(c.origin.date.length <= 10 ? `${c.origin.date}T12:00:00Z` : c.origin.date);
  const local = new Date((Number.isFinite(at) ? at : Date.now()) + tz.offsetMin * 60_000);
  // `today` reads "Friday 2026-11-06": the date is the part that counts.
  const today = c.today?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return { zone: tz.zone, localDate: today ?? local.toISOString().slice(0, 10), localHour: local.getUTCHours() };
}

function savedMealsOf(c: FoodBoxCase): SavedMealForParse[] {
  return (c.fixtures?.savedMeals ?? []).map((m, i) => ({
    id: `saved-${i}`,
    name: m.name,
    kind: "meal" as const,
    servings: 1,
    serving_label: null,
    kcal: m.kcal,
    protein_g: m.protein_g,
    carb_g: m.carb_g,
    fat_g: m.fat_g,
    items: (m.items?.length ? m.items : [{ name: m.name, kcal: m.kcal, protein_g: m.protein_g, carb_g: m.carb_g, fat_g: m.fat_g, quantity: 1, unit: "serving" } as Line])
      .map((l) => ({
        food_id: null,
        food_name: l.name,
        quantity: l.quantity ?? 1,
        serving_unit: l.unit ?? "serving",
        grams: l.grams ?? null,
        kcal: l.kcal,
        protein_g: l.protein_g ?? null,
        carb_g: l.carb_g ?? null,
        fat_g: l.fat_g ?? null,
        fiber_g: null,
      })),
  }));
}

/** A memory fixture as a user_food_cache row reads (index.ts cachedMemoryEntry). */
function memoryOf(c: FoodBoxCase): MemoryEntry[] {
  return (c.fixtures?.memory ?? []).map((m) => ({
    food_name: m.name,
    food_id: null,
    kcal: m.per100.kcal,
    protein_g: m.per100.protein_g,
    carb_g: m.per100.carb_g,
    fat_g: m.per100.fat_g,
    fiber_g: null,
    grams: 100,
    quantity: 100,
    serving_unit: "g",
    source: m.source,
    logged_via: "ai",
    tier: "super",
    logged_at: `${m.lastLogged}T12:00:00Z`,
    persistent: true,
    confirmed_at: `${m.lastLogged}T12:00:00Z`,
    confirmed_aliases: m.aliases ?? [],
  }));
}

function diaryRows(c: FoodBoxCase, localDate: string, offsetMin: number): MealRowIn[] {
  const base = Date.parse(`${localDate}T13:00:00Z`) - offsetMin * 60_000;
  return (c.fixtures?.diary ?? []).map((d) => ({
    meal_type: d.meal,
    logged_at: new Date(base - d.daysAgo * 86_400_000).toISOString(),
    meal_entries: d.lines.map((l) => ({
      food_name: l.name,
      // meal_entries.source holds catalog | off | web | estimate, or null for
      // a manual pick (0076). A fixture's "label" was a web label.
      source: l.source === "label" ? "web" : ["catalog", "off", "web", "estimate"].includes(l.source ?? "") ? l.source : null,
      food_id: null,
      fiber_g: null,
      quantity: l.quantity ?? 1,
      serving_unit: l.unit ?? "serving",
      grams_logged: l.grams ?? null,
      kcal: l.kcal,
      protein_g: l.protein_g ?? 0,
      carb_g: l.carb_g ?? 0,
      fat_g: l.fat_g ?? 0,
    })),
  }));
}

const SOURCES = new Set(["catalog", "off", "fatsecret", "web", "estimate", "manual"]);
function cardSource(s: string | undefined): CardLine["source"] {
  if (!s) return undefined;
  if (s === "label") return "web";
  if (s === "memory" || s === "user") return "manual";
  return SOURCES.has(s) ? (s as CardLine["source"]) : "estimate";
}

function cardOf(lines: Line[]): CardLine[] {
  return lines.map((l) => ({
    food_name: l.name,
    quantity: l.quantity ?? 1,
    serving_label: l.unit ?? "serving",
    grams: l.grams ?? 0,
    kcal: l.kcal,
    protein_g: l.protein_g ?? 0,
    carb_g: l.carb_g ?? 0,
    fat_g: l.fat_g ?? 0,
    source: cardSource(l.source),
    ...(l.meal ? { meal_type: l.meal } : {}),
  }));
}

const asLine = (i: ParsedItem): Line => ({
  name: i.food_name,
  quantity: i.quantity,
  unit: i.serving_label,
  grams: i.grams,
  kcal: Math.round(i.kcal),
  protein_g: i.protein_g,
  carb_g: i.carb_g,
  fat_g: i.fat_g,
  source: i.source,
  ...(i.meal_type ? { meal: i.meal_type } : {}),
});

// ── The parser's deps: production's wiring, reads only ──────────────────────

async function searchCatalog(query: string): Promise<CandidateFood[]> {
  const { data, error } = await anon.rpc("search_foods_ranked_with_servings", { q: query, lim: 8 });
  if (error) console.error(`  catalog search error: ${error.message}`);
  return ((Array.isArray(data) ? data : []) as Record<string, unknown>[]).map((r) => ({
    food_id: String(r.id),
    name: String(r.name),
    brand: r.brand ? String(r.brand) : null,
    base_unit: r.base_unit === "ml" ? "ml" as const : "g" as const,
    kcal: Number(r.kcal ?? 0),
    protein_g: Number(r.protein_g ?? 0),
    carb_g: Number(r.carb_g ?? 0),
    fat_g: Number(r.fat_g ?? 0),
    fiber_g: r.fiber_g == null ? null : Number(r.fiber_g),
    servings: Array.isArray(r.servings)
      ? (r.servings as Record<string, unknown>[]).flatMap((s) =>
        typeof s?.label === "string" && Number.isFinite(Number(s.grams)) ? [{ label: s.label, grams: Number(s.grams), is_default: !!s.is_default }] : []
      )
      : [],
    source: "catalog" as const,
  }));
}

function parseDeps(c: FoodBoxCase, zone: string): ParseMealDeps {
  const memory = memoryOf(c);
  return {
    anthropicApiKey: API_KEY || "cli",
    model: PARSE_MODEL,
    fetchFn,
    maxTokens: 6500, // PARSE_MEAL_MAX_TOKENS
    timeoutMs: 80_000,
    webSearchEnabled: false,
    searchFoods: searchCatalog,
    // Never write the catalog from an eval.
    backfillOffFood: async () => null,
    // Read only: no preciseCachePut, no preciseAliasPut.
    preciseCacheGet: preciseCacheRead ? async (key: string) => (await preciseCacheRead(key)) as never : undefined,
    ...(WEB ? { webLookup: "tavily" as const, tavily: { apiKey: env("TAVILY_API_KEY"), timeoutMs: 20_000 } } : {}),
    searchRewrite: true,
    jev: JEV_API_KEY ? { apiKey: JEV_API_KEY, timeoutMs: 5000 } : undefined,
    searchCountry: c.region ?? "india",
    resolveSearchCountry: async () => c.region ?? "india",
    userMemory: JEV_API_KEY
      ? {
        load: async () => ({ entries: memory, timeZone: zone }),
        lookupAliases: async (keys: string[]) =>
          memory.filter((m) => (m.confirmed_aliases ?? []).some((a) => keys.includes(a))).map((m) => ({ ...m, alias_lookup: true })),
      }
      : undefined,
    thoroughMatch: match("THOROUGH_MATCH_MODE") !== "off" && JEV_API_KEY
      ? {
        mode: match("THOROUGH_MATCH_MODE") as "shadow" | "on",
        brandWeb: WEB,
        sourcesOf: async (ids: string[]) => {
          const { data } = ids.length ? await anon.from("foods").select("id, source").in("id", ids) : { data: [] };
          return new Map(((data ?? []) as { id: string; source: string }[]).map((r) => [String(r.id), String(r.source)]));
        },
      }
      : undefined,
    skipDecideMode: "shadow",
    getFoodPer100: async (foodId) => {
      const { data } = await anon.from("foods").select("name, base_unit, kcal, protein_g, carb_g, fat_g, fiber_g").eq("id", foodId).maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        name: String(r.name ?? ""), base_unit: String(r.base_unit ?? "g"), kcal: Number(r.kcal ?? 0),
        protein_g: Number(r.protein_g ?? 0), carb_g: Number(r.carb_g ?? 0), fat_g: Number(r.fat_g ?? 0),
        fiber_g: r.fiber_g == null ? null : Number(r.fiber_g),
      };
    },
    getFoodServings: async (foodId) => {
      const { data } = await anon.from("food_servings").select("label, grams, is_default").eq("food_id", foodId).order("seq", { ascending: true });
      return ((data ?? []) as Record<string, unknown>[]).map((s) => ({ label: String(s.label), grams: Number(s.grams), is_default: !!s.is_default }));
    },
    log: () => {},
  };
}

// ── One case ────────────────────────────────────────────────────────────────

const MEAL_OF_HOUR = (h: number): "breakfast" | "lunch" | "snack" | "dinner" => (h < 11 ? "breakfast" : h < 16 ? "lunch" : h < 19 ? "snack" : "dinner");

/** The save card's meal as the user would save it with one tap. */
function savedMealOf(tool: string, input: Record<string, unknown>): SavedMeal {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const name = typeof input.name === "string" ? input.name : "Saved meal";
  if (tool === "create_custom_meal" && Array.isArray(input.items)) {
    const its = input.items as Record<string, unknown>[];
    const sum = (k: string) => Math.round(its.reduce((a, i) => a + n(i[k]), 0) * 10) / 10;
    return { name, kcal: sum("kcal"), protein_g: sum("protein_g"), carb_g: sum("carb_g"), fat_g: sum("fat_g") };
  }
  return { name, kcal: n(input.kcal), protein_g: n(input.protein_g), carb_g: n(input.carb_g), fat_g: n(input.fat_g) };
}

/** FOOD_THREADS=on: the case's thread as the store would hold it. */
async function threadOf(c: FoodBoxCase, card: CardLine[]): Promise<FoodBarThread | null> {
  if (THREADS !== "on") return null;
  const store = memoryThreadStore();
  const id = randomUUID();
  await store.ensure("eval", id);
  for (const e of c.thread.earlierCards ?? []) {
    const kind = /save/i.test(e.label) ? "save" as const : "meal" as const;
    await store.createCard(id, randomUUID(), kind, cardAsLines(cardOf(e.lines)), null, e.lines[0]?.meal ?? null);
  }
  const onScreen = card.length ? randomUUID() : null;
  if (onScreen) await store.createCard(id, onScreen, "meal", cardAsLines(card), null, card[0]?.meal_type ?? null);
  return threadForAgent(store, "eval", { id, card_id: onScreen, base_version: onScreen ? 1 : null, next_card_id: randomUUID(), closed: null });
}

export function runLive(c: FoodBoxCase): Promise<Outcome> {
  const m: Meter = { calls: 0, byModel: {} };
  return meter.run(m, () => runLiveCase(c, m));
}

/** The app's pending_meal for a case with a question still open: the user's
 *  last message before it, and the question. */
function pendingOf(c: FoodBoxCase): PendingFoodMeal | null {
  const q = c.thread.openQuestion;
  if (!q) return null;
  const text = c.thread.turns.filter((t) => t.role === "user").at(-1)?.text ?? "";
  return text.trim() ? { status: "awaiting_clarification", text, question: q.question } : null;
}

async function runLiveCase(c: FoodBoxCase, m: Meter): Promise<Outcome> {
  const { zone, localDate, localHour } = clockOf(c);
  const prevLines = c.thread.card?.length ? c.thread.card : null;
  const card = cardOf(prevLines ?? []);
  // The app sends the card's real line count (previous_items_total), so the
  // case's whole card is the count, as index.ts reads it from today's app.
  const cardTotal = card.length;
  const cardOpen = card.length > 0 && !cardMayBeCut(card, cardTotal);
  const base = readFoodContext(c.thread.turns, pendingOf(c));
  const foodContext: FoodConversationContext = { ...base, card: card.length ? card : null };
  const recentTurns = base.recentTurns;
  const savedMealsP = Promise.resolve(savedMealsOf(c));
  const deps = parseDeps(c, zone);
  const rows = diaryRows(c, localDate, TZ[c.region ?? "india"]?.offsetMin ?? 330);
  const readDiary = async (input: Record<string, unknown>) =>
    listLoggedMeals(input, { timeZone: zone, todayLocal: localDate }, {
      mealsBetween: async (s, e) => ({ rows: rows.filter((r) => String(r.logged_at) >= s && String(r.logged_at) <= e) }),
    });
  // copy_lines' read: the same rows, with each line's id and source (full).
  const readDiaryLines = async (input: Record<string, unknown>) =>
    listLoggedMeals(input, { timeZone: zone, todayLocal: localDate }, {
      mealsBetween: async (s, e) => ({ rows: rows.filter((r) => String(r.logged_at) >= s && String(r.logged_at) <= e) }),
    }, true);
  const userTurns = c.thread.turns.filter((t) => t.role === "user").map((t) => t.text);
  const previousItems: PreviousItem[] = card.map((l) => ({ ...l, food_id: null }));
  const previousText = prevLines ? userTurns.at(-1) ?? null : null;
  const previousWords = prevLines && userTurns.length ? userTurns.join("; ") : null;
  const mealHint = prevLines?.[0]?.meal ?? MEAL_OF_HOUR(localHour);
  const contextPromise = Promise.resolve({ recentFoods: [], todayTotals: null, targets: null });

  const threadP = threadOf(c, card);
  const pendingIn = foodContext.pendingMeal;
  // What the app sends (nutrition.tsx): speed "super" on a first Precise
  // message only, tier "precise" on every message. The server reads both the
  // same way here as in index.ts, and the agent's parses run in the tier the
  // speed asks for (a correction stays on smart).
  const body: { speed?: string; tier: string } = { ...(prevLines ? {} : { speed: "super" }), tier: "precise" };
  // index.ts's rule (FOOD_FIRST_GATE, Precise): a first message asks the gate
  // question in the router's Jev call.
  const firstGate = firstMessageGoesToGate({
    mode: FIRST_GATE, laterMode: LATER, intentMode: INTENT_MODE, precise: isPreciseRequest(body, { superOn: true, freeTier: false }), supportsCreate: true, hasModelKey: true,
    turns: recentTurns.length, cardLines: card.length, pending: !!pendingIn,
  });
  const intentP = startFoodIntent(savedMealsP, c.message, foodContext, undefined, undefined, undefined, undefined, firstGate);
  const agentArgs = {
    intentP, supportsCreate: true, text: c.message, mealHint, localHour, localDate,
    mode: (body.speed === "super" ? "super" : null) as "super" | null,
    savedMealsP, readDiary, readDiaryLines, contextPromise, userId: "eval", recentTurns, pendingMeal: pendingIn,
    card: card.length ? { lines: card, total: cardTotal, previousText, previousWords, previousItems } : null,
    parseDeps: () => deps,
    logUsage: () => {},
    thread: threadP,
  };
  /** Today's parse of the message, as index.ts runs it. */
  const parseNow = async () => {
    const pendingMeal = pendingIn && continuesPendingMeal(await intentP) ? pendingIn : null;
    return runParseMeal(deps, {
      text: c.message,
      localHour,
      mealHint,
      // Precise: the app sends speed 'super' on a first message and keeps a
      // correction on the default tier (nutrition.tsx runParse).
      mode: prevLines ? null : "super",
      recentFoods: [],
      savedMeals: savedMealsP,
      savedHint: intentP.then((d) => d?.savedMatch ?? null, () => null),
      todayTotals: null,
      targets: null,
      contextPromise,
      previousText,
      previousWords,
      previousItems: prevLines ? previousItems : undefined,
      pendingMeal,
      recentTurns,
    });
  };
  // index.ts's rule (FOOD_AGENT_LATER, Precise): a later message goes to the
  // agent whatever the router says.
  // hasModelKey true: this eval measures the agent's answers, so the no-key
  // fallback (today's path) is never exercised here; foodAgentLater.test.ts pins it.
  const later = laterMessageGoesToAgent({
    // The eval account is a Pro account with Precise on.
    mode: LATER, precise: isPreciseRequest(body, { superOn: true, freeTier: false }), supportsCreate: true, hasModelKey: true,
    turns: recentTurns.length, cardLines: card.length, cardOpen, pending: !!pendingIn,
  });
  let outcome: Awaited<ReturnType<typeof resolveFoodBarOutcome>>;
  let firstParse: Awaited<ReturnType<typeof runParseMeal>>;
  let routerAgent: ReturnType<typeof startFoodAgent> | null = null;
  let gate: CaseMetrics["gate"];
  if (later) {
    const l = await runLaterMessage({ agent: agentArgs, cardOpen, fallbackParse: parseNow });
    outcome = l.outcome;
    firstParse = l.firstParse ?? noParseResult();
  } else if (firstGate) {
    const parseP = parseNow();
    const f = await runFirstMessage({ agent: agentArgs, parse: parseP });
    outcome = f.outcome;
    // The parse counts as this message's (its look-ups too) only when it was
    // served: by the gate, or as the fallback for a failed agent. A reused
    // parse is inside the agent's own result already.
    firstParse = f.gate.to === "agent" && outcome.agent && outcome.agent.kind !== "failed" ? noParseResult() : f.firstParse ?? noParseResult();
    gate = f.gate;
    // The running parse still counts against this message when the agent did
    // not use it: it was spent either way.
    await parseP.catch(() => null);
  } else {
    const agentP = (routerAgent = startFoodAgent(agentArgs));
    firstParse = await parseNow();
    outcome = await resolveFoodBarOutcome({
      result: firstParse, intentP, supportsCreate: true, text: c.message, mealHint, readDiary, agentP, recentTurns, cardOpen,
      earlierCards: card.length === 0 && !!(await threadP)?.index,
    });
  }
  // The router's agent can still be working after a log was served: its calls
  // count against this message too.
  if (routerAgent) await routerAgent;
  const metrics = metricsOf(m, later || gate?.to === "agent" ? "agent" : outcome.agent ? "router_agent" : "parse", outcome.agent?.turns.length ?? 0, gate);

  if (env("DEBUG_STEPS") === "1") {
    console.log(`  [${c.id}] action=${outcome.action} planned=${outcome.planned} later=${later}${gate ? ` gate=${gate.plain?.toFixed(2) ?? "null"}->${gate.to} reused=${gate.parseReused}` : ""} intent=${outcome.decision?.intent ?? null}@${outcome.decision?.confidence ?? null} agent=${outcome.agent?.kind ?? null}${outcome.agent?.reason ? `(${outcome.agent.reason})` : ""}`);
    for (const t of outcome.agent?.turns ?? []) {
      console.log(`    turn ${t.turn}: ${JSON.stringify(t.tools).slice(0, 600)}`);
      for (const r of t.results ?? []) console.log(`      ${r.name} -> ${String(r.summary).slice(0, 300)}`);
    }
  }
  // The agent's own parses (a later message) carry their steps in its result.
  const lookedUp = [...(firstParse.steps ?? []), ...(outcome.result?.steps ?? [])]
    .some((s) => /web|lookup_packaged|fatsecret|tavily/i.test(String(s.tool)));
  const withLookup = (a: Action[]): Action[] => (lookedUp && !a.includes("look_up") ? [...a, "look_up"] : a);

  if (outcome.action === "create" && outcome.create) {
    const input = outcome.create.input;
    return {
      card: cardAfter(prevLines, { kind: "create" }),
      reply: typeof input.summary === "string" ? input.summary : null,
      actions: ["save"],
      savedMeal: savedMealOf(outcome.create.tool, input),
      metrics,
    };
  }
  if (outcome.action === "reply") {
    const reply = outcome.reply ?? null;
    // A reply is a spoken answer; one that ends in a question also asks back.
    return { card: cardAfter(prevLines, { kind: "declined" }), reply, actions: reply && /\?\s*$/.test(reply) ? ["answer", "ask"] : ["answer"], metrics };
  }
  const result = outcome.result ?? firstParse;
  if (!result.parsed || result.parsed.items.length === 0) {
    const cleared = !!result.declined?.cleared;
    const msg = result.declined?.message ?? null;
    return {
      card: cardAfter(prevLines, { kind: "declined", cleared }),
      reply: msg,
      actions: cleared ? ["edit"] : withLookup(msg && /\?\s*$/.test(msg) ? ["answer", "ask"] : ["answer"]),
      metrics,
    };
  }
  const items = result.parsed.items.map(asLine);
  const did: Action[] = result.tool_calls.includes("restore_card") ? ["restore"] : withLookup([prevLines ? "edit" : "log"]);
  // A reply that rode along with the change (the agent answered AND acted).
  const line = result.parsed.drona_line || null;
  if (outcome.answered && !did.includes("answer")) did.push("answer");
  if (outcome.answered && line && /\?\s*$/.test(line) && !did.includes("ask")) did.push("ask");
  return {
    card: cardAfter(prevLines, { kind: "meal", items, correctsPrevious: !!result.parsed.corrects_previous }),
    reply: line,
    actions: did,
    metrics,
  };
}
