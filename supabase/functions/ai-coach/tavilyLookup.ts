// Precise's web lookup on Tavily + Jev (PRECISE_WEB_PROVIDER=tavily).
//
// The Anthropic server-tool lookup (runSuperLookup in parseMeal.ts) pastes every
// search result into Haiku and bills us to read all of it: about 39k input
// tokens per Precise log. This path splits the same job into four parts, each
// done by the cheapest thing that can do it well:
//
//   1. FIND    Tavily search, India-boosted, label sites preferred.  1 credit.
//   2. JUDGE   Jev: is each result about EXACTLY this food?         ~free.
//   3. CUT     code: pull the nutrition panel out of each page.     free.
//   4. READ    one Haiku call copies the numbers off those panels.  ~1-2k tokens.
//
// Then code does the arithmetic (per serving -> per 100 g) and the physics
// checks, because neither model is trusted with numbers: Jev "is not a
// calculator", and per-serving read as per-100 g is the classic 3-5x error.
//
// ONE GOOD SOURCE IS ENOUGH (owner decision 2026-09-26). A single relevant page
// with a full panel answers; two agreeing pages earn the verified badge further
// down (meetsVerificationBar), they are not required here.
//
// Runtime-agnostic, no parseMeal import: parseMeal imports THIS file, and the
// one thing we need from it (a forced tool call to the parse model) is injected
// as callModel.

import { type TavilyDeps, tavilyExtract, type TavilyResult, tavilySearch } from "./tavily.ts";
import { asChoice, askJev, asNoul, type JevDeps, type JevQuestion } from "./jev.ts";
import type { ReadingPer100, SourceReading } from "./preciseCache.ts";

export interface WebFoodItem {
  name: string;
  brand: string | null;
}

/** Same shape as parseMeal's SuperFinding, restated so this file stays
 *  import-free of parseMeal. */
export interface WebFinding {
  readings: SourceReading[];
  serving_label: string | null;
  serving_grams: number | null;
  source_note: string | null;
}

export interface TavilyLookupDeps {
  tavily: TavilyDeps;
  /** Absent or failing: relevance falls back to Tavily's own ranking plus the
   *  reader's same_food check. Worse, never broken. */
  jev?: JevDeps | null;
  /** Tavily country boost, e.g. "india". null sends none. */
  country: string | null;
  /** One forced tool call to the parse model. Returns the raw response body,
   *  or null on failure. The caller counts the tokens. */
  callModel(payload: Record<string, unknown>): Promise<any | null>;
  model: string;
  log?: (msg: string) => void;
}

export interface LookupStep {
  tool: string;
  input: unknown;
  result: unknown;
}

export interface TavilyLookupOutcome {
  finding: WebFinding | null;
  /** Tavily credits spent (search + extract), for cost logging. */
  credits: number;
  steps: LookupStep[];
  /** True when a Tavily search failed (no key, auth, out of credits, down), on
   *  either attempt. The caller then runs the old lookup, so Precise keeps
   *  working. */
  unavailable: boolean;
}

// ── Tuning ──────────────────────────────────────────────────────────────────

/** Jev's yes on "is this page about exactly this food" must reach this. A
 *  starting point, to be tuned on the probe: every wrong Jev answer seen so far
 *  sat at or below 0.49, so 0.6 leaves a margin without starving the reader. */
export const RELEVANCE_FLOOR = 0.6;
/** Jev's first look keeps a page at or above this, and a kept page is judged
 *  again with its own words (the second look is the one that counts). Below it
 *  a page is dropped without spending an extract on it. */
export const UNSURE_FLOOR = 0.35;
/** Jev's "which piece is the panel" must reach this to be taken alone; below
 *  it the reader gets the top two pieces and picks by product name. */
export const PIECE_FLOOR = 0.6;
/** The option Jev picks when no piece is this food's panel. */
export const NO_PIECE = "none";
/** Pieces per page shown to Jev, and their size. Overlap (CHARS - STEP) keeps a
 *  panel that straddles a cut whole in at least one piece. */
export const MAX_PIECES = 6;
// Sized on real pages: grocery and database panels arrive as markdown tables,
// where one row can run 80+ characters, and 700 cut protein off FatSecret's.
export const PIECE_CHARS = 1000;
export const PIECE_STEP = 600;
/** Characters of a page's opening shown to Jev (product name, pack size). */
export const HEADING_CHARS = 300;
/** Pages the reader sees at most. Five panels are ~2k tokens. */
export const MAX_PAGES_READ = 5;
/** Results Jev judges per search. */
export const MAX_RESULTS = 8;
/** Two searches at most: the second only when the first found no panel. */
export const MAX_SEARCHES = 2;
/** Characters of panel text kept per page. A full Indian label panel with
 *  per-100 g and per-serving columns fits in well under this. */
export const PANEL_CHARS = 1600;

/** Where printed Indian labels actually live: grocery listings copy the pack's
 *  panel, and the databases carry the generic foods. "prefer", never
 *  "restrict", so a brand's own site still surfaces. The model never writes
 *  this list; it is ours. */
export const LABEL_SITES_INDIA = [
  "bigbasket.com",
  "blinkit.com",
  "zeptonow.com",
  "swiggy.com",
  "jiomart.com",
  "amazon.in",
  "flipkart.com",
];
export const NUTRITION_DATABASES = [
  "openfoodfacts.org",
  "fatsecret.co.in",
  "healthifyme.com",
  "nutritionix.com",
  "fdc.nal.usda.gov",
];

export function preferDomainsFor(country: string | null): string[] {
  return country?.toLowerCase() === "india"
    ? [...LABEL_SITES_INDIA, ...NUTRITION_DATABASES]
    : [...NUTRITION_DATABASES];
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** "Amul" + "Amul masti dahi" must not become "Amul Amul masti dahi": the
 *  same doubling the catalog ladder guards against. */
export function foodLabel(item: WebFoodItem): string {
  const name = item.name.trim();
  const brand = item.brand?.trim() ?? "";
  if (!brand || name.toLowerCase().includes(brand.toLowerCase())) return name;
  return `${brand} ${name}`;
}

export function searchQueries(item: WebFoodItem): string[] {
  const label = foodLabel(item);
  return [
    `${label} nutrition facts per 100g`,
    `${label} calories protein carbohydrate fat`,
  ].slice(0, MAX_SEARCHES);
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Same classification parseMeal's providerFromRef makes, restated here. A
 *  FatSecret page a search found is a public page and counts by its host
 *  (owner decision 2026-09-05); every Open Food Facts page is one source. */
export function providerFor(url: string): SourceReading["source"] {
  const host = hostOf(url);
  if (/(^|\.)fatsecret\.[a-z.]+$/.test(host)) return "fatsecret";
  if (host === "openfoodfacts.org" || host.endsWith(".openfoodfacts.org")) return "off";
  return "web";
}

// English plus the Hindi words Indian packs print beside them. The Hindi
// alternatives carry no \b: JavaScript's word boundary only knows ASCII letters,
// so \bप्रोटीन\b never matches.
const PANEL_WORDS: Array<[string, RegExp]> = [
  ["energy", /\b(energy|calories|calorie|kcal|cals?|kj|kilojoules?)\b|ऊर्जा|कैलोरी/gi],
  ["protein", /\bproteins?\b|प्रोटीन/gi],
  ["carb", /\bcarbohydrates?\b|\bcarbs?\b|कार्बोहाइड्रेट/gi],
  ["fat", /\b(total\s+)?fats?\b|वसा/gi],
];

/**
 * The part of a page that holds its nutrition panel, or null when there is
 * none. Scores every window of PANEL_CHARS by how many DIFFERENT panel words it
 * holds (energy, protein, carbohydrate, fat), then by how many hits, and keeps
 * the best. A window needs energy plus two macros to count: a page that only
 * mentions "high protein" in its marketing copy is not a panel.
 */
export function findPanelText(text: string | null | undefined, maxChars = PANEL_CHARS): string | null {
  if (!text) return null;
  const t = text.length > 200_000 ? text.slice(0, 200_000) : text;
  const hits: Array<{ at: number; kind: string }> = [];
  for (const [kind, re] of PANEL_WORDS) {
    for (const m of t.matchAll(re)) hits.push({ at: m.index ?? 0, kind });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at);

  let best: { start: number; kinds: number; count: number } | null = null;
  let j = 0;
  for (let i = 0; i < hits.length; i++) {
    const start = Math.max(0, hits[i].at - 80);
    while (j < hits.length && hits[j].at < start + maxChars) j++;
    const window = hits.slice(i, j);
    const kinds = new Set(window.map((h) => h.kind));
    const score = { start, kinds: kinds.size, count: window.length };
    const hasEnergy = kinds.has("energy");
    if (!hasEnergy || kinds.size < 3) continue;
    if (!best || score.kinds > best.kinds || (score.kinds === best.kinds && score.count > best.count)) {
      best = score;
    }
  }
  if (!best) return null;
  return t.slice(best.start, best.start + maxChars).replace(/\s+/g, " ").trim();
}

/** One Jev yes/no per result, all in one request. */
export function relevanceQuestions(item: WebFoodItem, ids: string[]): Record<string, JevQuestion> {
  const branded = !!item.brand?.trim();
  const rule = branded
    ? "Same brand, same product and same variant (flavour, fat level, sugar-free, size when it changes the numbers)."
    : "The same food in the same preparation state (raw is not cooked, fried is not boiled).";
  const out: Record<string, JevQuestion> = {};
  for (const id of ids) {
    out[id] = {
      type: "noul",
      instructions:
        `Is search result ${id} a page about exactly the food in "food"? ${rule} ` +
        "A different brand, a different variant, a recipe that uses this food as an ingredient, " +
        "a list or comparison of many foods, or a general article is NOT exactly this food.",
      criteria: {
        true: "The page is about exactly this food.",
        false: "The page is about a different food, a different variant, or many foods.",
      },
    };
  }
  return out;
}

/** What the reader reports for one page. */
export interface PageReport {
  page_id: string;
  same_food: boolean;
  basis: "per_100g" | "per_100ml" | "per_serving" | "none";
  serving_grams: number | null;
  serving_label: string | null;
  kcal: number | null;
  /** Energy in kJ as printed, for labels that print no kcal. */
  energy_kj: number | null;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A reader's page report -> a per-100 reading, or null. The conversion from a
 * serving is done HERE, in code, from the grams the page printed; the reader
 * only copies numbers. Physics last: no food carries more than ~900 kcal or
 * more than 100 g of macros per 100 g, so anything past that is a misread
 * panel (usually per-pack numbers taken as per 100 g).
 */
export function readingFromReport(r: PageReport, url: string): SourceReading | null {
  if (!r.same_food || r.basis === "none") return null;
  // kJ-only labels (common outside India) are converted here, never by the
  // reader: 1 kcal = 4.184 kJ.
  const kj = num(r.energy_kj);
  const kcal = num(r.kcal) ?? (kj === null ? null : kj / 4.184);
  if (kcal === null) return null;
  let factor = 1;
  if (r.basis === "per_serving") {
    const g = num(r.serving_grams);
    if (g === null || g <= 0 || g > 2000) return null;
    factor = 100 / g;
  }
  const scale = (v: number | null) => (v === null ? null : round1(v * factor));
  const per_100: ReadingPer100 = {
    kcal: round1(kcal * factor),
    protein_g: scale(num(r.protein_g)),
    carb_g: scale(num(r.carb_g)),
    fat_g: scale(num(r.fat_g)),
    fiber_g: scale(num(r.fiber_g)),
  };
  if (per_100.kcal > 950) return null;
  const macroSum = (per_100.protein_g ?? 0) + (per_100.carb_g ?? 0) + (per_100.fat_g ?? 0);
  if (macroSum > 105) return null;
  return { source: providerFor(url), ref: url.slice(0, 500), via: "web_search", per_100 };
}

function parsePageReports(input: unknown): PageReport[] {
  const pages = (input as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) return [];
  const bases = new Set(["per_100g", "per_100ml", "per_serving", "none"]);
  const out: PageReport[] = [];
  for (const p of pages) {
    const o = p as Record<string, unknown>;
    if (typeof o?.page_id !== "string") continue;
    out.push({
      page_id: o.page_id,
      same_food: o.same_food === true,
      basis: bases.has(o.basis as string) ? (o.basis as PageReport["basis"]) : "none",
      serving_grams: num(o.serving_grams),
      serving_label: typeof o.serving_label === "string" && o.serving_label.trim()
        ? o.serving_label.trim().slice(0, 60)
        : null,
      kcal: num(o.kcal),
      energy_kj: num(o.energy_kj),
      protein_g: num(o.protein_g),
      carb_g: num(o.carb_g),
      fat_g: num(o.fat_g),
      fiber_g: num(o.fiber_g),
    });
  }
  return out;
}

// ── The reader ──────────────────────────────────────────────────────────────

const READ_TOOL = {
  name: "report_page_panels",
  description: "Report the nutrition panel printed on each page, once, for every page given.",
  input_schema: {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page_id: { type: "string", description: "The page_id exactly as given." },
            same_food: {
              type: "boolean",
              description: "True only if this page is about exactly the food asked for: same brand and " +
                "variant when a brand is given, same food and preparation otherwise.",
            },
            basis: {
              type: "string",
              enum: ["per_100g", "per_100ml", "per_serving", "none"],
              description: "What the numbers you report are per. Prefer per 100 g / 100 ml when the page " +
                "prints it. none when the text holds no panel for this food.",
            },
            serving_grams: {
              type: ["number", "null"],
              description: "Grams (or ml) in one serving, as printed. Required when basis is per_serving.",
            },
            serving_label: { type: ["string", "null"], description: 'The printed serving, e.g. "1 cup (200 g)".' },
            kcal: { type: ["number", "null"] },
            energy_kj: { type: ["number", "null"], description: "Energy in kJ, only when printed." },
            protein_g: { type: ["number", "null"] },
            carb_g: { type: ["number", "null"] },
            fat_g: { type: ["number", "null"] },
            fiber_g: { type: ["number", "null"] },
          },
          required: ["page_id", "same_food", "basis"],
        },
      },
    },
    required: ["pages"],
  },
};

const READ_SYSTEM =
  "You copy nutrition panels off web pages for a fitness app. For each page, report the numbers " +
  "EXACTLY as printed, on the basis they are printed on. Do not convert, do not calculate, do not " +
  "average and do not guess: the app does the arithmetic. If a page prints both per 100 g and per " +
  "serving, report per 100 g. If it prints only per serving, report per_serving with the serving " +
  "grams. Use null for any value the page does not print; 0 means the page printed zero. Energy in " +
  "kcal goes in kcal and energy in kJ goes in energy_kj, each only if printed. Read only the column " +
  "for THIS food: ignore columns that compare it to other foods or a category average, and % daily " +
  "value or %RDA columns. A text may hold two parts separated by ---; use the part for this food. " +
  "Set same_food false for a page about a different brand, variant or food.";

// ── Orchestration ───────────────────────────────────────────────────────────

/** A search result plus what we can see of the page, for Jev to judge. */
interface Candidate {
  r: TavilyResult;
  /** True once we hold the page's full text (from search or Extract). Pieces
   *  cut from the search snippet alone are too thin to trust: measured on Amul
   *  Lassi, myfooddata's snippet carried macros as percentages, its page as grams. */
  full: boolean;
  /** The page's opening words (product name, pack size) when we have its text. */
  heading: string | null;
  /** Pieces of the page that mention nutrition words, in page order. */
  pieces: string[];
  /** Jev's first-look relevance, from title and snippet. */
  p: number | null;
}

function pageHeading(text: string | null | undefined): string | null {
  const t = text?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, HEADING_CHARS) : null;
}

const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

/**
 * Cut a page into overlapping pieces and keep the ones that mention nutrition
 * words, best first by how many DIFFERENT words they hold, at most `max`, then
 * returned in page order. The code only throws away pieces that cannot hold a
 * panel (menus, delivery, reviews with no numbers); deciding which kept piece is
 * THIS food's panel is Jev's job, because a "similar products" box scores just
 * as well on words as the real panel does.
 */
export function pagePieces(text: string | null | undefined, max = MAX_PIECES): string[] {
  const t = text?.replace(/\s+/g, " ").trim().slice(0, 200_000) ?? "";
  if (!t) return [];
  const scoreOf = (piece: string) => {
    let kinds = 0;
    let hits = 0;
    for (const [, re] of PANEL_WORDS) {
      const n = [...piece.matchAll(re)].length;
      if (n > 0) kinds++;
      hits += n;
    }
    return { kinds, hits };
  };
  const windows: Array<{ start: number; text: string; kinds: number; hits: number }> = [];
  for (let start = 0; start < t.length; start += PIECE_STEP) {
    const text = t.slice(start, start + PIECE_CHARS);
    const { kinds, hits } = scoreOf(text);
    if (kinds > 0) windows.push({ start, text, kinds, hits });
    if (start + PIECE_CHARS >= t.length) break;
  }
  windows.sort((a, b) => b.kinds - a.kinds || b.hits - a.hits || a.start - b.start);
  const picked: typeof windows = [];
  for (const w of windows) {
    if (picked.length >= max) break;
    // Overlapping windows are the same stretch of page: keep the better one.
    if (picked.some((q) => Math.abs(q.start - w.start) < PIECE_CHARS / 2)) continue;
    picked.push(w);
  }
  return picked.sort((a, b) => a.start - b.start).map((w) => w.text);
}

/** Jev's first look: every result, on its title, site, snippet and opening. */
async function askFirstLook(
  jev: JevDeps,
  item: WebFoodItem,
  cands: Candidate[],
): Promise<{ model: string; p: Array<number | null> } | null> {
  const ids = cands.map((_, i) => `r${i + 1}`);
  const state = {
    food: { name: item.name, brand: item.brand },
    results: cands.map((c, i) => ({
      id: ids[i],
      title: c.r.title,
      site: hostOf(c.r.url),
      excerpt: c.r.content.slice(0, 600),
      ...(c.heading ? { page_start: c.heading } : {}),
    })),
  };
  const res = await askJev(state, relevanceQuestions(item, ids), jev).catch(() => null);
  if (!res || !res.ok) return null;
  return { model: res.response.model, p: ids.map((id) => asNoul(res.response.answers[id])) };
}

/** One "which piece" choice per page. Option keys are p1..pN and none. */
export function pieceQuestions(ids: string[], pieceCounts: number[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  ids.forEach((id, i) => {
    const criteria: Record<string, string> = {};
    for (let k = 1; k <= pieceCounts[i]; k++) criteria[`p${k}`] = `Piece p${k} of result ${id}.`;
    criteria[NO_PIECE] = "No piece holds the nutrition numbers for exactly this food.";
    out[`${id}_piece`] = {
      type: "choice",
      instructions:
        `Which piece of result ${id} holds the nutrition numbers (calories, protein, carbohydrate, fat) ` +
        'for exactly the food in "food"? A piece about a different product or variant, a "similar ' +
        'products" or "you may also like" box, or a recipe is not it. Answer none when no piece is.',
      criteria,
    };
  });
  return out;
}

/** Jev's second look: the pages that survived, with their pieces in view.
 *  Asks relevance again (now with the page's own words) and which piece is the
 *  panel, in one request. */
async function askSecondLook(
  jev: JevDeps,
  item: WebFoodItem,
  cands: Candidate[],
): Promise<Array<{ p: number | null; piece: string | null; pieceConf: number; probs: Record<string, number> }> | null> {
  const ids = cands.map((_, i) => `r${i + 1}`);
  const state = {
    food: { name: item.name, brand: item.brand },
    results: cands.map((c, i) => ({
      id: ids[i],
      title: c.r.title,
      site: hostOf(c.r.url),
      ...(c.heading ? { page_start: c.heading } : {}),
      pieces: c.pieces.map((text, k) => ({ id: `p${k + 1}`, text })),
    })),
  };
  const questions = { ...relevanceQuestions(item, ids), ...pieceQuestions(ids, cands.map((c) => c.pieces.length)) };
  const res = await askJev(state, questions, jev).catch(() => null);
  if (!res || !res.ok) return null;
  return ids.map((id) => {
    const ch = asChoice(res.response.answers[`${id}_piece`]);
    return {
      p: asNoul(res.response.answers[id]),
      piece: ch?.choice ?? null,
      pieceConf: ch?.confidence ?? 0,
      probs: ch?.probabilities ?? {},
    };
  });
}

/** The text Haiku reads for one page, from Jev's piece choice. Sure: the one
 *  piece. Unsure: the two it rated highest, so Haiku can pick by product name.
 *  A confident none, or no pieces: nothing. */
export function textForReader(
  pieces: string[],
  choice: { piece: string | null; pieceConf: number; probs: Record<string, number> },
): string | null {
  if (pieces.length === 0) return null;
  const byKey = (k: string) => pieces[Number(k.slice(1)) - 1];
  if (choice.piece === NO_PIECE && choice.pieceConf >= PIECE_FLOOR) return null;
  if (choice.piece && choice.piece !== NO_PIECE && choice.pieceConf >= PIECE_FLOOR) {
    return byKey(choice.piece) ?? null;
  }
  const top = Object.entries(choice.probs)
    .filter(([k]) => k !== NO_PIECE && byKey(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => byKey(k));
  if (top.length === 0) return null;
  return top.join("\n---\n");
}

/**
 * Pick what Haiku reads: pages about exactly this food, and on each the piece
 * that is its panel.
 *
 * 1. Jev's FIRST LOOK judges every result on its title, snippet and opening.
 *    Below UNSURE_FLOOR a page is dropped, with no extract spent on it.
 * 2. The code builds each surviving page's pieces, from Tavily's page text, or
 *    from an Extract when the search returned no usable text (amul.com).
 * 3. Jev's SECOND LOOK sees those pieces and answers, per page, "exactly this
 *    food?" again and "which piece is its panel?". This is the answer that
 *    counts: a title can say Masti Dahi on a page whose panel is for another
 *    product, and the pieces are where that shows.
 *
 * Without Jev (no key, or it failed) this falls back to Tavily's ranking and
 * the best-scoring window per page, and the reader's same_food check is the
 * only relevance gate left.
 */
async function selectPages(
  deps: TavilyLookupDeps,
  item: WebFoodItem,
  results: TavilyResult[],
  steps: LookupStep[],
): Promise<{ pages: Array<{ r: TavilyResult; panel: string }>; credits: number }> {
  let credits = 0;
  const cands: Candidate[] = [...results]
    .sort((a, b) => b.score - a.score)
    .map((r) => ({
      r,
      full: !!r.raw_content,
      heading: pageHeading(r.raw_content),
      // The page text first; the search snippet when the page text had none.
      pieces: pagePieces(r.raw_content).length ? pagePieces(r.raw_content) : pagePieces(r.content),
      p: null,
    }));

  const fillBlind = async (list: Candidate[]) => {
    // Every kept page without its full text, not only those with no pieces at
    // all: a snippet can hold nutrition words and still not hold the panel.
    const blind = list.filter((c) => !c.full).slice(0, 5);
    if (blind.length === 0) return;
    const ex = await tavilyExtract(blind.map((c) => c.r.url), deps.tavily);
    credits += ex.credits;
    if (ex.ok) {
      for (const page of ex.pages) {
        const c = blind.find((x) => x.r.url === page.url);
        if (!c) continue;
        const pieces = pagePieces(page.raw_content);
        c.full = true;
        c.heading = pageHeading(page.raw_content) ?? c.heading;
        // Keep the snippet's pieces if the page text had none (a JS-only page).
        if (pieces.length) c.pieces = pieces;
      }
    }
    steps.push({
      tool: "tavily_extract",
      input: { urls: blind.length },
      result: ex.ok ? { pages: ex.pages.length } : { failure: ex.failure },
    });
  };
  const fallback = async (why: string, from: Candidate[]) => {
    const top = from.slice(0, MAX_PAGES_READ);
    steps.push({ tool: "web_relevance", input: { mode: "fallback", why }, result: { kept: top.length } });
    await fillBlind(top);
    const pages = top
      .map((c) => ({ r: c.r, panel: findPanelText(c.pieces.join(" ")) }))
      .filter((x): x is { r: TavilyResult; panel: string } => !!x.panel);
    return { pages, credits };
  };

  const jev = deps.jev;
  if (!jev) return fallback("no_jev", cands);
  const first = await askFirstLook(jev, item, cands);
  if (!first) return fallback("jev_failed", cands);
  cands.forEach((c, i) => { c.p = first.p[i]; });
  steps.push({
    tool: "web_relevance",
    input: { mode: "jev", look: 1, model: first.model, keep_from: UNSURE_FLOOR },
    result: cands.map((c) => ({ site: hostOf(c.r.url), p: round2(c.p) })),
  });

  const kept = cands
    .filter((c) => (c.p ?? 0) >= UNSURE_FLOOR)
    .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
    .slice(0, MAX_PAGES_READ);
  if (kept.length === 0) return { pages: [], credits };
  await fillBlind(kept);
  const withPieces = kept.filter((c) => c.pieces.length > 0);
  if (withPieces.length === 0) return { pages: [], credits };

  const second = await askSecondLook(jev, item, withPieces);
  if (!second) {
    // Jev answered once and then failed: trust its first look for relevance,
    // and let the best-scoring window stand in for the piece choice.
    const pages = withPieces
      .filter((c) => (c.p ?? 0) >= RELEVANCE_FLOOR)
      .map((c) => ({ r: c.r, panel: findPanelText(c.pieces.join(" ")) }))
      .filter((x): x is { r: TavilyResult; panel: string } => !!x.panel);
    steps.push({ tool: "web_relevance", input: { mode: "jev", look: 2 }, result: { failure: "jev_failed", kept: pages.length } });
    return { pages, credits };
  }

  const pages: Array<{ r: TavilyResult; panel: string; p: number }> = [];
  const trace: unknown[] = [];
  withPieces.forEach((c, i) => {
    const a = second[i];
    const text = (a.p ?? 0) >= RELEVANCE_FLOOR ? textForReader(c.pieces, a) : null;
    if (text) pages.push({ r: c.r, panel: text, p: a.p ?? 0 });
    trace.push({
      site: hostOf(c.r.url),
      p: round2(a.p),
      piece: a.piece,
      piece_conf: round2(a.pieceConf),
      pieces: c.pieces.length,
      used: text ? text.slice(0, 300) : null,
    });
  });
  steps.push({
    tool: "web_relevance",
    input: { mode: "jev", look: 2, floor: RELEVANCE_FLOOR, piece_floor: PIECE_FLOOR },
    result: trace,
  });
  pages.sort((a, b) => b.p - a.p);
  return { pages: pages.map(({ r, panel }) => ({ r, panel })), credits };
}

/**
 * Look one food up on the web. Never throws.
 *
 * Returns unavailable=true when a search failed, so the caller can fall back
 * to the Anthropic lookup. "Searched and found nothing" is
 * NOT unavailable: it is an answer, and paying a second provider to hear the
 * same thing would double the cost of every obscure food.
 */
export async function runTavilyLookup(deps: TavilyLookupDeps, item: WebFoodItem): Promise<TavilyLookupOutcome> {
  const steps: LookupStep[] = [];
  let credits = 0;
  const seen = new Set<string>();
  const queries = searchQueries(item);

  for (let attempt = 0; attempt < queries.length; attempt++) {
    const q = queries[attempt];
    const s = await tavilySearch(q, {
      country: deps.country,
      preferDomains: preferDomainsFor(deps.country),
      maxResults: MAX_RESULTS,
    }, deps.tavily);
    credits += s.credits;
    if (!s.ok) {
      steps.push({ tool: "tavily_search", input: { q }, result: { failure: s.failure, detail: s.detail } });
      // A failed search means the lookup did not finish, whichever attempt it
      // was: only a search that RAN and found nothing is an answer. So the
      // caller falls back either way. The second attempt failing is the likely
      // shape of a balance running out mid-lookup (caught on PR review).
      return { finding: null, credits, steps, unavailable: true };
    }
    const fresh = s.results.filter((r) => !seen.has(r.url));
    fresh.forEach((r) => seen.add(r.url));
    steps.push({
      tool: "tavily_search",
      input: { q, country: deps.country },
      result: { results: s.results.length, new: fresh.length, sites: fresh.map((r) => hostOf(r.url)) },
    });
    if (fresh.length === 0) continue;

    const picked = await selectPages(deps, item, fresh, steps);
    credits += picked.credits;
    const withPanel = picked.pages;
    if (withPanel.length === 0) {
      steps.push({ tool: "web_panels", input: { results: fresh.length }, result: { panels: 0 } });
      continue;
    }

    const byId = new Map(withPanel.map((p, i) => [`p${i + 1}`, p.r.url]));
    const data = await deps.callModel({
      model: deps.model,
      max_tokens: 1500,
      system: READ_SYSTEM,
      tools: [READ_TOOL],
      tool_choice: { type: "tool", name: READ_TOOL.name },
      messages: [{
        role: "user",
        content: JSON.stringify({
          food: { name: item.name, brand: item.brand },
          pages: withPanel.map((p, i) => ({ page_id: `p${i + 1}`, site: hostOf(p.r.url), title: p.r.title, text: p.panel })),
        }),
      }],
    });
    const block = (data?.content ?? []).find((b: any) => b?.type === "tool_use" && b?.name === READ_TOOL.name);
    const reports = parsePageReports(block?.input);

    const readings: SourceReading[] = [];
    let serving: { label: string; grams: number } | null = null;
    for (const rep of reports) {
      const url = byId.get(rep.page_id);
      if (!url) continue;
      const reading = readingFromReport(rep, url);
      if (!reading) continue;
      readings.push(reading);
      if (!serving && rep.serving_label && rep.serving_grams && rep.serving_grams > 0 && rep.serving_grams <= 5000) {
        serving = { label: rep.serving_label, grams: rep.serving_grams };
      }
    }
    steps.push({
      tool: "web_read",
      input: { pages: withPanel.length },
      result: {
        reported: reports.length,
        kept: readings.map((r) => ({ site: hostOf(r.ref), kcal: r.per_100.kcal })),
      },
    });
    if (readings.length === 0) continue;

    const sites = [...new Set(readings.map((r) => hostOf(r.ref)).filter(Boolean))];
    return {
      finding: {
        readings,
        serving_label: serving?.label ?? null,
        serving_grams: serving?.grams ?? null,
        source_note: sites.length ? `from ${sites.slice(0, 2).join(" and ")}`.slice(0, 80) : null,
      },
      credits,
      steps,
      unavailable: false,
    };
  }
  return { finding: null, credits, steps, unavailable: false };
}
