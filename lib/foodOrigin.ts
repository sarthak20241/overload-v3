// Where a food line's numbers came from (Precise plan step 4). The rules live
// with the server so the app and the edge function never disagree. Pure (no
// app imports), so `deno test lib/foodOrigin.test.ts` reaches it.
import {
  type CopiedFrom,
  type FoodOrigin,
  originOf,
  parseRecipe,
  type RecipePart,
} from '../supabase/functions/_shared/foodOrigin';

export * from '../supabase/functions/_shared/foodOrigin';

/** The step 4 columns, dropped on a retry when the database predates them. */
export const ORIGIN_COLS = ['origin', 'copied_from', 'recipe'] as const;

/** meal_entries.origin / copied_from / recipe for one card line. The line's
 *  own origin wins (the server's, or the editor's user_typed); a re-logged
 *  line keeps the origin it had; anything else is read off the old fields,
 *  where "manual" alone is never the user's own numbers. */
export function originColumns(it: {
  origin?: FoodOrigin;
  copied_from?: CopiedFrom;
  recipe?: unknown;
  relog?: { origin?: string | null; source?: string | null };
  source?: string | null;
  food_id?: string | null;
  assumption?: string | null;
}): { origin: FoodOrigin; copied_from: CopiedFrom | null; recipe: RecipePart[] | null } {
  const relogOrigin = it.relog
    ? originOf({ origin: it.relog.origin, source: it.relog.source, food_id: it.food_id })
    : null;
  return {
    origin: it.origin ?? relogOrigin ?? originOf(it),
    copied_from: it.copied_from ?? (it.relog ? 'diary' : null),
    recipe: parseRecipe(it.recipe) ?? null,
  };
}
