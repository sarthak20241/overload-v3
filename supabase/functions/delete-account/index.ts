import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

// Auth model: same as ai-coach. Supabase's third-party Clerk integration
// doesn't extend to Edge Function gateway verify_jwt — Clerk JWTs that work
// fine for PostgREST get rejected at the function gateway. We deploy with
// `verify_jwt: false` and verify the Clerk JWT ourselves via Clerk's JWKS.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLERK_SECRET_KEY = Deno.env.get("CLERK_SECRET_KEY");
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER") ?? "https://integral-cattle-75.clerk.accounts.dev";

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

async function verifyClerkJwt(authHeader: string | null): Promise<{ sub: string | null; reason: string }> {
  if (!authHeader) return { sub: null, reason: "no auth header" };
  if (!authHeader.startsWith("Bearer ")) return { sub: null, reason: "no Bearer prefix" };
  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: CLERK_ISSUER });
    if (typeof payload.sub !== "string") return { sub: null, reason: "sub claim missing" };
    return { sub: payload.sub, reason: "ok" };
  } catch (e) {
    return { sub: null, reason: `verify failed: ${(e as Error).message}` };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const auth = await verifyClerkJwt(req.headers.get("Authorization"));
  if (!auth.sub) {
    return jsonResponse({ error: "Unauthorized", debug: auth.reason }, 401);
  }
  const userId = auth.sub;

  // All Supabase rows wiped in one transaction via the SECURITY DEFINER RPC.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: rpcErr } = await admin.rpc("delete_user_data", { p_user_id: userId });
  if (rpcErr) {
    return jsonResponse(
      { error: "Database deletion failed", details: rpcErr.message },
      500,
    );
  }

  // Tell Clerk to delete the identity. Best-effort: the user's data is already
  // gone on our side, so we don't fail the request if Clerk hiccups — the
  // client will sign out either way and the orphan can be cleaned up manually.
  let clerkDeleted = false;
  if (CLERK_SECRET_KEY) {
    try {
      const r = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
      });
      clerkDeleted = r.ok;
    } catch {
      // swallow
    }
  }

  return jsonResponse({ ok: true, clerkDeleted });
});
