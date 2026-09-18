/**
 * Numeric env override with a compiled-in default.
 *
 * Every model-call timeout across the edge functions reads its budget through
 * this, so a slow-upstream incident can be retuned from the Edge Function
 * secrets instead of a redeploy. Before this, all of them were literals and
 * changing one meant shipping a deploy.
 *
 * It lives in _shared because three functions need it (ai-coach, its rerank
 * hop, and form-check) and each had grown its own copy with subtly different
 * behaviour — ai-coach logged a bad value, the other two swallowed it. One
 * implementation means a fat-fingered secret is visible in the logs wherever
 * it happens, and means the parsing is testable at all: the helper used to sit
 * in ai-coach/index.ts, which no test can import without executing Deno.serve
 * and throwing on a missing CLERK_ISSUER.
 *
 * A missing, blank, non-numeric or non-positive value falls back to the
 * default, so a typo degrades to the shipped behaviour rather than a 0ms
 * abort that would fail every call.
 */
export interface EnvIntOptions {
  /** Treat an explicit "0" as a real value rather than rejecting it. For
   *  budgets where zero is a meaningful kill switch (SSE_HEARTBEAT_MS=0
   *  disables the keepalive) instead of a nonsense timeout. */
  allowZero?: boolean;
  /** Env reader, injectable so tests need not mutate the real environment.
   *  Defaults to Deno.env.get. */
  getEnv?: (name: string) => string | undefined;
  /** Log sink for a rejected value. Defaults to console.warn. */
  warn?: (msg: string) => void;
}

export function envInt(name: string, fallback: number, opts: EnvIntOptions = {}): number {
  const getEnv = opts.getEnv ?? ((n: string) => Deno.env.get(n));
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  const raw = getEnv(name);
  // Unset and empty are the same thing: nobody asked for an override. Silent,
  // because this is the normal case on every deploy that sets no secrets.
  if (raw === undefined || raw.trim() === "") return fallback;

  const n = Number(raw.trim());
  const floor = opts.allowZero ? 0 : 1;
  // Number() maps "" to 0 and " " to 0, both already handled above. It also
  // accepts "1e4" and "0x10", which are odd but unambiguous, so they pass.
  if (!Number.isFinite(n) || n < floor) {
    warn(
      `[envInt] ${name}="${raw}" is not a number >= ${floor} — using ${fallback}`,
    );
    return fallback;
  }
  // Floor rather than round: a fractional millisecond budget is meaningless,
  // and truncating never silently grants more than was asked for.
  return Math.floor(n);
}
