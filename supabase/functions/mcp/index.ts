import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet } from "npm:jose@5";
import { hasPro, limitHit, NOT_PRO, writeTrace } from "./access.ts";
import { resourceMetadata, verifyAccessToken, wwwAuthenticate } from "./auth.ts";
import { makeData } from "./data.ts";
import { FOOD_WRITE_TOOLS } from "./foodWrites.ts";
import { PLAN_TOOLS } from "./planTools.ts";
import { WORKOUT_WRITE_TOOLS } from "./workoutWrites.ts";
import { zoneOf } from "./days.ts";
import { handleMessage, parseBody } from "./protocol.ts";
import { type Ctx, TOOLS } from "./tools.ts";
import { makeWrites } from "./writes.ts";

const ALL_TOOLS = [...TOOLS, ...PLAN_TOOLS, ...FOOD_WRITE_TOOLS, ...WORKOUT_WRITE_TOOLS];

// The Overload MCP server: lets a user's own ChatGPT or Claude read their
// Overload data and plan, log food and workouts, and save routines. Plan: .planning/mcp-tools-plan.md
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

// Service role: the Clerk OAuth token is not a Supabase session, so RLS cannot
// see the user. data.ts filters every query to the token's user instead.
const ADMIN = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "www-authenticate",
};

function countFailed(e: unknown): number {
  console.error("[mcp] rate count failed:", e);
  return 0;
}

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
  // OpenAI's domain check for the ChatGPT directory: the token OpenAI shows on
  // platform.openai.com, served as plain text. Set it with
  // `supabase secrets set OPENAI_APPS_CHALLENGE=<token>`. No secret = 404.
  if (req.method === "GET" && path.endsWith("/.well-known/openai-apps-challenge")) {
    const token = Deno.env.get("OPENAI_APPS_CHALLENGE")?.trim();
    return token
      ? new Response(token, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } })
      : new Response("not found", { status: 404, headers: CORS });
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

  // The profile is read only when a tool runs (initialize and tools/list need
  // no database). gate() fills it in before the tool sees the context.
  const data = makeData(ADMIN);
  const ctx: Ctx = {
    userId: auth.userId, email: auth.email, data, writes: makeWrites(ADMIN), profile: null, tz: "UTC", now: new Date(),
  };
  const reply = await handleMessage(parsed.msg, ALL_TOOLS, ctx, {
    async gate(tool) {
      const [profile, trial, lastMinute, lastDay] = await Promise.all([
        data.profile(auth.userId),
        tool.free ? Promise.resolve(null) : data.trial(auth.userId),
        // A broken count never blocks the user: the limit is a guard, not a gate.
        data.recentCalls(auth.userId, 60).catch(countFailed),
        data.recentCalls(auth.userId, 86_400).catch(countFailed),
      ]);
      ctx.profile = profile;
      ctx.tz = zoneOf(profile?.timezone);
      // No profile row = never opened the app; mcp_traces could not record
      // the call either (its user_id references user_profiles).
      if (!profile) {
        return {
          status: "denied",
          result: { text: "No Overload account data yet. The user should open the Overload app once.", isError: true },
        };
      }
      if (!tool.free && !hasPro(profile, trial)) return { status: "denied", result: NOT_PRO };
      const hit = limitHit(lastMinute, lastDay);
      return hit ? { status: "limited", result: hit } : null;
    },
    async done(tool, status, ms) {
      if (!ctx.profile) return;
      await writeTrace(ADMIN, { userId: auth.userId, tool: tool.name, status, ms, clientId: auth.clientId,
        // The caller's app name (ChatGPT's and Claude's requests say who they
        // are here); a second way to tell them apart if the token has no id.
        userAgent: req.headers.get("User-Agent"),
      });
    },
  });
  if (!reply) return new Response(null, { status: 202, headers: CORS });
  return json(reply);
});
