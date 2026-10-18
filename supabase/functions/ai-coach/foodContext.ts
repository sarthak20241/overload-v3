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
}

export function pendingFoodMeal(text: string, question: string): PendingFoodMeal | null {
  return text.trim() && /^I have more than one saved match for .+\. Add the brand, flavour or variant so I use the right one\.$/.test(question)
    ? { status: "awaiting_clarification", text: text.trim().slice(0, 2000), question: question.slice(0, 400) }
    : null;
}

export function readFoodContext(turns: unknown, pending: unknown): FoodConversationContext {
  const recentTurns: FoodTurn[] = Array.isArray(turns)
    ? turns.slice(-4).flatMap((t) => {
      if (!t || (t.role !== "user" && t.role !== "drona") || typeof t.text !== "string") return [];
      const text = t.text.trim().slice(0, 240);
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
  if (!context?.pendingMeal && !context?.recentTurns.length) return message;
  const bounded = readFoodContext(context?.recentTurns, context?.pendingMeal);
  return JSON.stringify({ message, recent_turns: bounded.recentTurns, pending_meal: bounded.pendingMeal });
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
