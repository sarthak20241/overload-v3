import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Auth: relies on the gateway's JWT verification (Clerk via third-party auth).
// Body is empty — the user being deleted is whoever's JWT is on the request.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLERK_SECRET_KEY = Deno.env.get("CLERK_SECRET_KEY");

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

function decodeJwtSub(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const parts = authHeader.slice(7).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const userId = decodeJwtSub(req.headers.get("Authorization"));
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  // All Supabase rows wiped in one transaction via the SECURITY DEFINER RPC.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: rpcErr } = await admin.rpc("delete_user_data", { p_user_id: userId });
  if (rpcErr) {
    return jsonResponse(
      { error: "Database deletion failed", details: rpcErr.message },
      500
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
