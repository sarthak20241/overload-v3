// Pure: no imports. Unit-tested in retried.test.ts.

/**
 * Retry a PostgREST call that failed TRANSIENTLY. The API layer answers the
 * odd plain read with a 504 in well under its own timeout (seen twice on
 * 2026-09-13 on single-row reads, with nothing in the Postgres log), and one
 * bad answer used to sink the whole midnight run. Only a 5xx or a request that
 * never got a status is retried: a 4xx (bad query, constraint, RLS) will fail
 * the same way again, so it fails fast. Every call retried here is a read, an
 * idempotent upsert, or the idempotent prune, so a repeat is safe.
 */
export async function retried<T extends { error: { message: string } | null; status?: number }>(
  call: () => PromiseLike<T>,
  attempts = 3,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  const transient = (r: T) => !!r.error && (!r.status || r.status >= 500);
  let result = await call();
  for (let i = 1; i < attempts && transient(result); i += 1) {
    await wait(400 * i * i);
    result = await call();
  }
  return result;
}
