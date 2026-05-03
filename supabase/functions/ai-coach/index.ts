import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildSystemPrompt } from "./prompt.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Per-user-per-minute cap. Plenty for normal chat; defends against abuse.
const RATE_LIMIT_PER_MIN = 12;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  }

  // Forward the caller's Authorization header so RLS + RPC see the Clerk JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Rate limit. The RPC pulls the Clerk subject from the JWT — no client
  // input is trusted here.
  try {
    const { data: count, error } = await sb.rpc("check_coach_rate_limit", {
      cap: RATE_LIMIT_PER_MIN,
    });
    if (error) {
      // RPC failed — most commonly because RLS / Clerk JWT template isn't
      // wired up. Fail closed: better to surface than silently accept.
      return jsonResponse({ error: "Auth/RLS check failed", details: error.message }, 401);
    }
    if (typeof count === "number" && count > RATE_LIMIT_PER_MIN) {
      return jsonResponse({ error: "Rate limit exceeded. Try again in a minute." }, 429);
    }
  } catch (err) {
    return jsonResponse({ error: "Rate limit check failed", details: String(err) }, 500);
  }

  // User context — server-side fetch; client never sees the assembly.
  let userContext: unknown = null;
  try {
    const { data, error } = await sb.rpc("get_user_coach_context");
    if (!error) userContext = data ?? null;
  } catch {
    // Non-fatal: coach can still respond with core_principles only.
    userContext = null;
  }

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: "messages must be a non-empty array" }, 400);
  }

  const { system } = buildSystemPrompt({ userContext });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return jsonResponse(
        { error: `Anthropic API error: ${response.status}`, details: errorText },
        502,
      );
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "Sorry, I couldn't generate a response.";

    return jsonResponse({
      response: text,
      // Surface usage for cost attribution and debugging. Phase 2 will add
      // citations[] when retrieval lands.
      usage: data.usage ?? null,
    });
  } catch (err) {
    return jsonResponse({ error: "Internal error", details: String(err) }, 500);
  }
});
