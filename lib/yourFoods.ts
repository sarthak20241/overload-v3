/**
 * Your foods: what this user logged before, found first by manual search.
 *
 * Search only ranks `foods` rows, and 84% of logged lines have no food_id (AI
 * lines, quick adds, the bundled staples), so the food a user logs every day
 * could not be found by name (measured on prod, 2026-10-31). This rebuilds a
 * loggable food from each name in the user's own diary, and puts the ones that
 * match the query at the top of the results.
 *
 * Owner decisions 2026-10-31:
 *   - any food ever logged counts, AI or manual, once is enough
 *   - one list: your foods first, each with a small tag; a food whose numbers
 *     were an estimate says so
 *   - "+" logs it again with the portion used last time
 *   - numbers: the most trusted log of that food wins, then the newest (the
 *     same rule as Drona's memory, supabase/functions/ai-coach/userFoodMemory.ts);
 *     the portion is always the newest log's
 *
 * Pure: no app imports, so Deno tests it directly (lib/yourFoods.test.ts).
 */
import { MASS_UNITS, VOLUME_UNITS, isMeasurementUnit } from './units';

/** One diary line, as read from meal_entries + its meal. */
export interface YourFoodEntry {
  food_id: string | null;
  food_name: string;
  serving_unit: string | null;
  quantity: number | null;
  grams_logged: number | null;
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null; sugar_g: number | null; sat_fat_g: number | null; sodium_mg: number | null;
  logged_via: string | null;
  source: string | null;
  tier: string | null;
  logged_at: string;
}

/** What marks a search row as the user's own. */
export interface YourFoodMark {
  /** Lines of this food in the diary. */
  times: number;
  /** The portion used last time: `quantity` x `servingLabel`. */
  quantity: number;
  servingLabel: string;
  /** The numbers shown came from an estimate, not a label or the user. */
  estimate: boolean;
  lastLoggedAt: string;
}

/** A loggable food, the same shape the picker logs (PickerFood), plus its mark. */
export interface YourFood {
  id: string | null;
  name: string;
  food_category: 'other';
  base_unit: 'g';
  kcal: number; protein_g: number; carb_g: number; fat_g: number;
  fiber_g: number | null; sugar_g: number | null; sat_fat_g: number | null; sodium_mg: number | null;
  servings: { label: string; grams: number; is_default: boolean }[];
  /** Set when last time's portion was a volume ("1 cup" of rice weighed 195 g),
   *  so the unit tables weigh that cup as logged instead of as water. */
  density_g_per_ml?: number;
  /** Dedupe key: case, accents, punctuation and plurals folded. */
  key: string;
  /** Every catalog id this name was logged under, so the catalog copy is hidden. */
  ids: string[];
  yours: YourFoodMark;
}

/** Plural to singular, word by word: "cucumbers" -> "cucumber", "berries" -> "berry". */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * One key per food name: "Cucumbers", "cucumber" and "CUCUMBER" are one food.
 * Word order and extra words still count, so "Cucumber, raw" and "chocolate
 * milk" stay their own foods. Merging "milk" into "chocolate milk" would log
 * the wrong numbers, and two rows are only untidy.
 */
export function yourFoodKey(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).map(singular).join(' ');
}

/**
 * How much a line's numbers are trusted, highest first. Numbers the user typed
 * or edited (4); a food they picked from search, and Precise (3); Thorough (2);
 * Quick and anything unknown (1). A search log carries no logged_via at all.
 */
export function entryTrust(e: Pick<YourFoodEntry, 'logged_via' | 'source' | 'tier'>): number {
  if (e.source === 'manual' || e.logged_via === 'manual') return 4;
  if (e.logged_via == null) return 3;
  if (e.tier === 'precise') return 3;
  if (e.tier === 'thorough') return 2;
  return 1;
}

const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(Number(v)) ? 0 : Number(v));
const at = (e: YourFoodEntry) => Date.parse(e.logged_at) || 0;
const unitOf = (e: YourFoodEntry) => (e.serving_unit ?? '').trim().toLowerCase();
const own = (o: Record<string, number>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/**
 * Grams in one unit of the line's portion: from its weight when it has one,
 * else from the unit tables for a measurement unit ("150 g" with no weight is
 * still 150 g; a volume counts as water, the same as resolveBaseAmount with no
 * density). Null for a named unit with no weight ("1 scoop").
 */
const unitGrams = (e: YourFoodEntry): number | null => {
  const g = n0(e.grams_logged), q = n0(e.quantity);
  if (g > 0 && q > 0) return g / q;
  const u = unitOf(e);
  if (own(MASS_UNITS, u)) return MASS_UNITS[u];
  if (own(VOLUME_UNITS, u)) return VOLUME_UNITS[u];
  return null;
};
const sameUnit = (a: YourFoodEntry, b: YourFoodEntry) => unitOf(a) === unitOf(b);

/**
 * Rebuild one food from all of its lines. Numbers come from the most trusted
 * line (T), the portion from the newest (N):
 *   - same unit: T's numbers per unit, scaled into N's unit weight
 *   - both weighed: T's numbers per gram, N's unit weight
 *   - otherwise T's numbers can not be put into N's portion, so T gives both
 * A named unit with no weight treats one unit as 100 g, the same as Recents,
 * so the numbers per unit stay exact.
 */
function rebuild(key: string, lines: YourFoodEntry[]): YourFood | null {
  const byNew = [...lines].sort((a, b) => at(b) - at(a));
  const newest = byNew[0];
  const trusted = byNew.reduce((best, e) => (entryTrust(e) > entryTrust(best) ? e : best), newest);

  let portion = newest;
  if (!sameUnit(trusted, newest) && !(unitGrams(trusted) && unitGrams(newest))) portion = trusted;

  const qty = n0(portion.quantity) > 0 ? n0(portion.quantity) : 1;
  const grams = unitGrams(portion) ?? 100;
  // Same unit: T's numbers per unit, put into the portion's unit weight. Else
  // both weighed (checked above): T's numbers per gram.
  const tq = n0(trusted.quantity) > 0 ? n0(trusted.quantity) : 1;
  const per100 = 100 / (tq * (sameUnit(trusted, portion) ? grams : unitGrams(trusted) ?? 0));
  if (!Number.isFinite(per100) || per100 <= 0) return null;
  const scale = (v: number | null) => (v == null ? null : Number(v) * per100);

  const raw = (portion.serving_unit ?? '').trim();
  const measured = isMeasurementUnit(raw);
  // resolveBaseAmount looks units up as written, so "Cup" must become "cup".
  const label = measured ? raw.toLowerCase() : raw;
  const ids = [...new Set(lines.map((e) => e.food_id).filter((x): x is string => !!x))];
  return {
    id: trusted.food_id ?? newest.food_id ?? ids[0] ?? null,
    name: newest.food_name.trim(),
    food_category: 'other',
    base_unit: 'g',
    kcal: n0(trusted.kcal) * per100, protein_g: n0(trusted.protein_g) * per100,
    carb_g: n0(trusted.carb_g) * per100, fat_g: n0(trusted.fat_g) * per100,
    fiber_g: scale(trusted.fiber_g), sugar_g: scale(trusted.sugar_g),
    sat_fat_g: scale(trusted.sat_fat_g), sodium_mg: scale(trusted.sodium_mg),
    // A measurement label ("g", "cup") must not become a serving: the food's own
    // servings win over the unit tables in resolveBaseAmount, so a {label:'g',
    // grams:100} serving would make "1 g" weigh 100 g (see recentFoods).
    servings: !label || measured ? [] : [{ label, grams, is_default: true }],
    ...(own(VOLUME_UNITS, label) ? { density_g_per_ml: grams / VOLUME_UNITS[label] } : {}),
    key,
    ids,
    yours: {
      times: lines.length,
      quantity: qty,
      servingLabel: label || '100 g',
      estimate: trusted.source === 'estimate',
      lastLoggedAt: newest.logged_at,
    },
  };
}

/** Every food in the diary, one per name. Lines with no calories are left out:
 *  most are the zero rows an old Recents bug wrote (see recentFoods), and one
 *  of those must not come back as the user's own numbers. */
export function buildYourFoods(entries: YourFoodEntry[]): YourFood[] {
  const groups = new Map<string, YourFoodEntry[]>();
  for (const e of entries) {
    if (!e.food_name?.trim() || !(n0(e.kcal) > 0)) continue;
    const key = yourFoodKey(e.food_name);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(e); else groups.set(key, [e]);
  }
  const out: YourFood[] = [];
  for (const [key, lines] of groups) {
    const f = rebuild(key, lines);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Your foods that match what was typed, best first:
 *   0 the whole name
 *   1 every word typed is a whole word of the name ("milk" finds "Toned milk")
 *   2 the name starts with it ("milk" finds "Milky Mist paneer")
 *   3 every word typed starts a word of the name ("chi se" finds "Chia seeds")
 * Then the one logged most, then the newest. Tier 1 sits above 2 because a
 * whole word is what the user means: on prod "milk" put four "Milky Mist"
 * rows above Toned Milk, logged 11 times.
 */
export function matchYourFoods(foods: YourFood[], query: string, limit = 8): YourFood[] {
  const q = yourFoodKey(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored: { f: YourFood; tier: number }[] = [];
  for (const f of foods) {
    const nameWords = f.key.split(' ');
    let tier: number;
    if (f.key === q) tier = 0;
    else if (words.every((w) => nameWords.includes(w))) tier = 1;
    else if (f.key.startsWith(q)) tier = 2;
    else if (words.every((w) => nameWords.some((nw) => nw.startsWith(w)))) tier = 3;
    else continue;
    scored.push({ f, tier });
  }
  scored.sort((a, b) =>
    a.tier - b.tier
    || b.f.yours.times - a.f.yours.times
    || Date.parse(b.f.yours.lastLoggedAt) - Date.parse(a.f.yours.lastLoggedAt));
  return scored.slice(0, limit).map((x) => x.f);
}

/**
 * Last time's portion as the row says it. Drona's labels often carry their own
 * count ("1 roti", "100 g"), so a plain "quantity label" read "2 1 roti":
 *   2 x "roti"  -> "2 roti"      1 x "100 g"  -> "100 g"
 *   2 x "1 roti" -> "2 roti"     2 x "100 g"  -> "2 x 100 g"
 */
export function portionText(mark: Pick<YourFoodMark, 'quantity' | 'servingLabel'>): string {
  const q = Math.round(mark.quantity * 100) / 100;
  const label = mark.servingLabel.trim();
  if (!/^\d/.test(label)) return `${q} ${label}`;
  if (q === 1) return label;
  if (/^1\s+\D/.test(label)) return `${q} ${label.replace(/^1\s+/, '')}`;
  return `${q} x ${label}`;
}

/**
 * One list: your matches first, then the catalog without the foods already
 * shown as yours (same catalog id, or the same name once folded).
 */
export function mergeYourFoods<T extends { id?: string | null; name: string }>(
  mine: YourFood[],
  catalog: T[],
): (YourFood | T)[] {
  const ids = new Set(mine.flatMap((f) => f.ids));
  const keys = new Set(mine.map((f) => f.key));
  return [
    ...mine,
    ...catalog.filter((c) => !(c.id && ids.has(c.id)) && !keys.has(yourFoodKey(c.name))),
  ];
}
