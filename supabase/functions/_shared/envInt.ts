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

/**
 * Read `name` from the environment as a positive integer, falling back to
 * `fallback` when it is unset, blank, non-numeric, negative, or would floor to
 * zero. With `opts.allowZero`, an explicit `0` is returned as a kill switch;
 * a positive value that floors to zero is still rejected. Never returns a
 * value the caller did not ask for without warning about it first.
 */
export function envInt(name: string, fallback: number, opts: EnvIntOptions = {}): number {
  const getEnv = opts.getEnv ?? ((n: string) => Deno.env.get(n));
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  const raw = getEnv(name);
  // Unset and empty are the same thing: nobody asked for an override. Silent,
  // because this is the normal case on every deploy that sets no secrets.
  if (raw === undefined || raw.trim() === "") return fallback;

  // Number() maps "" to 0 and " " to 0, both already handled above. It also
  // accepts "1e4" and "0x10", which are odd but unambiguous, so they pass.
  const n = Number(raw.trim());
  // Floor rather than round: a fractional millisecond budget is meaningless,
  // and truncating never silently grants more than was asked for.
  const floored = Math.floor(n);

  // Two rules, kept separate because conflating them is what made 0.5 slip
  // through: only an EXPLICIT zero may yield zero, and any positive value has
  // to survive the floor as at least 1. Without the second rule a sub-integer
  // like SSE_HEARTBEAT_MS=0.5 passed the old `n >= 0` check and then floored
  // to 0 — silently disabling the heartbeat, which is both the opposite of
  // what the operator asked for and precisely the class of quiet failure this
  // helper exists to prevent.
  const valid = Number.isFinite(n) &&
    (n === 0 ? opts.allowZero === true : n > 0 && floored >= 1);
  if (!valid) {
    const expected = opts.allowZero ? "0, or a number >= 1" : "a number >= 1";
    warn(`[envInt] ${name}="${raw}" is not ${expected} — using ${fallback}`);
    return fallback;
  }
  return floored;
}

// Gate proof (reverted in the next commit): a PR touching an Edge Function
// must carry deploy:yes or deploy:no before it can merge.
