/**
 * Remove a meal row that has no food left in it.
 *
 * An empty meal row still counts as a logged day for the streak, so every
 * path that can empty a meal (delete a line, Undo an add, move a line to
 * another section, roll back a failed add) takes the row with it.
 *
 * The database does the check and the delete in one locked step
 * (delete_meal_if_empty, migration 20261018120000). Done as two requests, a
 * line another device added between "count" and "delete" was deleted with the
 * meal, because meal_entries cascades on meal delete.
 *
 * Until that migration is live the RPC does not exist; then this falls back
 * to the old two-step path, so the app works before and after it lands. Any
 * other RPC failure does nothing: a leftover empty row is the worst case, and
 * the unsafe path is never the answer to a real error.
 *
 * Only a type import, so Deno tests it with a fake client:
 * deno test --allow-all lib/mealCleanup.test.ts
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** PostgREST PGRST202: the RPC is not in its schema cache, i.e. the migration
 *  is not live. Not Postgres 42883: from a deployed function that means its
 *  body is broken (a missing helper), a real error, and the unsafe path is
 *  never the answer to one. */
const MISSING_FUNCTION = new Set(['PGRST202']);

export async function deleteMealIfEmpty(supabase: SupabaseClient, mealId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_meal_if_empty', { p_meal_id: mealId });
  if (!error) return;
  if (!MISSING_FUNCTION.has(String((error as { code?: string }).code ?? ''))) {
    // Safe to stop, but a meal left behind still counts as a logged day for
    // the streak, so leave a trace to find it by.
    console.warn('delete_meal_if_empty failed; the empty meal row stays', mealId, error);
    return;
  }
  const { count, error: countError } = await supabase
    .from('meal_entries').select('id', { count: 'exact', head: true }).eq('meal_id', mealId);
  // A failed count is not "empty": never delete on a guess.
  if (!countError && count === 0) await supabase.from('meals').delete().eq('id', mealId);
}
