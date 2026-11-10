import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createRemoteJWKSet } from "npm:jose@5";
import { resourceMetadata, verifyAccessToken, wwwAuthenticate } from "./auth.ts";
import { handleMessage, parseBody } from "./protocol.ts";
import { TOOLS } from "./tools.ts";

// The Overload MCP server: lets a user's own ChatGPT or Claude read their
// Overload data and log food and workouts. Plan: .planning/mcp-tools-plan.md
//
//   GET  .../mcp/.well-known/oauth-protected-resource  -> who signs users in
//   POST .../mcp                                        -> one JSON-RPC message
//
// Auth: config.toml sets verify_jwt = false (the gateway would reject Clerk
// tokens), and auth.ts checks the Clerk OAuth token here.

// Required, no fallback: a wrong issuer would accept another Clerk instance.
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER");
if (!CLERK_ISSUER) throw new Error("CLERK_ISSUER env var is required (the Clerk Frontend API URL).");

// The public URL users paste into ChatGPT or Claude. mcp.tryoverload.app is a
// Vercel forwarder to this function (mcp-proxy/). It must match the MCP URL
// entered in the Clerk Dashboard exactly, since Clerk writes it into the
// token's `aud`. MCP_RESOURCE_URL overrides it for a local run.
const RESOURCE = (Deno.env.get("MCP_RESOURCE_URL") ?? "https://mcp.tryoverload.app").replace(/\/+$/, "");
const METADATA_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "www-authenticate",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname;

  if (req.method === "GET" && path.endsWith("/.well-known/oauth-protected-resource")) {
    return json(resourceMetadata(RESOURCE, CLERK_ISSUER));
  }
  // Sign-in comes first for every method: a client with no token must get the
  // 401 that starts sign-in, on GET too (Clerk's server check asks for it).
  const auth = await verifyAccessToken(req.headers.get("Authorization"), {
    jwks: JWKS,
    issuer: CLERK_ISSUER,
    // A client may send the resource as typed or with a trailing slash (URL
    // normalizing turns https://host into https://host/), and Clerk copies it
    // into aud. Both name this server.
    audience: [RESOURCE, `${RESOURCE}/`],
  });
  if (!auth.ok) {
    console.log(`[mcp] 401: ${auth.reason}`);
    const hadToken = !!req.headers.get("Authorization");
    return json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": wwwAuthenticate(METADATA_URL, hadToken ? "invalid_token" : undefined),
    });
  }

  // No server-sent event stream: a signed-in client may only POST.
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });

  const parsed = parseBody(await req.text());
  if ("reply" in parsed) return json(parsed.reply, 400);

  const reply = await handleMessage(parsed.msg, TOOLS, { userId: auth.userId, email: auth.email });
  if (!reply) return new Response(null, { status: 202, headers: CORS });
  return json(reply);
});
