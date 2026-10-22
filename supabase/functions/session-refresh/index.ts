import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { type ClerkSession, handleRefresh } from "./refresh.ts";

// Mints a one-time Clerk sign-in ticket so the app can replace a session
// before Clerk's fixed 7-day lifetime ends it. The rules for who may get one
// live in refresh.ts; this file only wires them to Clerk.
//
// Auth model: same as ai-coach and delete-account. The gateway's verify_jwt
// rejects Clerk JWTs, so config.toml sets verify_jwt = false and the Clerk JWT
// is verified here against Clerk's JWKS.

const CLERK_SECRET_KEY = Deno.env.get("CLERK_SECRET_KEY");
// Required, and no fallback: see ai-coach/index.ts. A wrong issuer would let
// this accept JWTs from another Clerk instance, and here that mints sign-ins.
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER");
if (!CLERK_ISSUER) {
  throw new Error("CLERK_ISSUER env var is required (the Clerk Frontend API URL).");
}

const CLERK_API = "https://api.clerk.com/v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

async function verifyClerkJwt(
  authHeader: string | null,
): Promise<{ sub: string; sid: string } | { error: string }> {
  if (!authHeader?.startsWith("Bearer ")) return { error: "no Bearer token" };
  try {
    const { payload } = await jwtVerify(authHeader.slice(7), JWKS, { issuer: CLERK_ISSUER });
    if (typeof payload.sub !== "string") return { error: "sub claim missing" };
    if (typeof payload.sid !== "string") return { error: "sid claim missing" };
    return { sub: payload.sub, sid: payload.sid };
  } catch (e) {
    return { error: `verify failed: ${(e as Error).message}` };
  }
}

async function clerk(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (!CLERK_SECRET_KEY) {
    console.error("[session-refresh] CLERK_SECRET_KEY is not set");
    return jsonResponse({ error: "not_configured" }, 503);
  }

  try {
    const result = await handleRefresh({
      verify: () => verifyClerkJwt(req.headers.get("Authorization")),
      getSession: async (sid) => {
        const r = await clerk(`/sessions/${encodeURIComponent(sid)}`);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`get session: HTTP ${r.status}`);
        return (await r.json()) as ClerkSession;
      },
      mintTicket: async (userId, ttlSeconds) => {
        const r = await clerk("/sign_in_tokens", {
          method: "POST",
          body: JSON.stringify({ user_id: userId, expires_in_seconds: ttlSeconds }),
        });
        if (!r.ok) throw new Error(`mint ticket: HTTP ${r.status}`);
        const body = (await r.json()) as { token?: string };
        if (!body.token) throw new Error("mint ticket: no token in response");
        return body.token;
      },
      now: () => Date.now(),
    });
    console.log(
      "[session-refresh]",
      JSON.stringify({
        status: result.status,
        minted: "ticket" in result.body && !!result.body.ticket,
        reason: "reason" in result.body ? result.body.reason : "error" in result.body ? result.body.error : null,
        detail: "detail" in result ? result.detail : undefined,
      }),
    );
    return jsonResponse(result.body, result.status);
  } catch (e) {
    console.error("[session-refresh] failed:", (e as Error).message);
    return jsonResponse({ error: "clerk_unavailable" }, 502);
  }
});
