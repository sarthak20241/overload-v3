import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { VOICE_LIMITS } from "../_shared/aiLimits.ts";
import { CLEANUP_MODEL, haikuCleanup } from "./cleanup.ts";
import { handleTranscribe } from "./handler.ts";
import { pickProvider } from "./stt.ts";

// Voice input for the food box and Drona chat. The rules are in handler.ts;
// this file wires them to Clerk, Supabase and the speech engine.
//
// Secrets:
//   OPENAI_API_KEY     the speech engine's key (required; without it every
//                      call is 503 not_configured)
//   STT_PROVIDER       optional, default "openai"
//   STT_MODEL          optional, default "gpt-transcribe"
//   STT_LANGUAGES      optional ISO-639-1 hints, e.g. "en,hi". Unset lets
//                      the engine detect, which is the default until the
//                      engine comparison (scripts/voice-eval) says otherwise
//   ANTHROPIC_API_KEY  already set for ai-coach; turns on the chat cleanup
//
// Auth model: same as ai-coach. The gateway rejects Clerk JWTs, so
// config.toml sets verify_jwt = false and the JWT is verified here.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Required, no fallback: a wrong issuer would accept another Clerk
// instance's JWTs (see ai-coach/index.ts).
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER");
if (!CLERK_ISSUER) throw new Error("CLERK_ISSUER env var is required (the Clerk Frontend API URL).");

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));
const provider = pickProvider(Deno.env.toObject());
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const userClient = (authHeader: string) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** One token_usage_log row, best effort, never the text. */
function logUsage(rec: {
  pipeline: string;
  provider: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  status: "success" | "error";
  metadata?: Record<string, unknown>;
}) {
  const p = Promise.resolve(admin.rpc("log_token_usage", {
    p_pipeline: rec.pipeline,
    p_provider: rec.provider,
    p_model: rec.model,
    p_input_tokens: rec.input_tokens ?? 0,
    p_output_tokens: rec.output_tokens ?? 0,
    p_cache_read_tokens: 0,
    p_cache_creation_tokens: 0,
    p_metadata: rec.metadata ?? null,
    p_latency_ms: rec.latency_ms ?? null,
    p_status: rec.status,
    p_error_message: null,
  })).then(({ error }) => {
    if (error) console.log("[transcribe] log_token_usage error (swallowed):", (error.message ?? "").slice(0, 200));
  }, () => {});
  // Let the response go out while the row is written.
  (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(p);
}

Deno.serve(async (req) => {
  let userId: string | null = null;
  return await handleTranscribe(req, {
    verify: async (authHeader) => {
      if (!authHeader?.startsWith("Bearer ")) return { error: "no Bearer token" };
      try {
        const { payload } = await jwtVerify(authHeader.slice(7), JWKS, { issuer: CLERK_ISSUER });
        if (typeof payload.sub !== "string") return { error: "sub claim missing" };
        userId = payload.sub;
        return { sub: payload.sub };
      } catch (e) {
        // jose's own words, so the app's expired-token retry
        // (lib/authRetry.ts) sees `"exp" claim timestamp check failed`.
        return { error: `verify failed: ${(e as Error).message}` };
      }
    },
    access: async (authHeader) => {
      const { data, error } = await userClient(authHeader).rpc("get_coach_access_status");
      if (error) return { error: error.message ?? "access rpc failed" };
      return (data ?? {}) as { state?: string; ai_blocked?: boolean };
    },
    reserve: async (authHeader, free) => {
      const { data, error } = await userClient(authHeader).rpc("try_reserve_voice_slot", {
        p_burst: VOICE_LIMITS.burst,
        p_burst_seconds: VOICE_LIMITS.burstWindowSeconds,
        p_day_cap: free ? VOICE_LIMITS.freeDay : VOICE_LIMITS.paidDay,
      });
      if (error) return { error: error.message ?? "reserve failed" };
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (row?.inserted === true && row.slot_id != null) return { ok: true, slotId: Number(row.slot_id) };
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Number(row?.retry_after_seconds ?? 0) || 1),
        reason: row?.reason === "day_cap" ? "day_cap" : "burst",
      };
    },
    userFoods: async (authHeader) => {
      // RLS scopes both reads to the caller. Names only.
      const c = userClient(authHeader);
      const [foods, meals] = await Promise.all([
        c.from("user_food_cache").select("food_name").order("last_logged_at", { ascending: false }).limit(40),
        c.from("saved_meals").select("name").order("created_at", { ascending: false }).limit(20),
      ]);
      return [
        ...((foods.data ?? []) as { food_name?: string }[]).map((r) => r.food_name ?? ""),
        ...((meals.data ?? []) as { name?: string }[]).map((r) => r.name ?? ""),
      ].filter(Boolean);
    },
    release: async (uid, slotId) => {
      // Service role, with the id from the verified JWT: this RPC is not
      // granted to clients, or they could hand their own slots back.
      const { data, error } = await admin.rpc("release_voice_slot", { p_user_id: uid, p_slot_id: slotId });
      if (error) throw new Error(error.message ?? "release failed");
      return data === true;
    },
    provider: provider
      ? {
        ...provider,
        transcribe: async (clip, opts) => {
          const t0 = Date.now();
          const out = await provider.transcribe(clip, opts);
          logUsage({
            pipeline: "voice_transcribe",
            provider: provider.name,
            model: out.ok ? out.model : provider.name,
            input_tokens: out.ok ? out.usage?.input_tokens : 0,
            output_tokens: out.ok ? out.usage?.output_tokens : 0,
            latency_ms: Date.now() - t0,
            status: out.ok ? "success" : "error",
            // Billed by the minute: the seconds are the cost.
            metadata: { audio_seconds: clip.seconds, purpose: opts.purpose, ...(userId ? { user_id: userId } : {}) },
          });
          return out;
        },
      }
      : null,
    cleanup: ANTHROPIC_API_KEY
      ? haikuCleanup({
        apiKey: ANTHROPIC_API_KEY,
        onUsage: (u) =>
          logUsage({
            pipeline: "voice_cleanup",
            provider: "anthropic",
            model: CLEANUP_MODEL,
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            latency_ms: u.latency_ms,
            status: u.ok ? "success" : "error",
            metadata: userId ? { user_id: userId } : undefined,
          }),
      })
      : null,
    log: (e) => console.log("[transcribe]", JSON.stringify(e)),
  });
});
