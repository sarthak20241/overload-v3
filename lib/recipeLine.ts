// A dish built from its parts (server: ai-coach/recipe.ts, Precise step 5)
// has source "recipe". Migration 20261107120000 (step 4) lets
// meal_entries.source hold it, together with the origin columns. A database
// without that migration has neither: the app's fallback write (no origin
// columns) must then also write the dish as an estimate, or the source check
// (0114) refuses the whole insert.

/** The rows for a database that predates the origin columns: source
 *  "recipe" written as "estimate". Every other row is returned as it is. */
export function sourceBeforeOrigin<T extends { source?: unknown }>(rows: T[]): T[] {
  return rows.map((r) => (r.source === 'recipe' ? { ...r, source: 'estimate' } : r));
}
