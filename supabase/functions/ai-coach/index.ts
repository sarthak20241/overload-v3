import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Auth model: this function relies on Supabase's default JWT verification at
// the gateway. With Clerk configured as a third-party auth provider, only
// requests carrying a valid Clerk JWT reach this handler. The `sub` claim
// (Clerk user id) is read from the JWT for rate-limiting and audit.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Rate limit: per-user sliding window. Generous enough for normal use, tight
// enough that a leaked URL can't burn the Anthropic budget.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 30;

const SYSTEM_PROMPT = `You are an expert AI fitness coach inside a gym workout tracking app called OVERLOAD. You help users with:
- Creating personalized workout routines
- Building multi-day training programs
- Answering questions about training, nutrition, recovery
- Providing form tips and exercise alternatives

When generating workouts, respond with structured JSON when the user asks you to "create", "generate", or "build" a workout or plan. Use this format:
{
  "type": "workout",
  "name": "Workout Name",
  "exercises": [
    { "name": "Exercise Name", "sets": 4, "reps": "8-10", "rest": "90s" }
  ]
}

For workout plans (multiple workouts), use:
{
  "type": "plan",
  "workouts": [
    { "name": "Day 1 - Push", "exercises": [...] }
  ]
}

For regular conversation, just respond naturally with helpful advice. Use markdown formatting for readability. Keep responses concise but informative.`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Decode a JWT payload without verification. Safe here because the Edge
// Function gateway has already verified the signature and rejected anything
// invalid before the request reaches us.
function decodeJwtSub(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  }

  // Identity: derive from the JWT the gateway already verified.
  const userId = decodeJwtSub(req.headers.get("Authorization"));
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Rate limit: count this user's recent requests in a sliding window.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const sinceIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_coach_rate_limit")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("request_at", sinceIso);

  if (countErr) {
    return jsonResponse({ error: "Rate limit check failed" }, 500);
  }
  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    return jsonResponse(
      { error: "Rate limit exceeded", retry_after_seconds: 60 * 60 },
      429
    );
  }

  // Log this request before the upstream call so a stuck Anthropic request
  // can't be replayed indefinitely while a previous one is still in flight.
  const { error: logErr } = await admin
    .from("ai_coach_rate_limit")
    .insert({ user_id: userId });
  if (logErr) {
    return jsonResponse({ error: "Rate limit log failed" }, 500);
  }

  try {
    const { messages } = await req.json();

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
        system: SYSTEM_PROMPT,
        messages: messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return jsonResponse(
        { error: `Anthropic API error: ${response.status}`, details: errorText },
        502
      );
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "Sorry, I couldn't generate a response.";
    return jsonResponse({ response: text });
  } catch (err) {
    return jsonResponse({ error: "Internal error", details: String(err) }, 500);
  }
});
