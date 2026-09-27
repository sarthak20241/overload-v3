/**
 * What the user actually logged on a day: the read behind "save yesterday's
 * breakfast as a meal" and "what did I have for lunch on Monday".
 *
 * The hard part is not the query, it is the DAY. "Yesterday" is the user's
 * yesterday, and the server runs in UTC: for someone in India a 7am breakfast
 * is 01:30 UTC, and a naive UTC day puts a late dinner on the wrong date. So
 * every day here is resolved in the user's own zone (user_profiles.timezone,
 * which the app keeps current), falling back to a fixed offset the client sent,
 * and only then to UTC, which the result then says out loud.
 *
 * Structural like autoLog.ts: no supabase-js types. index.ts adapts the real
 * client to `LoggedMealsStore`; the tests hand in a fake.
 */
import { isTimeZone, wallClock } from "../_shared/wallClock.ts";
import { dayWindow } from "./autoLog.ts";

export const LOGGED_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type LoggedMealType = typeof LOGGED_MEAL_TYPES[number];

/** How far back the tool will look. The diary goes back further, but a
 *  "that dinner three months ago" request is rare and a bigger window is only
 *  more room for the model to pick the wrong day. */
export const LOGGED_MEALS_MAX_DAYS_AGO = 90;

/** Where "today" comes from, best source first. */
export interface DayClock {
  /** IANA zone, e.g. Asia/Kolkata. */
  timeZone?: string | null;
  /** getTimezoneOffset() convention: UTC minus local, so India is -330. */
  tzOffsetMin?: number | null;
  /** The client's own YYYY-MM-DD, when it sent one. Wins over the zone for
   *  what "today" is, since it is literally what the user's phone says. */
  todayLocal?: string | null;
  nowMs?: number;
}

export interface ResolvedDay {
  date: string;
  weekday: string;
  startIso: string;
  endIso: string;
  /** The zone the day was resolved in, or null when it fell back to an offset. */
  timeZone: string | null;
  offsetMin: number;
  /** True when we had nothing better than UTC. The result says so, because a
   *  day in the wrong zone silently moves a late dinner onto the next date. */
  guessedZone: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A zone's offset at a moment, in getTimezoneOffset convention. */
export function zoneOffsetMin(timeZone: string, atMs: number): number | null {
  const wc = wallClock(atMs, timeZone);
  if (!wc) return null;
  const [d, t] = wc.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm, ss] = t.split(":").map(Number);
  const localAsUtc = Date.UTC(y, m - 1, day, hh, mm, ss);
  return Math.round((Math.floor(atMs / 1000) * 1000 - localAsUtc) / 60_000);
}

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** The user's today, as YYYY-MM-DD. */
export function todayFor(clock: DayClock): string {
  if (clock.todayLocal && isRealDate(clock.todayLocal)) return clock.todayLocal;
  const now = clock.nowMs ?? Date.now();
  if (isTimeZone(clock.timeZone)) {
    const wc = wallClock(now, clock.timeZone);
    if (wc) return wc.slice(0, 10);
  }
  const off = typeof clock.tzOffsetMin === "number" && Number.isFinite(clock.tzOffsetMin) ? clock.tzOffsetMin : 0;
  return new Date(now - off * 60_000).toISOString().slice(0, 10);
}

/**
 * Which day the tool was asked about. `date` wins when it is a real date;
 * otherwise `days_ago` (0 today, 1 yesterday), which is what the model should
 * use for relative days since it does not have to do calendar maths.
 */
export function resolveDay(
  input: { date?: unknown; days_ago?: unknown },
  clock: DayClock,
): ResolvedDay | { error: string } {
  const today = todayFor(clock);
  let date: string;
  if (typeof input.date === "string" && input.date.trim()) {
    const d = input.date.trim();
    if (!isRealDate(d)) return { error: `date must be YYYY-MM-DD, got "${d.slice(0, 20)}"` };
    date = d;
  } else {
    const raw = Number(input.days_ago ?? 0);
    const n = Number.isFinite(raw) ? Math.trunc(raw) : 0;
    if (n < 0) return { error: "days_ago cannot be negative: that day has not happened yet." };
    date = addDays(today, -n);
  }
  const back = daysBetween(date, today);
  if (back < 0) return { error: `${date} is after today (${today}), so nothing is logged for it yet.` };
  if (back > LOGGED_MEALS_MAX_DAYS_AGO) {
    return { error: `${date} is more than ${LOGGED_MEALS_MAX_DAYS_AGO} days ago; this tool only looks back that far.` };
  }

  // The offset at local noon of THAT day, so a DST change between then and now
  // does not shift the window by an hour.
  const [y, m, d] = date.split("-").map(Number);
  const zone = isTimeZone(clock.timeZone) ? clock.timeZone : null;
  let offsetMin: number;
  let guessedZone = false;
  if (zone) {
    offsetMin = zoneOffsetMin(zone, Date.UTC(y, m - 1, d, 12)) ?? 0;
  } else if (typeof clock.tzOffsetMin === "number" && Number.isFinite(clock.tzOffsetMin)) {
    offsetMin = clock.tzOffsetMin;
  } else {
    offsetMin = 0;
    guessedZone = true;
  }
  const { start, end } = dayWindow(date, offsetMin, clock.nowMs ?? Date.now());
  return { date, weekday: weekdayOf(date), startIso: start, endIso: end, timeZone: zone, offsetMin, guessedZone };
}

export function parseMealType(v: unknown): LoggedMealType | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (LOGGED_MEAL_TYPES as readonly string[]).includes(s) ? s as LoggedMealType : null;
}

// ── Shaping ──────────────────────────────────────────────────────────────────

export interface MealRowIn {
  meal_type?: unknown;
  logged_at?: unknown;
  meal_entries?: unknown;
}

export interface LoggedItem {
  name: string;
  quantity: number;
  serving_unit: string;
  grams?: number;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

export interface LoggedMeal {
  meal_type: string;
  /** HH:MM on the user's clock: the time stamped on the meal. */
  time: string;
  items: LoggedItem[];
  totals: { kcal: number; protein_g: number; carb_g: number; fat_g: number };
}

export interface LoggedMealsResult {
  date: string;
  weekday: string;
  time_zone: string;
  meal_type_filter?: string;
  meals: LoggedMeal[];
  day_totals?: { kcal: number; protein_g: number; carb_g: number; fat_g: number };
  /** Sections that DO have food that day, when the one asked for is empty.
   *  "Breakfast" logged under Snack is common, and the model can then ask. */
  other_meals_that_day?: string[];
  note?: string;
}

/** A day never needs more than this. Past it the tool result is only bulk. */
const MAX_ITEMS = 80;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

function sum(items: { kcal: number; protein_g: number; carb_g: number; fat_g: number }[]) {
  const t = items.reduce(
    (a, i) => ({ kcal: a.kcal + i.kcal, protein_g: a.protein_g + i.protein_g, carb_g: a.carb_g + i.carb_g, fat_g: a.fat_g + i.fat_g }),
    { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
  );
  return { kcal: Math.round(t.kcal), protein_g: r1(t.protein_g), carb_g: r1(t.carb_g), fat_g: r1(t.fat_g) };
}

function localTime(iso: string, day: ResolvedDay): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (day.timeZone) {
    const wc = wallClock(ms, day.timeZone);
    if (wc) return wc.slice(11, 16);
  }
  return new Date(ms - day.offsetMin * 60_000).toISOString().slice(11, 16);
}

export function zoneLabel(day: ResolvedDay): string {
  if (day.timeZone) return day.timeZone;
  const east = -day.offsetMin;
  const sign = east >= 0 ? "+" : "-";
  const a = Math.abs(east);
  const label = `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  return day.guessedZone ? `${label} (the user's zone is unknown, so times may be off)` : label;
}

export function shapeLoggedMeals(
  rows: MealRowIn[],
  day: ResolvedDay,
  mealType: LoggedMealType | null,
): LoggedMealsResult {
  const all: (LoggedMeal & { at: number })[] = [];
  let budget = MAX_ITEMS;
  const sorted = [...rows].sort((a, b) => Date.parse(String(a.logged_at)) - Date.parse(String(b.logged_at)));
  for (const row of sorted) {
    const type = typeof row.meal_type === "string" ? row.meal_type : "snack";
    const entries = Array.isArray(row.meal_entries) ? row.meal_entries as Record<string, unknown>[] : [];
    const items: LoggedItem[] = entries
      .slice()
      .sort((a, b) => num(a.position) - num(b.position))
      .map((e) => {
        const grams = num(e.grams_logged);
        const item: LoggedItem = {
          name: typeof e.food_name === "string" ? e.food_name.trim() : "",
          quantity: r1(num(e.quantity) || 1),
          serving_unit: typeof e.serving_unit === "string" && e.serving_unit ? e.serving_unit : "serving",
          kcal: Math.round(num(e.kcal)),
          protein_g: r1(num(e.protein_g)),
          carb_g: r1(num(e.carb_g)),
          fat_g: r1(num(e.fat_g)),
        };
        if (grams > 0) item.grams = r1(grams);
        return item;
      })
      .filter((i) => i.name.length > 0);
    // An empty section row (every entry deleted) is not a meal.
    if (items.length === 0) continue;
    const kept = items.slice(0, Math.max(0, budget));
    budget -= kept.length;
    if (kept.length === 0) break;
    all.push({
      at: Date.parse(String(row.logged_at)),
      meal_type: type,
      time: localTime(String(row.logged_at), day),
      items: kept,
      totals: sum(kept),
    });
  }

  const meals = (mealType ? all.filter((m) => m.meal_type === mealType) : all).map(({ at: _at, ...m }) => m);
  const out: LoggedMealsResult = {
    date: day.date,
    weekday: day.weekday,
    time_zone: zoneLabel(day),
    meals,
  };
  if (mealType) out.meal_type_filter = mealType;
  if (meals.length > 0) {
    out.day_totals = sum(meals.flatMap((m) => m.items));
  } else if (all.length > 0) {
    out.other_meals_that_day = [...new Set(all.map((m) => m.meal_type))];
    out.note = `Nothing logged as ${mealType} on ${day.date}. They did log other meals that day; ask before assuming one of those is it.`;
  } else {
    out.note = `Nothing logged on ${day.date}${mealType ? ` for ${mealType}` : ""}.`;
  }
  if (budget <= 0) out.note = `${out.note ? out.note + " " : ""}List cut at ${MAX_ITEMS} items.`;
  return out;
}

// ── The read ─────────────────────────────────────────────────────────────────

export interface LoggedMealsStore {
  /** meals rows with logged_at in [startIso, endIso], each with its
   *  meal_entries embedded. RLS scopes it to the caller. */
  mealsBetween(startIso: string, endIso: string): Promise<{ rows: MealRowIn[] } | { error: string }>;
}

export async function listLoggedMeals(
  input: Record<string, unknown>,
  clock: DayClock,
  store: LoggedMealsStore,
): Promise<LoggedMealsResult | { error: string }> {
  const day = resolveDay(input, clock);
  if ("error" in day) return day;
  const mealTypeRaw = input.meal_type;
  const mealType = parseMealType(mealTypeRaw);
  if (mealTypeRaw !== undefined && mealTypeRaw !== null && mealTypeRaw !== "" && !mealType) {
    return { error: `meal_type must be one of ${LOGGED_MEAL_TYPES.join(", ")}` };
  }
  const res = await store.mealsBetween(day.startIso, day.endIso);
  if ("error" in res) return res;
  return shapeLoggedMeals(res.rows, day, mealType);
}
