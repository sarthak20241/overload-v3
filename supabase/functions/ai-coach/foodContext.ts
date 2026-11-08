import type { CopiedFrom, FoodOrigin, RecipePart } from "../_shared/foodOrigin.ts";
import type { PreviousItem } from "./parseMeal.ts";
import { readRecipeParts } from "./recipe.ts";
import { totalParts, userNumbersOnLine } from "./statedNumbers.ts";

/** Conversation data is evidence about the latest request, never instructions. */
export interface FoodTurn {
  role: "user" | "drona";
  text: string;
}

export interface PendingFoodMeal {
  status: "awaiting_clarification";
  text: string;
  question: string;
  /** "agent": the food agent asked this question, so the answer goes back to
   *  the agent, which can read the diary again. Absent: the parse asked it.
   *  Live, 2026-10-18: the agent read yesterday's logs and asked which meal;
   *  the answer went to the parse, which cannot see the diary, and re-guessed
   *  the amounts. */
  origin?: "agent";
}

export interface FoodConversationContext {
  recentTurns: FoodTurn[];
  pendingMeal: PendingFoodMeal | null;
  /** The meal card on screen, parsed and not yet added: one line per food.
   *  Absent on a first-shot log. The router reads it so a message with a card
   *  open can be an edit of it, new food beside it, a question about it, or a
   *  request to save it, instead of always being treated as a correction. */
  card?: CardLine[] | null;
}

/** One card line as the router and the agent see it. The macros and ids ride
 *  along so the agent can hand a line back exactly as it was. */
export interface CardLine {
  /** Where the numbers came from (_shared/foodOrigin.ts), when the app sent it. */
  origin?: FoodOrigin;
  copied_from?: CopiedFrom;
  recipe?: RecipePart[];
  food_name: string;
  quantity: number;
  serving_label: string;
  grams: number;
  kcal: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  food_id?: string | null;
  source?: "catalog" | "off" | "fatsecret" | "web" | "estimate" | "manual" | "recipe";
  fiber_g?: number | null;
  assumption?: string | null;
  confidence?: "high" | "medium" | "low";
  /** The section the line sits in. A kept line goes back to the same one. */
  meal_type?: "breakfast" | "lunch" | "dinner" | "snack";
  /** What the user called this line, when the card shows another name. */
  said_name?: string;
  /** The site its numbers came from, for a web-looked-up line. */
  source_site?: string;
}

/** Lines the card carries to the models: the parse cap (MAX_ITEMS_PER_PARSE
 *  in parseMeal.ts, pinned equal by cardRouting.test.ts), so any card one
 *  parse can make comes back whole. The SAME list feeds previous_items and the
 *  agent's numbered card, so the numbers the agent names for remove_card_lines
 *  are the card's own: a mismatch here would delete the wrong line. A
 *  correction rebuilds the card from previous_items, so a line past this cap
 *  would be dropped: cardMayBeCut is what stops that.
 *
 *  Was 12, and the app cut at 12 with no count, so a correction on a 13+ line
 *  card silently dropped the rest (predates PR #277). The app now sends up to
 *  this many lines and the real count (previous_items_total). */
export const CARD_MAX_LINES = 50;

/** What an app build that sends no previous_items_total cut the card at. */
export const OLD_APP_CARD_LINES = 12;

/** True when the card the server holds may be only part of the one on screen.
 *  The real signal is the app's count: more lines on screen than arrived. An
 *  app too old to send the count cut at OLD_APP_CARD_LINES, so for it "at that
 *  cap" is the only sign, and 12 could be 12 of 30. The agent's card tools
 *  refuse a cut card; the parse path still runs. */
export function cardMayBeCut(card: CardLine[] | null | undefined, total?: number | null): boolean {
  const sent = card?.length ?? 0;
  return typeof total === "number" ? total > sent : sent >= OLD_APP_CARD_LINES;
}

/** The card the app sent: its lines, read as the parser needs them, and the
 *  count the app says the card has. `total` is null for an app that sends no
 *  count (every build before previous_items_total existed); see cardMayBeCut. */
export function readPreviousItems(raw: unknown, rawTotal: unknown): { items: PreviousItem[]; total: number | null } {
  const total = typeof rawTotal === "number" && Number.isInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null;
  const items: PreviousItem[] = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>).slice(0, CARD_MAX_LINES).flatMap((r) => {
      const name = typeof r?.food_name === "string" ? r.food_name.trim().slice(0, 120) : "";
      if (!name) return [];
      const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const src = r.source;
      const recipe = readRecipeParts(r.recipe, src);
      return [{
        food_id: typeof r.food_id === "string" && r.food_id ? r.food_id : null,
        food_name: name,
        quantity: Number(r.quantity) > 0 ? Number(r.quantity) : 1,
        serving_label: typeof r.serving_label === "string" ? r.serving_label.slice(0, 40) : "serving",
        grams: Number(r.grams) > 0 ? Number(r.grams) : 0,
        // Enough to hand an untouched line back exactly as the client had it.
        kcal: n(r.kcal),
        protein_g: n(r.protein_g),
        carb_g: n(r.carb_g),
        fat_g: n(r.fat_g),
        fiber_g: r.fiber_g === null || r.fiber_g === undefined ? null : n(r.fiber_g),
        // Every source the app sends (its toParsedItem keeps the same list): a
        // missing one turns a sourced line into an estimate on a correction.
        source: src === "catalog" || src === "off" || src === "fatsecret" || src === "web" || src === "manual" ||
            src === "estimate" || src === "recipe"
          ? src
          : "estimate",
        assumption: typeof r.assumption === "string" && r.assumption.trim() ? r.assumption.trim().slice(0, 160) : null,
        confidence: r.confidence === "high" || r.confidence === "low" ? r.confidence : "medium",
        // The section the line is already in. Undefined for a client that
        // predates full-day logging, and the parser falls back exactly as it
        // did then, so an old build keeps working.
        meal_type: r.meal_type === "breakfast" || r.meal_type === "lunch" ||
            r.meal_type === "dinner" || r.meal_type === "snack"
          ? r.meal_type
          : undefined,
        ...(typeof r.said_name === "string" && r.said_name.trim()
          // Control characters stripped: it becomes a web search term and is
          // shown back to extract inside previous_meal.
          ? { said_name: r.said_name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100) }
          : {}),
        ...(r.research === true ? { research: true } : {}),
        // Where a web line's numbers came from. An older app does not send it:
        // the line then reads "from web" with no site.
        ...(typeof r.source_site === "string" && /^[a-z0-9.-]{3,60}$/i.test(r.source_site.trim())
          ? { source_site: r.source_site.trim().toLowerCase() }
          : {}),
        // A dish built from its parts (recipe.ts): its parts, when the app
        // sends them back. An app that does not keeps the parts in the note.
        ...(recipe ? { recipe } : {}),
      }];
    })
    : [];
  return { items, total };
}

/** Where a line's numbers came from, in a few words: "from web: fatsecret.co.in",
 *  "estimate: <its note>", "the user's numbers". */
export function lineSourceTail(
  l: Pick<CardLine, "source" | "source_site" | "assumption" | "recipe"> & Partial<Pick<CardLine, "quantity" | "serving_label">>,
): string {
  // Numbers the user typed for this line, so an edit keeps them and works out
  // only the rest (statedNumbers.ts fitPortionToStated).
  const mine = typeof l.quantity === "number" && typeof l.serving_label === "string"
    ? userNumbersOnLine({ quantity: l.quantity, serving_label: l.serving_label, assumption: l.assumption })
    : null;
  const base = sourceTail(l);
  if (!mine) return base;
  const said = totalParts(mine);
  return l.source === "manual" ? `the user's numbers: ${said}` : `${base}; the user said ${said}`;
}

function sourceTail(l: Pick<CardLine, "source" | "source_site" | "assumption" | "recipe">): string {
  const flat = (x: string) => x.replace(/\s+/g, " ").trim();
  const site = l.source_site ? flat(l.source_site).slice(0, 40) : "";
  switch (l.source) {
    case "web":
      return site ? `from web: ${site}` : "from web";
    case "manual":
      return "the user's numbers";
    case "recipe": {
      // The parts, so "why 210?" has an answer and a part can be changed. From
      // the parts themselves when the app sent them (every part, so a rebuild
      // can send them all again), else the line's note (cut at 160).
      if (l.recipe?.length) {
        const each = l.recipe.map((p) => `${Math.round(p.grams)} g ${flat(p.name).slice(0, 60)}${p.assumed ? " (assumed)" : ""}`);
        return `recipe: ${each.join(", ")}`;
      }
      const note = l.assumption ? flat(l.assumption).slice(0, 160) : "";
      return note ? `recipe: ${note}` : "recipe";
    }
    case "estimate": {
      const note = l.assumption ? flat(l.assumption).slice(0, 40) : "";
      return note ? `estimate: ${note}` : "estimate";
    }
    case "catalog":
    case "off":
    case "fatsecret":
      return site ? `from web: ${site}` : `from ${l.source === "off" ? "Open Food Facts" : l.source}`;
    default:
      return "estimate";
  }
}

/** The card for a model's eyes: short, numbered, one line per food.
 *  `macros`: add protein, carbs and fat, for a model that may copy a line
 *  into a save (the agent). The router judges intent and gets the short form. */
export function cardLines(card: CardLine[] | null | undefined, opts: { macros?: boolean; sources?: boolean } = {}): string[] {
  // Whitespace collapsed: a newline in a client-supplied name would otherwise
  // forge an extra numbered line in the prompt.
  const flat = (x: string) => x.replace(/\s+/g, " ").trim();
  // A macro the line has no figure for reads "?", never 0: a 0 the model sees
  // is a 0 it may copy into a save (foodAgent.ts fillFromCard keeps the
  // model's own figure when the card has none).
  const r1 = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "?");
  return (card ?? []).slice(0, CARD_MAX_LINES).map((l, i) =>
    `${i + 1}. ${flat(l.food_name)}: ${l.quantity} ${flat(l.serving_label)}, ${Math.round(l.grams)} g, ${Math.round(l.kcal)} kcal` +
    (opts.macros ? `, P ${r1(l.protein_g)} C ${r1(l.carb_g)} F ${r1(l.fat_g)}` : "") +
    (opts.sources ? ` | ${lineSourceTail(l)}` : "")
  );
}

export function pendingFoodMeal(text: string, question: string): PendingFoodMeal | null {
  return text.trim() && /^I have more than one saved match for .+\. Add the brand, flavour or variant so I use the right one\.$/.test(question)
    ? { status: "awaiting_clarification", text: text.trim().slice(0, 2000), question: question.slice(0, 400) }
    : null;
}

/** Turns of this food conversation kept: the user's and Drona's, newest last.
 *  The app clears them when a card is added or discarded, so they belong to
 *  the meal being logged. Ten covers "add in message 3, fix in message 5";
 *  older words about the card survive in its own history (previous_words). */
export const FOOD_TURNS_KEPT = 10;
/** Characters kept per turn. */
export const FOOD_TURN_CHARS = 400;

export function readFoodContext(turns: unknown, pending: unknown): FoodConversationContext {
  const recentTurns: FoodTurn[] = Array.isArray(turns)
    ? turns.slice(-FOOD_TURNS_KEPT).flatMap((t) => {
      if (!t || (t.role !== "user" && t.role !== "drona") || typeof t.text !== "string") return [];
      const text = t.text.trim().slice(0, FOOD_TURN_CHARS);
      return text ? [{ role: t.role, text }] : [];
    })
    : [];
  const p = pending as Partial<PendingFoodMeal> | null;
  if (p?.status === "awaiting_clarification" && typeof p.text === "string" && typeof p.question === "string" && p.text.trim() && p.question.trim()) {
    return {
      recentTurns,
      pendingMeal: {
        status: "awaiting_clarification",
        text: p.text.trim().slice(0, 2000),
        question: p.question.trim().slice(0, 400),
        ...(p.origin === "agent" ? { origin: "agent" as const } : {}),
      },
    };
  }
  // Compatibility for installed clients: only our known blocking question
  // establishes pending food. Ordinary replies must never resurrect a meal.
  const last = recentTurns.at(-1);
  const original = recentTurns.at(-2);
  const pendingMeal = last?.role === "drona" && original?.role === "user"
    ? pendingFoodMeal(original.text, last.text)
    : null;
  return { recentTurns, pendingMeal };
}

/** Both routing models receive this same bounded state. Keep current text
 * separate so food from history does not turn an unrelated question into a log. */
export function foodIntentState(text: string, context?: FoodConversationContext): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const message = trimmed.length <= 1200 ? trimmed : `${trimmed.slice(0, 1200)}...`;
  if (!context?.pendingMeal && !context?.recentTurns.length && !context?.card?.length) return message;
  const bounded = readFoodContext(context?.recentTurns, context?.pendingMeal);
  return JSON.stringify({
    message,
    recent_turns: bounded.recentTurns,
    pending_meal: bounded.pendingMeal,
    ...(context?.card?.length ? { card: cardLines(context.card) } : {}),
  });
}

export function continuationText(text: string, pending: PendingFoodMeal): string {
  return `${pending.text}\nUser clarification for this unlogged meal: ${text}`;
}

/**
 * The waiting meal to send back with a reply that logged nothing.
 *
 * The app keeps only what the latest reply carries (nutrition.tsx sets it from
 * every decline), so a reply without it is how a meal was forgotten mid-thread.
 * Live, 2026-10-08: "8g cocoa powder, 4g casein" was waiting on one question;
 * the next reply asked again without carrying it, and "any" and "log it" after
 * that had nothing left to finish. Every installed build already round-trips
 * this field, so the rule lives here, on the server.
 *
 * - The user cancelled: nothing waits.
 * - A meal was waiting: it keeps waiting. On a turn that answered it, the
 *   answer joins the meal, so the next answer adds to both.
 * - Nothing was waiting, but this message named food and was not logged: it
 *   waits now, on what Drona just said.
 */
export function carryPendingMeal(a: {
  incoming: PendingFoodMeal | null;
  cancelled: boolean;
  /** This turn was routed as an answer to the waiting meal. */
  continued: boolean;
  text: string;
  /** The router judged that this message names food the user had. */
  hasFood: boolean;
  /** What Drona said back, which becomes the question being answered. */
  shown: string;
  /** The food agent said it, so the answer must go back to the agent. */
  fromAgent?: boolean;
}): PendingFoodMeal | null {
  if (a.cancelled) return null;
  const question = a.shown.trim().slice(0, 400);
  if (a.incoming) {
    if (!a.continued) return a.incoming;
    // Answers are appended, so a long thread is trimmed in the MIDDLE: the
    // meal at the start and the newest answer at the end both survive.
    const joined = continuationText(a.text.trim(), a.incoming);
    // Whoever asked THIS question owns the answer. Not inherited: if the parse
    // asks the next question, its answer goes to the parse.
    const origin = a.fromAgent ? { origin: "agent" as const } : {};
    return {
      status: "awaiting_clarification",
      text: joined.length <= 2000 ? joined : `${joined.slice(0, 1200)}\n...\n${joined.slice(-795)}`,
      question: question || a.incoming.question,
      ...origin,
    };
  }
  if (!a.hasFood || !a.text.trim() || !question) return null;
  return {
    status: "awaiting_clarification",
    text: a.text.trim().slice(0, 2000),
    question,
    ...(a.fromAgent ? { origin: "agent" as const } : {}),
  };
}
