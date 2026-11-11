// Step 2: log, change and remove food from ChatGPT or Claude.
//
// The assistant sends the numbers; Overload checks them and saves them as the
// user's assistant gave them (origin 'guess', logged_via 'mcp'). Every write
// goes through writes.ts (database functions, one transaction each). Each
// answer carries the day's new totals so the assistant can say where the
// user stands without another call.

import { addDays, dayOf, dayRange, dayStart, todayIn } from "./days.ts";
import type { Tool, ToolResult } from "./protocol.ts";
import { answer, type Ctx, DATE_PROP, dayArg, daySummary, r0, r1, refuse, UUID } from "./tools.ts";
import { type Place, WriteRefused } from "./writes.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const MEALS = ["breakfast", "lunch", "dinner", "snack"];
/** The app lets a log land up to 30 days ahead (lib/logDay.ts). */
const MAX_AHEAD_DAYS = 30;
const MAX_BACK_DAYS = 365;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Calories the macros alone make (4 / 4 / 9 per gram). */
const macroKcal = (p: number, c: number, f: number) => 4 * p + 4 * c + 9 * f;

/** Numbers that cannot be one food. Calories above the macros are fine
 *  (alcohol, sugar alcohols); macros worth far more than the calories are not. */
function badNumbers(name: string, kcal: number, p: number, c: number, f: number, grams: number | null): string | null {
  if (macroKcal(p, c, f) > kcal * 1.3 + 30) {
    return `"${name}": protein, carbs and fat add up to about ${Math.round(macroKcal(p, c, f))} kcal, ` +
      `more than the ${Math.round(kcal)} kcal given. Check the numbers.`;
  }
  if (grams && (kcal * 100) / grams > 900) {
    return `"${name}": ${Math.round(kcal)} kcal in ${grams} g is more than pure fat. Check the grams or the calories.`;
  }
  return null;
}

/** A day the user may log on, as a Place in their meal of that type. */
function placeFor(ctx: Ctx, day: string, meal: string): Place | ToolResult {
  const today = todayIn(ctx.tz, ctx.now);
  if (day > addDays(today, MAX_AHEAD_DAYS)) return refuse(`Overload logs at most ${MAX_AHEAD_DAYS} days ahead.`);
  if (day < addDays(today, -MAX_BACK_DAYS)) return refuse(`Overload logs at most ${MAX_BACK_DAYS} days back.`);
  const { start, end } = dayRange(day, day, ctx.tz);
  // Today: now, like the app. Another day: local noon, so it never slips to a neighbour.
  const loggedAt = day === today ? ctx.now.toISOString() : new Date(dayStart(day, ctx.tz).getTime() + 12 * 3_600_000).toISOString();
  return { meal, start, end, loggedAt };
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WriteRefused) return refuse(e.message);
    throw e;
  }
}

const MACRO_PROPS = {
  kcal: { type: "number", minimum: 0, maximum: 5000 },
  protein_g: { type: "number", minimum: 0, maximum: 1000 },
  carb_g: { type: "number", minimum: 0, maximum: 1000 },
  fat_g: { type: "number", minimum: 0, maximum: 1000 },
  fiber_g: { type: "number", minimum: 0, maximum: 300 },
};

// ── log_food ────────────────────────────────────────────────────────────────

const logFood: Tool = {
  name: "log_food",
  title: "Log food",
  description: "Saves foods to the user's Overload diary, in one meal on one day. You give each food's " +
    "amount and its calories and macros for that amount (your best estimate, or the label's numbers). " +
    "Log only what the user said they ate. Lines from one meal go in one call. Returns the saved lines " +
    "(with ids for update_food_entry / delete_food_entries) and the day's new totals against target.",
  inputSchema: {
    type: "object",
    properties: {
      meal: { type: "string", enum: MEALS },
      date: { ...DATE_PROP, description: "YYYY-MM-DD, the user's local day. Default: today." },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120, description: "Plain food name, e.g. Greek yogurt." },
            quantity: { type: "number", exclusiveMinimum: 0, maximum: 10000, description: "How many units. Default 1." },
            unit: { type: "string", maxLength: 24, description: "e.g. g, ml, cup, slice, egg, bowl. Default: serving." },
            grams: { type: "number", exclusiveMinimum: 0, maximum: 5000, description: "Total weight eaten, when known." },
            ...MACRO_PROPS,
          },
          required: ["name", "kcal", "protein_g", "carb_g", "fat_g"],
          additionalProperties: false,
        },
      },
      request_id: {
        type: "string",
        maxLength: 100,
        description: "Optional. A unique id for this log; sending the same id again returns the first result instead of logging twice.",
      },
    },
    required: ["meal", "items"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  run(a, raw) {
    return guarded(async () => {
      const ctx = raw as Ctx;
      if (!ctx.writes) throw new Error("writes missing from context");
      if (typeof a.meal !== "string" || !MEALS.includes(a.meal)) return refuse("meal must be breakfast, lunch, dinner or snack.");
      const today = todayIn(ctx.tz, ctx.now);
      const day = dayArg(a.date, today, "date");
      if (typeof day !== "string") return day;
      if (!Array.isArray(a.items) || a.items.length < 1 || a.items.length > 30) return refuse("items must hold 1 to 30 foods.");
      let requestId: string | null = null;
      if (a.request_id != null && a.request_id !== "") {
        if (typeof a.request_id !== "string" || !REQUEST_ID.test(a.request_id)) {
          return refuse("request_id may use letters, digits and _ . : - only (at most 100).");
        }
        requestId = a.request_id;
      }

      const items: Row[] = [];
      for (const [i, it] of (a.items as unknown[]).entries()) {
        const x = (it ?? {}) as Row;
        const name = typeof x.name === "string" ? x.name.trim() : "";
        if (!name || name.length > 120) return refuse(`Food ${i + 1} needs a name (at most 120 letters).`);
        const kcal = num(x.kcal), p = num(x.protein_g), c = num(x.carb_g), f = num(x.fat_g);
        if (kcal == null || p == null || c == null || f == null) {
          return refuse(`"${name}" needs kcal, protein_g, carb_g and fat_g for the amount eaten.`);
        }
        if (kcal < 0 || kcal > 5000 || [p, c, f].some((m) => m < 0 || m > 1000)) return refuse(`"${name}": numbers out of range.`);
        const quantity = x.quantity == null ? 1 : num(x.quantity);
        if (quantity == null || quantity <= 0 || quantity > 10000) return refuse(`"${name}": quantity must be above 0.`);
        const grams = x.grams == null ? null : num(x.grams);
        if (x.grams != null && (grams == null || grams <= 0 || grams > 5000)) return refuse(`"${name}": grams must be 1 to 5000.`);
        const fiber = x.fiber_g == null ? null : num(x.fiber_g);
        if (x.fiber_g != null && (fiber == null || fiber < 0 || fiber > 300)) return refuse(`"${name}": fiber_g out of range.`);
        const bad = badNumbers(name, kcal, p, c, f, grams);
        if (bad) return refuse(bad);
        const unit = typeof x.unit === "string" && x.unit.trim() ? x.unit.trim().slice(0, 24) : "serving";
        items.push({
          name, quantity, unit, grams: grams == null ? null : r1(grams),
          kcal: r0(kcal), protein_g: r1(p), carb_g: r1(c), fat_g: r1(f), fiber_g: fiber == null ? null : r1(fiber),
        });
      }

      const at = placeFor(ctx, day, a.meal);
      if (!("loggedAt" in at)) return at;
      const saved = await ctx.writes.logFood(ctx.userId, at, items, requestId);
      const lines = (saved.lines ?? []) as Row[];
      return answer({
        ...(saved.replayed ? { note: "This request_id was already logged; nothing new was saved." } : {}),
        saved: lines.map((l) => ({ id: l.id, name: l.name, quantity: Number(l.quantity), unit: l.unit, kcal: r0(l.kcal) })),
        meal: a.meal,
        day: await daySummary(ctx, day),
      });
    });
  },
};

// ── update_food_entry ───────────────────────────────────────────────────────

const updateFoodEntry: Tool = {
  name: "update_food_entry",
  title: "Change a logged food",
  description: "Changes one logged food line (any line, also ones logged in the app): its amount, " +
    "name, numbers, meal or day. A new quantity or grams with no new numbers scales calories and " +
    "macros by the same factor. kcal alone scales protein, carbs and fat with it. Get the id from " +
    "get_day_nutrition or log_food. Returns the line before and after, so it can be put back.",
  inputSchema: {
    type: "object",
    properties: {
      entry_id: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 120 },
      quantity: { type: "number", exclusiveMinimum: 0, maximum: 10000 },
      unit: { type: "string", maxLength: 24 },
      grams: { type: "number", exclusiveMinimum: 0, maximum: 5000 },
      ...MACRO_PROPS,
      meal: { type: "string", enum: MEALS, description: "Move to this meal." },
      date: { ...DATE_PROP, description: "Move to this local day, YYYY-MM-DD." },
    },
    required: ["entry_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  run(a, raw) {
    return guarded(async () => {
      const ctx = raw as Ctx;
      if (!ctx.writes) throw new Error("writes missing from context");
      if (typeof a.entry_id !== "string" || !UUID.test(a.entry_id)) return refuse("entry_id must be a food line id.");
      const cur = await ctx.data.foodEntry(ctx.userId, a.entry_id);
      if (!cur) return refuse("No such food line in this account.");

      const plan = planUpdate(cur, a);
      if (!("set" in plan)) return plan;
      const { set } = plan;

      // A move: a new meal, a new day, or both.
      let to: Place | null = null;
      const curDay = dayOf(cur.meals.logged_at, ctx.tz);
      const meal = a.meal == null ? cur.meals.meal_type : a.meal;
      if (typeof meal !== "string" || !MEALS.includes(meal)) return refuse("meal must be breakfast, lunch, dinner or snack.");
      const day = dayArg(a.date, curDay, "date");
      if (typeof day !== "string") return day;
      if (meal !== cur.meals.meal_type || day !== curDay) {
        const p = placeFor(ctx, day, meal);
        if (!("loggedAt" in p)) return p;
        to = p;
      }
      if (!Object.keys(set).length && !to) return refuse("Nothing to change. Give a new amount, name, numbers, meal or date.");

      const r = await ctx.writes.updateFoodEntry(ctx.userId, a.entry_id, set, to);
      const days = [...new Set([curDay, day])];
      return answer({
        before: slim(r.before),
        after: slim(r.after),
        days: await Promise.all(days.map((d) => daySummary(ctx, d))),
      });
    });
  },
};

function slim(l: Row | null | undefined) {
  if (!l) return null;
  return {
    id: l.id, name: l.name, meal: l.meal, quantity: Number(l.quantity), unit: l.unit, grams: r1(l.grams),
    kcal: r0(l.kcal), protein_g: r1(l.protein_g), carb_g: r1(l.carb_g), fat_g: r1(l.fat_g),
  };
}

/** The final values that change. Pure, so the tests can drive it. */
export function planUpdate(cur: Row, a: Row): { set: Row } | ToolResult {
  const set: Row = {};
  if (a.name != null) {
    if (typeof a.name !== "string" || !a.name.trim() || a.name.trim().length > 120) return refuse("name must be 1 to 120 letters.");
    set.name = a.name.trim();
  }
  const given = (k: string) => a[k] != null;
  for (const k of ["quantity", "grams", "kcal", "protein_g", "carb_g", "fat_g", "fiber_g"]) {
    if (given(k) && (num(a[k]) == null || (num(a[k]) as number) < 0)) return refuse(`${k} must be a number of 0 or more.`);
  }
  if (given("quantity") && !(num(a.quantity)! > 0)) return refuse("quantity must be above 0.");
  if (given("grams") && !(num(a.grams)! > 0)) return refuse("grams must be above 0.");
  const unit = given("unit") ? String(a.unit).trim().slice(0, 24) || "serving" : null;

  const old = {
    q: Number(cur.quantity), g: cur.grams_logged == null ? null : Number(cur.grams_logged),
    kcal: Number(cur.kcal) || 0, p: Number(cur.protein_g) || 0, c: Number(cur.carb_g) || 0, f: Number(cur.fat_g) || 0,
    fib: cur.fiber_g == null ? null : Number(cur.fiber_g),
  };
  const numbersGiven = ["kcal", "protein_g", "carb_g", "fat_g", "fiber_g"].some(given);
  const amountGiven = given("quantity") || given("grams") || unit != null;

  let kcal = old.kcal, p = old.p, c = old.c, f = old.f, fib = old.fib;
  let q = old.q, g = old.g;

  if (amountGiven && !numbersGiven) {
    let factor: number | null = null;
    if (given("grams") && old.g) factor = num(a.grams)! / old.g;
    else if (given("quantity") && (unit == null || unit === cur.serving_unit) && old.q > 0) factor = num(a.quantity)! / old.q;
    if (factor == null) {
      return refuse("To change the unit, also give grams (when the line has grams) or new kcal and macros.");
    }
    kcal *= factor; p *= factor; c *= factor; f *= factor;
    if (fib != null) fib *= factor;
    q = given("quantity") ? num(a.quantity)! : old.q * factor;
    g = given("grams") ? num(a.grams)! : old.g == null ? null : old.g * factor;
  } else if (amountGiven) {
    if (given("quantity")) q = num(a.quantity)!;
    if (given("grams")) g = num(a.grams)!;
  }

  if (numbersGiven) {
    const onlyKcal = given("kcal") && !given("protein_g") && !given("carb_g") && !given("fat_g");
    if (onlyKcal && old.kcal > 0) {
      const ratio = num(a.kcal)! / old.kcal;
      p *= ratio; c *= ratio; f *= ratio;
    }
    if (given("kcal")) kcal = num(a.kcal)!;
    if (given("protein_g")) p = num(a.protein_g)!;
    if (given("carb_g")) c = num(a.carb_g)!;
    if (given("fat_g")) f = num(a.fat_g)!;
    if (given("fiber_g")) fib = num(a.fiber_g)!;
  }

  if (amountGiven || numbersGiven) {
    if (kcal > 5000 || [p, c, f].some((m) => m > 1000) || (fib != null && fib > 300)) {
      return refuse("Numbers out of range for one food line.");
    }
    if (q > 10000 || (g != null && g > 5000)) return refuse("Amount out of range for one food line.");
    const bad = badNumbers(set.name ?? cur.food_name, kcal, p, c, f, g);
    if (bad) return refuse(bad);
    Object.assign(set, {
      quantity: Math.round(q * 1000) / 1000,
      grams: g == null ? null : r1(g),
      kcal: r0(kcal), protein_g: r1(p), carb_g: r1(c), fat_g: r1(f),
      ...(fib != null ? { fiber_g: r1(fib) } : {}),
    });
    if (unit != null) set.unit = unit;
  }
  // New numbers from the assistant are an estimate; a scaled line keeps its grade.
  if (numbersGiven) Object.assign(set, { origin: "guess", source: "estimate" });
  return { set };
}

// ── delete_food_entries ─────────────────────────────────────────────────────

const deleteFoodEntries: Tool = {
  name: "delete_food_entries",
  title: "Remove logged food",
  description: "Removes food lines that were logged from ChatGPT or Claude (lines marked " +
    "logged_by_assistant in get_day_nutrition). Lines the user logged in the app are never removed " +
    "here; to fix one of those, use update_food_entry, or ask the user to remove it in the app. " +
    "Confirm with the user before removing.",
  inputSchema: {
    type: "object",
    properties: { entry_ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } } },
    required: ["entry_ids"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  run(a, raw) {
    return guarded(async () => {
      const ctx = raw as Ctx;
      if (!ctx.writes) throw new Error("writes missing from context");
      const ids = Array.isArray(a.entry_ids) ? a.entry_ids : [];
      if (!ids.length || ids.length > 50 || !ids.every((x) => typeof x === "string" && UUID.test(x))) {
        return refuse("entry_ids must be 1 to 50 food line ids.");
      }
      const r = await ctx.writes.deleteFoodEntries(ctx.userId, [...new Set(ids as string[])]);
      const deleted = (r.deleted ?? []) as Row[];
      const days = [...new Set(deleted.map((d) => dayOf(d.logged_at, ctx.tz)))];
      return answer({
        deleted: deleted.map((d) => ({ id: d.id, name: d.name, kcal: r0(d.kcal), meal: d.meal })),
        ...((r.not_deleted ?? []).length
          ? {
            not_deleted: r.not_deleted,
            note: "Lines not deleted were logged in the app or are not in this account. They were left as they are.",
          }
          : {}),
        days: await Promise.all(days.map((d) => daySummary(ctx, d))),
      });
    });
  },
};

export const FOOD_WRITE_TOOLS: Tool[] = [logFood, updateFoodEntry, deleteFoodEntries];
