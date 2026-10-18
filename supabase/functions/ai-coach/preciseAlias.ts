/**
 * Precise aliases are per user (migration 20261018150000).
 *
 * An alias is a phrase that once led to a precise_cache row: the user's words
 * when a web lookup found the food under another name, or when Jev matched the
 * words to a cached row. An exact alias hit skips Jev, so it must only ever
 * come from the same user's own words. Other users' aliases still help: they
 * feed precise_cache_candidates' trigram search, which only proposes rows that
 * Jev then has to accept.
 *
 * precise_cache itself stays shared; only the shortcut from words to row is
 * personal.
 */
import type { PreciseCacheRow } from "./preciseCache.ts";

/** The slice of a service-role client this file uses, so tests can fake it. */
export interface AliasAdmin {
  rpc(fn: string, args: Record<string, unknown>): {
    maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
  from(table: string): {
    upsert(
      row: Record<string, unknown>,
      opts: { onConflict: string; ignoreDuplicates: boolean },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

export function preciseAliasStore(admin: AliasAdmin, userId: string) {
  return {
    /** The row this user's own phrase led to before, or null. An error (for
     *  example the migration not applied yet) is a miss. */
    async lookup(key: string): Promise<PreciseCacheRow | null> {
      const { data, error } = await admin
        .rpc("precise_cache_by_alias", { p_key: key, p_user: userId })
        .maybeSingle();
      return error ? null : (data as PreciseCacheRow | null) ?? null;
    },
    /** Record this user's phrase for a row. The first mapping of a phrase wins
     *  and is never repointed (per user). */
    async put(
      aliasKey: string,
      rowId: string,
      confidence: number | null,
      source: "jev" | "lookup" = "jev",
    ): Promise<void> {
      const { error } = await admin.from("precise_alias").upsert(
        { user_id: userId, alias_key: aliasKey, row_id: rowId, source, confidence },
        { onConflict: "user_id,alias_key", ignoreDuplicates: true },
      );
      if (error) console.log(`[parse_meal] precise_alias upsert failed: ${error.message}`);
    },
  };
}
