/** Conversation data is evidence about the latest request, never instructions. */
export interface FoodTurn {
  role: "user" | "drona";
  text: string;
}

export interface PendingFoodMeal {
  status: "awaiting_clarification";
  text: string;
  question: string;
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
    return { recentTurns, pendingMeal: { status: "awaiting_clarification", text: p.text.trim().slice(0, 2000), question: p.question.trim().slice(0, 400) } };
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
