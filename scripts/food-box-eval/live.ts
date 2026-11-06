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
//   - The web label lookup is off unless EVAL_WEB=1 (Tavily, spends credits).
//     Production uses Anthropic's server web search, which the CLI cannot run.
//   - FOOD_THREADS (off by default, as live) decides whether the thread store
//     is in play. With FOOD_THREADS=on the case's `thread.earlierCards` and its
//     card on screen are loaded into an in-memory store (foodThreads.ts
//     memoryThreadStore, the same rules as the tables), and the agent gets the
//     index line and restore_card. Off: earlier cards are not sent, as today.
//   - The secrets the live function reads are not visible here. Defaults:
//     FOOD_INTENT_MODE=on, THOROUGH_MATCH_MODE / PRECISE_MATCH_MODE off.
//     Each can be set in the environment to match a deploy.

import "../parse-meal-eval/denoShim";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { makeClaudeCliFetch } from "../parse-meal-eval/claude-cli-fetch";
import {
  type AnthropicCallResult,
  configureFoodBar,
  resolveFoodBarOutcome,
  startFoodAgent,
  startFoodIntent,
} from "../../supabase/functions/ai-coach/foodBar";
import type { CardLine, FoodConversationContext } from "../../supabase/functions/ai-coach/foodContext";
import { cardMayBeCut, readFoodContext } from "../../supabase/functions/ai-coach/foodContext";
import { parseFoodIntentMode } from "../../supabase/functions/ai-coach/foodIntent";
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
import type { Action, FoodBoxCase, Line, Outcome, SavedMeal } from "./types";

// ── Env ─────────────────────────────────────────────────────────────────────

function dotEnv(): Record<string, string> {
  // The worktree, then the main checkout (a worktree has no .env.local).
  // EVAL_ENV_FILE names another file; the main checkout's is the last resort.
  const paths = [process.env.EVAL_ENV_FILE, ".env.local", `${process.env.HOME}/Coding/overload-v3/.env.local`].filter((p): p is string => !!p);
  for (const path of paths) {
    try {
      const out: Record<string, string> = {};
      for (const line of readFileSync(path, "utf8").split("\n")) {
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
const match = (k: string): "off" | "shadow" | "on" => (["shadow", "on"] as const).find((m) => m === env(k)) ?? "off";

const SUPABASE_URL = env("EXPO_PUBLIC_SUPABASE_URL");
const ANON = env("EXPO_PUBLIC_SUPABASE_ANON_KEY");
// The shared label cache is revoked from anon (0109): its read needs the
// service role. Read only; the eval never writes it.
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");

/** The adapter's name, and its BASELINE.md section: the thread store changes
 *  what is measured, so a run with it on keeps its own section. */
export function liveName(): string {
  return THREADS === "on" ? "live_threads" : "live";
}

export function liveReady(): string | null {
  if (!SUPABASE_URL || !ANON) return "Missing EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY (env or .env.local).";
  if (!VIA_CLI && !API_KEY) return "Set EVAL_VIA_CLI=1 (owner rule), or ANTHROPIC_API_KEY for a latency run.";
  return null;
}

const anon = createClient(SUPABASE_URL || "http://x", ANON || "x", { auth: { persistSession: false, autoRefreshToken: false } });
const service = SERVICE ? createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

// Each body names its own model (Haiku for the parse and the router, Sonnet
// for the agent), so the CLI runs each on that one.
// A CLI process that died is the harness, not the pipeline: one retry, so a
// flaky spawn does not score as a failed case. Never on the API path.
const rawCliFetch = VIA_CLI ? makeClaudeCliFetch(PARSE_MODEL, { modelFromBody: true, freeChoice: true }) : null;
const cliFetch: typeof fetch | null = rawCliFetch
  ? (async (url, init) => {
    const r = await rawCliFetch(url as never, init);
    return r.status === 502 ? rawCliFetch(url as never, init) : r;
  }) as typeof fetch
  : null;
const fetchFn: typeof fetch = cliFetch ?? fetch;

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
    ...(cliFetch ? { fetchFn: cliFetch } : {}),
    maxTokens: 6500, // PARSE_MEAL_MAX_TOKENS
    timeoutMs: 80_000,
    webSearchEnabled: false,
    searchFoods: searchCatalog,
    // Never write the catalog from an eval.
    backfillOffFood: async () => null,
    // Read only: no preciseCachePut, no preciseAliasPut.
    preciseCacheGet: service
      ? async (key: string) => {
        const { data } = await service.rpc("precise_cache_get", { p_key: key }).maybeSingle();
        return (data ?? null) as never;
      }
      : undefined,
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

export async function runLive(c: FoodBoxCase): Promise<Outcome> {
  const { zone, localDate, localHour } = clockOf(c);
  const prevLines = c.thread.card?.length ? c.thread.card : null;
  const card = cardOf(prevLines ?? []);
  const cardOpen = card.length > 0 && !cardMayBeCut(card);
  const base = readFoodContext(c.thread.turns, null);
  const foodContext: FoodConversationContext = { ...base, card: card.length ? card : null };
  const recentTurns = base.recentTurns;
  const savedMealsP = Promise.resolve(savedMealsOf(c));
  const deps = parseDeps(c, zone);
  const rows = diaryRows(c, localDate, TZ[c.region ?? "india"]?.offsetMin ?? 330);
  const readDiary = async (input: Record<string, unknown>) =>
    listLoggedMeals(input, { timeZone: zone, todayLocal: localDate }, {
      mealsBetween: async (s, e) => ({ rows: rows.filter((r) => String(r.logged_at) >= s && String(r.logged_at) <= e) }),
    });
  const userTurns = c.thread.turns.filter((t) => t.role === "user").map((t) => t.text);
  const previousItems: PreviousItem[] = card.map((l) => ({ ...l, food_id: null }));
  const previousText = prevLines ? userTurns.at(-1) ?? null : null;
  const previousWords = prevLines && userTurns.length ? userTurns.join("; ") : null;
  const mealHint = prevLines?.[0]?.meal ?? MEAL_OF_HOUR(localHour);
  const contextPromise = Promise.resolve({ recentFoods: [], todayTotals: null, targets: null });

  const threadP = threadOf(c, card);
  const intentP = startFoodIntent(savedMealsP, c.message, foodContext);
  const agentP = startFoodAgent({
    intentP, supportsCreate: true, text: c.message, mealHint, localHour, localDate, mode: "super",
    savedMealsP, readDiary, contextPromise, userId: "eval", recentTurns, pendingMeal: null,
    card: card.length ? { lines: card, previousText, previousWords, previousItems } : null,
    parseDeps: () => deps,
    logUsage: () => {},
    thread: threadP,
  });
  const firstParse = await runParseMeal(deps, {
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
    pendingMeal: null,
    recentTurns,
  });
  const outcome = await resolveFoodBarOutcome({
    result: firstParse, intentP, supportsCreate: true, text: c.message, mealHint, readDiary, agentP, recentTurns, cardOpen,
    earlierCards: card.length === 0 && !!(await threadP)?.index,
  });

  if (env("DEBUG_STEPS") === "1") {
    console.log(`  [${c.id}] action=${outcome.action} planned=${outcome.planned} intent=${outcome.decision?.intent ?? null}@${outcome.decision?.confidence ?? null}`);
    for (const t of outcome.agent?.turns ?? []) console.log(`    turn ${t.turn}: ${JSON.stringify(t.tools).slice(0, 600)}`);
  }
  const lookedUp = (firstParse.steps ?? []).some((s) => /web|lookup_packaged|fatsecret|tavily/i.test(String(s.tool)));
  const withLookup = (a: Action[]): Action[] => (lookedUp && !a.includes("look_up") ? [...a, "look_up"] : a);

  if (outcome.action === "create" && outcome.create) {
    const input = outcome.create.input;
    return {
      card: cardAfter(prevLines, { kind: "create" }),
      reply: typeof input.summary === "string" ? input.summary : null,
      actions: ["save"],
      savedMeal: savedMealOf(outcome.create.tool, input),
    };
  }
  if (outcome.action === "reply") {
    const reply = outcome.reply ?? null;
    return { card: cardAfter(prevLines, { kind: "declined" }), reply, actions: [reply && /\?\s*$/.test(reply) ? "ask" : "answer"] };
  }
  const result = outcome.result ?? firstParse;
  if (!result.parsed || result.parsed.items.length === 0) {
    const cleared = !!result.declined?.cleared;
    const msg = result.declined?.message ?? null;
    return {
      card: cardAfter(prevLines, { kind: "declined", cleared }),
      reply: msg,
      actions: cleared ? ["edit"] : withLookup([msg && /\?\s*$/.test(msg) ? "ask" : "answer"]),
    };
  }
  const items = result.parsed.items.map(asLine);
  return {
    card: cardAfter(prevLines, { kind: "meal", items, correctsPrevious: !!result.parsed.corrects_previous }),
    reply: result.parsed.drona_line || null,
    actions: result.tool_calls.includes("restore_card") ? ["restore"] : withLookup([prevLines ? "edit" : "log"]),
  };
}
