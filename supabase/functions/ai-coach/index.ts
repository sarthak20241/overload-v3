import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { buildSystemPrompt } from "./prompt.ts";

// Auth model: Supabase third-party Clerk auth covers PostgREST/Realtime but
// NOT Edge Functions. We deploy verify_jwt:false and verify the Clerk JWT
// ourselves against Clerk's JWKS. The same JWT is then forwarded to
// PostgREST when we call user-data RPCs — RLS gates everything.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER") ?? "https://integral-cattle-75.clerk.accounts.dev";

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const PREVIEW_MAX_CHARS = 200;
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_ITERATIONS = 5;
const ANTHROPIC_MAX_TOKENS = 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

// ── Trace shape ─────────────────────────────────────────────────────────────
type CoachTraceStatus =
  | "success"
  | "unauthorized"
  | "rate_limited"
  | "anthropic_error"
  | "internal_error"
  | "bad_request";

interface CoachTrace {
  user_id: string | null;
  status: CoachTraceStatus;
  http_status: number;
  error_message: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  message_count: number | null;
  has_user_context: boolean | null;
  retrieved_doc_ids: string[];
  citation_ids: string[];
  tool_calls: string[];
  last_user_message_preview: string | null;
  response_preview: string | null;
}

function newTrace(): CoachTrace {
  return {
    user_id: null,
    status: "internal_error",
    http_status: 500,
    error_message: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    message_count: null,
    has_user_context: null,
    retrieved_doc_ids: [],
    citation_ids: [],
    tool_calls: [],
    last_user_message_preview: null,
    response_preview: null,
  };
}

function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) : text;
}

async function recordTrace(
  admin: SupabaseClient,
  trace: CoachTrace,
  startedAtMs: number,
): Promise<void> {
  try {
    await admin.from("coach_traces").insert({
      ...trace,
      latency_ms: Date.now() - startedAtMs,
    });
  } catch (e) {
    console.log("[ai-coach] trace insert failed:", String(e));
  }
}

// ── Tool execution ──────────────────────────────────────────────────────────
// Maps Anthropic tool_use blocks → Postgres RPC calls via the user's JWT
// client (so every read is RLS-gated to the authenticated user).
async function executeTool(
  userClient: SupabaseClient,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const rpcMap: Record<string, { fn: string; args: (i: Record<string, unknown>) => Record<string, unknown> }> = {
    coach_get_exercise_history: {
      fn: "coach_get_exercise_history",
      args: (i) => ({ p_exercise_name: String(i.exercise_name ?? ""), p_limit: Number(i.limit ?? 10) }),
    },
    coach_get_recent_workouts: {
      fn: "coach_get_recent_workouts",
      args: (i) => ({ p_limit: Number(i.limit ?? 10), p_days_back: Number(i.days_back ?? 90) }),
    },
    coach_get_workout_detail: {
      fn: "coach_get_workout_detail",
      args: (i) => ({ p_workout_id: String(i.workout_id ?? "") }),
    },
    coach_get_muscle_volume_series: {
      fn: "coach_get_muscle_volume_series",
      args: (i) => ({ p_muscle: String(i.muscle ?? ""), p_weeks: Number(i.weeks ?? 8) }),
    },
    coach_query_sql: {
      fn: "coach_query_sql",
      args: (i) => ({ p_sql: String(i.sql ?? "") }),
    },
  };

  const tool = rpcMap[name];
  if (!tool) return { error: `unknown tool: ${name}` };

  try {
    const { data, error } = await userClient.rpc(tool.fn, tool.args(input));
    if (error) return { error: error.message };
    return data ?? null;
  } catch (e) {
    return { error: String(e) };
  }
}

// ── Anthropic API ───────────────────────────────────────────────────────────
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

async function callAnthropic(
  payload: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }
  return { ok: true, data: await response.json() };
}

// ── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const startedAtMs = Date.now();
  const trace = newTrace();
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const respond = async (body: unknown, status: number) => {
    trace.http_status = status;
    await recordTrace(admin, trace, startedAtMs);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  };

  if (!ANTHROPIC_API_KEY) {
    trace.status = "internal_error";
    trace.error_message = "ANTHROPIC_API_KEY not configured";
    return respond({ error: trace.error_message }, 500);
  }

  // 1. Verify Clerk JWT
  const authHeader = req.headers.get("Authorization");
  const auth = await verifyClerkJwt(authHeader);
  console.log("[ai-coach] auth", JSON.stringify({ has_header: !!authHeader, reason: auth.reason }));

  if (!auth.sub) {
    trace.status = "unauthorized";
    trace.error_message = auth.reason;
    return respond({ error: "Unauthorized", debug: auth.reason }, 401);
  }
  trace.user_id = auth.sub;
  const userId = auth.sub;

  // 2. Rate limit
  const sinceIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_coach_rate_limit")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("request_at", sinceIso);

  if (countErr) {
    trace.status = "internal_error";
    trace.error_message = `rate_limit_check_failed: ${countErr.message}`;
    return respond({ error: "Rate limit check failed" }, 500);
  }
  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    trace.status = "rate_limited";
    trace.error_message = `count=${count} cap=${RATE_LIMIT_MAX}`;
    return respond({ error: "Rate limit exceeded", retry_after_seconds: 60 * 60 }, 429);
  }

  const { error: logErr } = await admin
    .from("ai_coach_rate_limit")
    .insert({ user_id: userId });
  if (logErr) {
    trace.status = "internal_error";
    trace.error_message = `rate_limit_log_failed: ${logErr.message}`;
    return respond({ error: "Rate limit log failed" }, 500);
  }

  // 3. User-JWT client for both user_context fetch and tool execution.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader! } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 4. Fetch pre-computed user_context (tier 1).
  let userContext: unknown = null;
  try {
    const { data, error } = await userClient.rpc("get_user_coach_context");
    if (!error) userContext = data ?? null;
    else console.log("[ai-coach] user-context RPC error:", error.message);
  } catch (e) {
    console.log("[ai-coach] user-context fetch threw:", String(e));
  }
  trace.has_user_context = userContext !== null;

  // 5. Parse messages
  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    trace.status = "bad_request";
    trace.error_message = "invalid JSON body";
    return respond({ error: "Invalid JSON body" }, 400);
  }

  const incomingMessages = body.messages;
  if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) {
    trace.status = "bad_request";
    trace.error_message = "messages must be a non-empty array";
    return respond({ error: trace.error_message }, 400);
  }

  trace.message_count = incomingMessages.length;
  const lastUser = [...incomingMessages].reverse().find((m) => m.role === "user");
  trace.last_user_message_preview = preview(lastUser?.content ?? null);

  const { system, tools } = buildSystemPrompt({ userContext });
  trace.model = MODEL;

  // 6. Tool-use loop. Each iteration:
  //    - call Anthropic
  //    - if it asked for tools, execute them and append results, loop again
  //    - otherwise, return final text
  // Token usage from EVERY iteration is summed into the trace so cost
  // attribution covers the whole turn, not just the final call.
  let conversation: AnthropicMessage[] = incomingMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let finalText: string | null = null;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const apiResult = await callAnthropic({
        model: MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        tools,
        messages: conversation,
      });

      if (!apiResult.ok) {
        trace.status = "anthropic_error";
        trace.error_message = `anthropic_${apiResult.status}: ${preview(apiResult.body) ?? ""}`;
        return respond(
          { error: `Anthropic API error: ${apiResult.status}`, details: apiResult.body },
          502,
        );
      }

      const data = apiResult.data;
      const usage = data.usage ?? {};
      totalInput += usage.input_tokens ?? 0;
      totalOutput += usage.output_tokens ?? 0;
      totalCacheCreation += usage.cache_creation_input_tokens ?? 0;
      totalCacheRead += usage.cache_read_input_tokens ?? 0;

      const stopReason = data.stop_reason;
      const contentBlocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = data.content ?? [];

      // Final response: no more tool calls. Extract text and exit loop.
      if (stopReason !== "tool_use") {
        finalText = contentBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
          .trim() || "Sorry, I couldn't generate a response.";
        break;
      }

      // Model asked for one or more tool calls. Execute each, append both
      // the assistant turn (containing the tool_use blocks) and a user turn
      // containing the tool_result blocks. Loop again.
      const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
      const toolResults = await Promise.all(
        toolUses.map(async (block) => {
          trace.tool_calls.push(block.name ?? "<unknown>");
          const result = await executeTool(userClient, block.name ?? "", block.input ?? {});
          return {
            type: "tool_result" as const,
            tool_use_id: block.id ?? "",
            content: JSON.stringify(result),
          };
        }),
      );

      conversation.push({ role: "assistant", content: contentBlocks });
      conversation.push({ role: "user", content: toolResults });

      // Last iteration safety: if we'd loop forever, break with whatever
      // intermediate text the model produced (or a fallback).
      if (iter === MAX_TOOL_ITERATIONS - 1) {
        finalText = contentBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
          .trim() || "I gathered some data but hit the tool-call limit before giving you a final answer. Try asking the question more specifically.";
        break;
      }
    }
  } catch (err) {
    trace.status = "internal_error";
    trace.error_message = `tool_loop_threw: ${String(err)}`;
    return respond({ error: "Internal error", details: String(err) }, 500);
  }

  trace.status = "success";
  trace.input_tokens = totalInput || null;
  trace.output_tokens = totalOutput || null;
  trace.cache_creation_input_tokens = totalCacheCreation || null;
  trace.cache_read_input_tokens = totalCacheRead || null;
  trace.response_preview = preview(finalText);

  return respond(
    {
      response: finalText,
      usage: {
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cache_creation_input_tokens: totalCacheCreation,
        cache_read_input_tokens: totalCacheRead,
      },
      tool_calls: trace.tool_calls,
    },
    200,
  );
});
