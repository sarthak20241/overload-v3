/**
 * Version skew helpers: the app can ship before the migration that adds a
 * column, so a read or write that names the new column must fall back without
 * it. Pure on purpose (no imports), so `deno test lib/missingColumn.test.ts`
 * reaches it.
 */

/**
 * Is this error a database that does not have one of `cols` yet? 42703 is
 * Postgres "undefined column" (a select); PGRST204 is PostgREST "column not in
 * the schema cache" (an insert). Only when the message names one of them, so
 * an unrelated failure is never swallowed as a missing column.
 */
export function missingColumn(err: unknown, cols: readonly string[]): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e || (e.code !== '42703' && e.code !== 'PGRST204')) return false;
  const msg = e.message ?? '';
  return cols.some((c) => msg.includes(c));
}

/**
 * Is this error a database that does not have `table` yet? 42P01 is Postgres
 * "undefined table"; PGRST205 is PostgREST "table not in the schema cache",
 * which is also what a table created without `notify pgrst, 'reload schema'`
 * answers. Only when the message names the table, so an unrelated failure is
 * never swallowed as a missing table.
 */
export function missingTable(err: unknown, table: string): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e || (e.code !== '42P01' && e.code !== 'PGRST205')) return false;
  return (e.message ?? '').includes(table);
}

/** The same rows with `cols` removed, for the retry on an older database. */
export function withoutColumns<T extends Record<string, unknown>>(rows: T[], cols: readonly string[]): T[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const c of cols) delete out[c];
    return out as T;
  });
}
