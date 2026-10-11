// The pipeline under test is Deno code, and some of its modules read the
// environment at import time (rerank.ts reads RERANK_TIMEOUT_MS through
// _shared/envInt.ts, which calls Deno.env.get). Under Node that throws before a
// single case runs. Map the one call they make onto process.env.
//
// Must be the FIRST import in run.ts: imports evaluate in order, and the
// pipeline modules read the env as they load.
const g = globalThis as { Deno?: unknown };
if (g.Deno === undefined) {
  g.Deno = { env: { get: (name: string) => process.env[name] } };
}

export {};
