import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";
import { buildSystemPrompt, TERMINAL_TOOLS } from "./prompt.ts";
import {
  type CandidateFood,
  type MealType,
  type OffProduct,
  type RecentFoodContext,
  runParseMeal,
} from "./parseMeal.ts";

// Auth model: Supabase third-party Clerk auth covers PostgREST/Realtime but
// NOT Edge Functions. We deploy verify_jwt:false and verify the Clerk JWT
// ourselves against Clerk's JWKS. The same JWT is then forwarded to
// PostgREST when we call user-data RPCs — RLS gates everything.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Required. The dev-tenant default we used to fall back to was a privacy bug
// in disguise: a fresh deploy that forgot to set CLERK_ISSUER would silently
// accept JWTs from someone else's Clerk instance. Fail at module load instead.
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER");
if (!CLERK_ISSUER) {
  throw new Error(
    "CLERK_ISSUER env var is required. Set it to your Clerk Frontend API URL " +
    "(e.g. https://your-tenant.clerk.accounts.dev) in the Edge Function secrets.",
  );
}

// Uniform daily cap for Drona access — applies to every paid tier AND every
// active trial. 30 messages per rolling 24h. Mirror this in
// get_coach_access_status() (v_daily_limit) so the client and server agree
// on what counts as "limit hit."
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const PREVIEW_MAX_CHARS = 200;
const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ITERATIONS = 5;
// Mode-aware token budgets. Chat replies stay tight (the rubric rewards
// concise coaching prose). Single-workout generation needs ~700–1500 tokens
// for the JSON tool input plus the 1-line intent. Plan generation easily
// pushes 2k+ tokens once you've got 4–6 days × 5–6 exercises with notes
// and a multi-sentence rationale. Without this split, plans silently fail
// when the model hits the cap mid-tool-emission → stop_reason flips to
// "max_tokens", the tool_use block is incomplete, and the client gets a
// `structured: null` payload.
const CHAT_MAX_TOKENS = 1024;
const GENERATE_WORKOUT_MAX_TOKENS = 2048;
const GENERATE_PLAN_MAX_TOKENS = 4096;
const ANTHROPIC_MAX_TOKENS = CHAT_MAX_TOKENS; // default; overridden per-mode
// Hard cap on a single Anthropic call. A hung upstream would otherwise pin
// function execution for the gateway's whole 60s budget. 30s comfortably
// covers Sonnet's worst-case latency at our max_tokens for plans (≤4k) plus
// streaming overhead; tighten if we see false positives in coach_traces.
const ANTHROPIC_TIMEOUT_MS = 30000;

// parse_meal mode (AI food logging). Haiku for speed + cost: this fires on
// every meal, and the catalog does the nutrition work — the model only
// matches and converts quantities. Own rate bucket (parse_meal_rate_limit),
// NOT the coach 30/24h window: meals happen several times a day and must not
// eat chat quota. Web search (tier 3 of the fallback ladder) is env-gated so
// it can be killed without a redeploy if costs or quality surprise us.
const PARSE_MEAL_MODEL = "claude-haiku-4-5";
const PARSE_MEAL_MAX_TOKENS = 1600;
const PARSE_RATE_LIMIT_MAX = 40;
const PARSE_WEB_SEARCH_ENABLED = Deno.env.get("PARSE_MEAL_WEB_SEARCH") !== "false";

// Retrieval (Phase 2.2). VOYAGE_API_KEY is optional — if missing, we skip
// retrieval and the coach falls back to user_context + core_principles. That
// degrades quality but doesn't break the function; useful for local/dev.
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY");
const RETRIEVAL_TOP_K = 8;
const RETRIEVAL_FLOOR = 0.40; // skip retrieval entirely if no candidate clears this cosine
const RETRIEVAL_QUERY_CAP = 4000; // max chars sent to Voyage per query
const VOYAGE_TIMEOUT_MS = 6000;

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
  retrieval_status: string | null;
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
    retrieval_status: null,
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

// ── Token usage logging (Phase 3 observability) ─────────────────────────────
// Writes one row to token_usage_log per Anthropic / Voyage call. Best-effort:
// any failure is swallowed so logging never breaks the coach turn.
async function logTokenUsage(
  admin: SupabaseClient,
  rec: {
    pipeline: string;
    provider: string;
    model: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    metadata?: Record<string, unknown>;
    latency_ms?: number;
    status?: "success" | "error";
    error_message?: string;
  },
): Promise<void> {
  try {
    // supabase-js v2 returns { data, error } and does NOT throw on
    // backend errors. The outer try/catch only catches network /
    // runtime failures. Inspect `error` so failed RPCs show up in logs
    // instead of being a mystery missing row.
    const { error } = await admin.rpc("log_token_usage", {
      p_pipeline: rec.pipeline,
      p_provider: rec.provider,
      p_model: rec.model,
      p_input_tokens: rec.input_tokens ?? 0,
      p_output_tokens: rec.output_tokens ?? 0,
      p_cache_read_tokens: rec.cache_read_tokens ?? 0,
      p_cache_creation_tokens: rec.cache_creation_tokens ?? 0,
      p_metadata: rec.metadata ?? null,
      p_latency_ms: rec.latency_ms ?? null,
      p_status: rec.status ?? "success",
      p_error_message: rec.error_message ?? null,
    });
    if (error) {
      console.log(
        "[ai-coach] logTokenUsage rpc error (swallowed):",
        `pipeline=${rec.pipeline} model=${rec.model} msg=${(error.message ?? String(error)).slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.log("[ai-coach] logTokenUsage threw (swallowed):", String(e).slice(0, 200));
  }
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

// ── Voyage query embedding (Phase 2.2) ──────────────────────────────────────
// Asymmetric retrieval: documents were ingested with input_type:"document",
// queries here use input_type:"query" so the same idea encoded as casual
// gym-speak lands close to its formal-language answer.
//
// Logs one token_usage_log row per call (Phase 3 observability). admin
// + userId are passed so the row carries provenance for the dashboard.
async function embedQuery(
  text: string,
  admin: SupabaseClient,
  userId: string,
): Promise<number[] | null> {
  if (!VOYAGE_API_KEY) {
    console.log("[ai-coach] VOYAGE_API_KEY missing — skipping retrieval");
    return null;
  }
  const trimmed = (text ?? "").trim().slice(0, RETRIEVAL_QUERY_CAP);
  if (trimmed.length === 0) return null;

  const startMs = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), VOYAGE_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: [trimmed],
        model: "voyage-3",
        input_type: "query",
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startMs;
    if (!res.ok) {
      void logTokenUsage(admin, {
        pipeline: "embed_query",
        provider: "voyage",
        model: "voyage-3",
        latency_ms: latencyMs,
        status: "error",
        error_message: `${res.status}`,
        metadata: { user_id: userId },
      });
      console.log(`[ai-coach] voyage query embed failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    void logTokenUsage(admin, {
      pipeline: "embed_query",
      provider: "voyage",
      model: "voyage-3",
      input_tokens: data.usage?.total_tokens ?? 0,
      latency_ms: latencyMs,
      status: "success",
      metadata: { user_id: userId, query_len: trimmed.length },
    });
    return data.data?.[0]?.embedding ?? null;
  } catch (e) {
    void logTokenUsage(admin, {
      pipeline: "embed_query",
      provider: "voyage",
      model: "voyage-3",
      latency_ms: Date.now() - startMs,
      status: "error",
      error_message: String(e).slice(0, 200),
      metadata: { user_id: userId },
    });
    console.log("[ai-coach] voyage query embed threw:", String(e));
    return null;
  } finally {
    clearTimeout(t);
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, body: await response.text() };
    }
    return { ok: true, data: await response.json() };
  } catch (e) {
    const isAbort = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      status: isAbort ? 504 : 502,
      body: isAbort
        ? `Anthropic call exceeded ${ANTHROPIC_TIMEOUT_MS}ms timeout`
        : `fetch threw: ${String(e)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── SSE helpers (Phase 2.6) ─────────────────────────────────────────────────
interface SSEWriter {
  write: (event: string, data: unknown) => void;
  close: () => void;
}

function createSSEResponse(): { response: Response; sse: SSEWriter } {
  let writer!: SSEWriter;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      writer = {
        write(event, data) {
          if (closed) return;
          const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        },
        close() {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        },
      };
    },
  });
  const response = new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    },
  });
  return { response, sse: writer };
}

// Parse Anthropic's SSE stream into typed events. Each `event:`+`data:` pair
// becomes one yielded JSON object.
async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const chunk of events) {
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) data += line.slice(6);
        else if (line.startsWith("data:")) data += line.slice(5);
      }
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch { /* ignore malformed */ }
    }
  }
}

// Streaming tool-use loop. Parses Anthropic's SSE, forwards text deltas to
// the client SSE writer, executes any tool_use blocks server-side, and loops
// until the model emits stop_reason != tool_use.
//
// Returns aggregated state (finalText for citation parsing, token totals).
// The trace's tool_calls is mutated in place across iterations.
interface StreamingLoopResult {
  finalText: string;
  totalInput: number;
  totalOutput: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  hitIterationCap: boolean;
  // Set when a terminal tool (generate_workout, generate_plan) fires — its
  // input becomes the structured response. The loop exits as soon as one
  // arrives; no further iterations.
  structured?: { name: string; input: Record<string, unknown> } | null;
}

async function runStreamingToolLoop(
  sse: SSEWriter,
  system: unknown,
  tools: unknown,
  initialConversation: AnthropicMessage[],
  userClient: SupabaseClient,
  trace: CoachTrace,
  forceTool: string | null,
  maxTokens: number,
): Promise<StreamingLoopResult> {
  const conversation = [...initialConversation];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let accumulatedText = "";
  let hitIterationCap = false;
  let structured: { name: string; input: Record<string, unknown> } | null = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    // forceTool ONLY on the first iteration. Once the terminal tool has
    // fired (or after a follow-up turn appended tool_results), the model
    // should be free to either chat or call another tool.
    const toolChoice = (forceTool && iter === 0)
      ? { type: "tool" as const, name: forceTool }
      : undefined;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        tools,
        messages: conversation,
        stream: true,
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
    }

    const blocks: any[] = []; // accumulated content blocks for this iteration
    let stopReason: string | null = null;

    for await (const event of parseAnthropicStream(response.body)) {
      const t = event.type;
      if (t === "message_start") {
        const u = event.message?.usage ?? {};
        totalInput += u.input_tokens ?? 0;
        totalCacheCreation += u.cache_creation_input_tokens ?? 0;
        totalCacheRead += u.cache_read_input_tokens ?? 0;
      } else if (t === "content_block_start") {
        blocks[event.index] = { ...event.content_block, _text: "", _input: "" };
      } else if (t === "content_block_delta") {
        const d = event.delta;
        const blk = blocks[event.index];
        if (!blk) continue;
        if (d.type === "text_delta") {
          blk._text += d.text;
          accumulatedText += d.text;
          sse.write("delta", { text: d.text });
        } else if (d.type === "input_json_delta") {
          blk._input += d.partial_json;
        }
      } else if (t === "content_block_stop") {
        const blk = blocks[event.index];
        if (!blk) continue;
        if (blk.type === "text") blk.text = blk._text;
        if (blk.type === "tool_use") {
          try { blk.input = blk._input ? JSON.parse(blk._input) : {}; }
          catch { blk.input = {}; }
        }
      } else if (t === "message_delta") {
        stopReason = event.delta?.stop_reason ?? null;
        const u = event.usage ?? {};
        totalOutput += u.output_tokens ?? 0;
      } else if (t === "error") {
        throw new Error(`Anthropic stream error: ${JSON.stringify(event.error ?? {})}`);
      }
    }

    // Strip our private accumulators before persisting in conversation history
    const cleanBlocks = blocks
      .filter(Boolean)
      .map((b: any) => {
        const { _text, _input, ...rest } = b;
        return rest;
      });

    if (stopReason !== "tool_use") {
      // Anthropic stopped without finishing a tool call. If it was a terminal
      // tool that got cut off by max_tokens, the partial JSON in `blk.input`
      // is unparseable and we'd otherwise silently return `structured: null`,
      // leaving the client confused. Surface the failure explicitly so the
      // UI can show a real error instead of bouncing back to the form.
      if (stopReason === "max_tokens") {
        const partialTerminal = cleanBlocks.find(
          (b: any) => b.type === "tool_use" && TERMINAL_TOOLS.has(b.name),
        );
        if (partialTerminal) {
          trace.tool_calls.push(`${partialTerminal.name}__truncated`);
          const msg = `Anthropic hit max_tokens (${maxTokens}) mid-${partialTerminal.name}. Increase the per-mode budget.`;
          sse.write("error", { error: msg, code: "tool_truncated" });
          throw new Error(msg);
        }
      }
      // Model is done — we've streamed all the text already.
      return { finalText: accumulatedText, totalInput, totalOutput, totalCacheCreation, totalCacheRead, hitIterationCap, structured };
    }

    // Tool calls. Separate terminal tools (generate_workout / generate_plan)
    // from regular data-fetch tools.
    const toolUses = cleanBlocks.filter((b: any) => b.type === "tool_use");
    const terminalUse = toolUses.find((b: any) => TERMINAL_TOOLS.has(b.name));

    if (terminalUse) {
      // Terminal tool: emit input as a structured SSE event and exit. Don't
      // try to "execute" it — its input IS the response.
      trace.tool_calls.push(terminalUse.name);
      structured = { name: terminalUse.name, input: terminalUse.input ?? {} };
      sse.write("structured", { name: terminalUse.name, input: terminalUse.input ?? {} });
      return { finalText: accumulatedText, totalInput, totalOutput, totalCacheCreation, totalCacheRead, hitIterationCap, structured };
    }

    if (toolUses.length > 0) {
      sse.write("status", { phase: "tool_use", tools: toolUses.map((t: any) => t.name) });
    }
    const toolResults = await Promise.all(
      toolUses.map(async (block: any) => {
        trace.tool_calls.push(block.name ?? "<unknown>");
        const result = await executeTool(userClient, block.name ?? "", block.input ?? {});
        return {
          type: "tool_result" as const,
          tool_use_id: block.id ?? "",
          content: JSON.stringify(result),
        };
      }),
    );

    conversation.push({ role: "assistant", content: cleanBlocks });
    conversation.push({ role: "user", content: toolResults });

    if (iter === MAX_TOOL_ITERATIONS - 1) {
      hitIterationCap = true;
      return { finalText: accumulatedText, totalInput, totalOutput, totalCacheCreation, totalCacheRead, hitIterationCap, structured };
    }
  }

  return { finalText: accumulatedText, totalInput, totalOutput, totalCacheCreation, totalCacheRead, hitIterationCap, structured };
}

// ── parse_meal mode (AI food logging) ───────────────────────────────────────
// Free text in, catalog-grounded meal entries out. The loop itself lives in
// parseMeal.ts (runtime-agnostic so the eval harness replays it); this
// function supplies the Supabase-backed deps, its own rate bucket, context
// gathering, and observability.

function escapeIlike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

// Tier 2 backfill: persist an OFF product as a GLOBAL foods row (service
// role => created_by null) so the next lookup for it is a tier-1 catalog
// hit for every user. ODbL guardrail: source 'off' keeps the row in the
// segregated partition. Races and name collisions with existing global rows
// both land in the unique-violation path and resolve to the existing row.
async function backfillOffFoodRow(admin: SupabaseClient, p: OffProduct): Promise<string | null> {
  try {
    const { data: inserted, error } = await admin
      .from("foods")
      .insert({
        name: p.name,
        brand: p.brand,
        barcode: p.barcode,
        base_unit: p.base_unit,
        kcal: p.kcal,
        protein_g: p.protein_g,
        carb_g: p.carb_g,
        fat_g: p.fat_g,
        fiber_g: p.fiber_g,
        sugar_g: p.sugar_g,
        sat_fat_g: p.sat_fat_g,
        sodium_mg: p.sodium_mg,
        source: "off",
        sources: ["off"],
        created_by: null,
        // Packaged products span every category; 'other' is the codebase
        // default (lib/foods.ts DEFAULT_FOOD_CATEGORY) and always CHECK-safe.
        food_category: "other",
      })
      .select("id")
      .single();

    let foodId: string | null = (inserted as { id?: string } | null)?.id ?? null;

    if (error) {
      // Unique violation on lower(name) for global rows (or a race): reuse
      // the existing row instead. Any other error => give up quietly; the
      // model still gets the OFF macros, just without a food_id.
      const { data: existing } = await admin
        .from("foods")
        .select("id")
        .is("created_by", null)
        .ilike("name", escapeIlike(p.name))
        .limit(1)
        .maybeSingle();
      foodId = (existing as { id?: string } | null)?.id ?? null;
      if (!foodId) {
        console.log("[parse_meal] OFF backfill failed:", error.message?.slice(0, 160));
        return null;
      }
    }

    if (foodId && p.serving) {
      // Best-effort: a label-derived default serving. Unique (food_id,
      // lower(label)) + single-default indexes make retries no-ops.
      const { error: servErr } = await admin.from("food_servings").insert({
        food_id: foodId,
        label: p.serving.label,
        grams: p.serving.grams,
        is_default: true,
        source: "off",
      });
      if (servErr && servErr.code !== "23505") {
        console.log("[parse_meal] serving backfill failed:", servErr.message?.slice(0, 120));
      }
    }
    return foodId;
  } catch (e) {
    console.log("[parse_meal] OFF backfill threw:", String(e).slice(0, 160));
    return null;
  }
}

async function searchCatalogWithServings(
  userClient: SupabaseClient,
  query: string,
): Promise<CandidateFood[]> {
  const { data, error } = await userClient.rpc("search_foods_ranked", { q: query, lim: 8 });
  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) console.log("[parse_meal] search_foods_ranked error:", error.message);
    return [];
  }
  const rows = data.slice(0, 6) as Array<Record<string, unknown>>;
  const ids = rows.map((r) => String(r.id));
  const servingsByFood = new Map<string, { label: string; grams: number; is_default: boolean }[]>();
  const { data: servings } = await userClient
    .from("food_servings")
    .select("food_id, label, grams, is_default")
    .in("food_id", ids)
    .order("seq", { ascending: true });
  for (const s of (servings ?? []) as Array<Record<string, unknown>>) {
    const key = String(s.food_id);
    const list = servingsByFood.get(key) ?? [];
    list.push({ label: String(s.label), grams: Number(s.grams), is_default: !!s.is_default });
    servingsByFood.set(key, list);
  }
  return rows.map((r) => ({
    food_id: String(r.id),
    name: String(r.name),
    brand: r.brand ? String(r.brand) : null,
    base_unit: r.base_unit === "ml" ? "ml" as const : "g" as const,
    kcal: Number(r.kcal ?? 0),
    protein_g: Number(r.protein_g ?? 0),
    carb_g: Number(r.carb_g ?? 0),
    fat_g: Number(r.fat_g ?? 0),
    fiber_g: r.fiber_g === null || r.fiber_g === undefined ? null : Number(r.fiber_g),
    servings: servingsByFood.get(String(r.id)) ?? [],
    source: "catalog" as const,
  }));
}

// Recents give the prompt this user's staples ("milk" => their toned milk).
// meal_entries has no timestamps of its own, so walk recent meals and
// flatten, deduping by lowercased name.
async function fetchRecentFoods(userClient: SupabaseClient): Promise<RecentFoodContext[]> {
  const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await userClient
    .from("meals")
    .select("logged_at, meal_entries(food_name, quantity, serving_unit)")
    .gte("logged_at", sinceIso)
    .order("logged_at", { ascending: false })
    .limit(25);
  if (error || !Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: RecentFoodContext[] = [];
  for (const meal of data as Array<Record<string, unknown>>) {
    const entries = Array.isArray(meal.meal_entries) ? meal.meal_entries : [];
    for (const e of entries as Array<Record<string, unknown>>) {
      const name = typeof e.food_name === "string" ? e.food_name.trim() : "";
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({
        food_name: name,
        quantity: Number(e.quantity ?? 1) || 1,
        serving_unit: typeof e.serving_unit === "string" ? e.serving_unit : "g",
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

// Full agent-flow observability for parse_meal: one parse_traces row per request
// (logged or not), capturing the input, the tool-call trail, and the resolved
// items. Fire-and-forget; never let a trace failure break the parse response.
function recordParseTrace(admin: SupabaseClient, row: Record<string, unknown>): void {
  const p = (async () => {
    try {
      await admin.from("parse_traces").insert(row);
    } catch (e) {
      console.log("[parse_meal] parse_trace insert failed:", String(e));
    }
  })();
  // Keep the insert alive past the response so a fast return can't drop the trace.
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p); else void p;
}

async function handleParseMealRequest(args: {
  admin: SupabaseClient;
  userClient: SupabaseClient;
  trace: CoachTrace;
  userId: string;
  startedAtMs: number;
  body: Record<string, unknown>;
  respond: (body: unknown, status: number) => Promise<Response>;
}): Promise<Response> {
  const { admin, userClient, trace, userId, startedAtMs, body, respond } = args;

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    trace.status = "bad_request";
    trace.error_message = "parse_meal requires non-empty text";
    return respond({ error: trace.error_message }, 400);
  }
  trace.model = PARSE_MEAL_MODEL;
  trace.last_user_message_preview = preview(text);
  trace.message_count = 1;

  // Own bucket, same sliding-window mechanics as the coach limiter. Parse
  // failures still count a slot here (the Anthropic call was made); client
  // retries after hard errors are rare enough that this is acceptable v1.
  const sinceIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count, error: countErr } = await admin
    .from("parse_meal_rate_limit")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("request_at", sinceIso);
  if (countErr) {
    trace.status = "internal_error";
    trace.error_message = `parse_rate_limit_check_failed: ${countErr.message}`;
    return respond({ error: "Rate limit check failed" }, 500);
  }
  if ((count ?? 0) >= PARSE_RATE_LIMIT_MAX) {
    trace.status = "rate_limited";
    trace.error_message = `parse count=${count} cap=${PARSE_RATE_LIMIT_MAX}`;
    let retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
    const { data: oldest } = await admin
      .from("parse_meal_rate_limit")
      .select("request_at")
      .eq("user_id", userId)
      .gte("request_at", sinceIso)
      .order("request_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (oldest?.request_at) {
      const freesAtMs = new Date(oldest.request_at).getTime() + RATE_LIMIT_WINDOW_MS;
      retryAfter = Math.max(0, Math.ceil((freesAtMs - Date.now()) / 1000));
    }
    return respond({ error: "Rate limit exceeded", retry_after_seconds: retryAfter }, 429);
  }
  const { error: logErr } = await admin
    .from("parse_meal_rate_limit")
    .insert({ user_id: userId });
  if (logErr) {
    trace.status = "internal_error";
    trace.error_message = `parse_rate_limit_log_failed: ${logErr.message}`;
    return respond({ error: "Rate limit log failed" }, 500);
  }

  // Context: recents + targets + today's totals, all non-fatal on failure.
  const rawHour = body.local_hour;
  const localHour = typeof rawHour === "number" && Number.isFinite(rawHour) ? rawHour : null;
  const rawDate = body.local_date;
  const localDate = typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  const rawHint = body.meal_hint;
  const mealHint: MealType | null =
    rawHint === "breakfast" || rawHint === "lunch" || rawHint === "dinner" || rawHint === "snack"
      ? rawHint
      : null;

  const [recentFoods, targetsRes, totalsRes] = await Promise.all([
    fetchRecentFoods(userClient).catch(() => [] as RecentFoodContext[]),
    userClient.from("user_profiles").select("daily_calorie_target, protein_target_g").maybeSingle(),
    localDate
      ? userClient.from("user_nutrition_stats").select("kcal, protein_g").eq("day", localDate).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const targetsRow = (targetsRes as { data: Record<string, unknown> | null }).data;
  const totalsRow = (totalsRes as { data: Record<string, unknown> | null }).data;

  try {
    const result = await runParseMeal(
      {
        anthropicApiKey: ANTHROPIC_API_KEY!,
        model: PARSE_MEAL_MODEL,
        maxTokens: PARSE_MEAL_MAX_TOKENS,
        timeoutMs: ANTHROPIC_TIMEOUT_MS,
        webSearchEnabled: PARSE_WEB_SEARCH_ENABLED,
        searchFoods: (q) => searchCatalogWithServings(userClient, q),
        backfillOffFood: (p) => backfillOffFoodRow(admin, p),
        getFoodPer100: async (foodId) => {
          const { data } = await userClient
            .from("foods")
            .select("base_unit, kcal, protein_g, carb_g, fat_g, fiber_g")
            .eq("id", foodId)
            .maybeSingle();
          if (!data) return null;
          const row = data as Record<string, unknown>;
          return {
            base_unit: String(row.base_unit ?? "g"),
            kcal: Number(row.kcal ?? 0),
            protein_g: Number(row.protein_g ?? 0),
            carb_g: Number(row.carb_g ?? 0),
            fat_g: Number(row.fat_g ?? 0),
            fiber_g: row.fiber_g === null || row.fiber_g === undefined ? null : Number(row.fiber_g),
          };
        },
        log: (msg) => console.log(msg),
      },
      {
        text,
        localHour,
        mealHint,
        recentFoods,
        todayTotals: totalsRow
          ? { kcal: Number(totalsRow.kcal ?? 0), protein_g: Number(totalsRow.protein_g ?? 0) }
          : null,
        targets: targetsRow
          ? {
            daily_calorie_target: targetsRow.daily_calorie_target === null
              ? null
              : Number(targetsRow.daily_calorie_target),
            protein_target_g: targetsRow.protein_target_g === null
              ? null
              : Number(targetsRow.protein_target_g),
          }
          : null,
      },
    );

    trace.status = "success";
    trace.input_tokens = result.usage.input_tokens || null;
    trace.output_tokens = result.usage.output_tokens || null;
    trace.cache_creation_input_tokens = result.usage.cache_creation_input_tokens || null;
    trace.cache_read_input_tokens = result.usage.cache_read_input_tokens || null;
    trace.tool_calls = result.tool_calls;
    trace.response_preview = preview(
      result.parsed
        ? `${result.parsed.drona_line} [${result.parsed.items.map((i) => i.food_name).join(", ")}]`
        : result.declined?.message ?? null,
    );

    void logTokenUsage(admin, {
      pipeline: "parse_meal",
      provider: "anthropic",
      model: PARSE_MEAL_MODEL,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_read_tokens: result.usage.cache_read_input_tokens,
      cache_creation_tokens: result.usage.cache_creation_input_tokens,
      latency_ms: Date.now() - startedAtMs,
      status: "success",
      metadata: {
        user_id: userId,
        mode: "parse_meal",
        item_count: result.parsed?.items.length ?? 0,
        sources: result.parsed?.items.map((i) => i.source) ?? [],
        declined: result.declined !== null,
        web_search_requests: result.usage.web_search_requests,
        tool_calls: result.tool_calls,
      },
    });

    // Full agent-flow trace (input -> tool trail -> resolved items) for
    // observability + eval, whether or not the user ends up logging it.
    void recordParseTrace(admin, {
      user_id: userId,
      input_text: text.slice(0, 500),
      meal_hint: mealHint,
      model: PARSE_MEAL_MODEL,
      outcome: result.parsed ? "meal" : "declined",
      message: result.declined?.message ?? null,
      iterations: result.iterations,
      steps: result.steps,
      items: result.parsed?.items ?? null,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      web_search_requests: result.usage.web_search_requests,
      latency_ms: Date.now() - startedAtMs,
    });

    return respond(
      {
        parsed: result.parsed,
        declined: result.declined,
        usage: result.usage,
        tool_calls: result.tool_calls,
      },
      200,
    );
  } catch (e) {
    trace.status = "anthropic_error";
    trace.error_message = `parse_meal_threw: ${String(e)}`.slice(0, 200);
    void logTokenUsage(admin, {
      pipeline: "parse_meal",
      provider: "anthropic",
      model: PARSE_MEAL_MODEL,
      latency_ms: Date.now() - startedAtMs,
      status: "error",
      error_message: trace.error_message,
      metadata: { user_id: userId, mode: "parse_meal" },
    });
    void recordParseTrace(admin, {
      user_id: userId,
      input_text: text.slice(0, 500),
      meal_hint: mealHint,
      model: PARSE_MEAL_MODEL,
      outcome: "error",
      message: trace.error_message,
      latency_ms: Date.now() - startedAtMs,
    });
    return respond(
      {
        error: "parse_failed",
        message: "Drona could not read that one. Give it another shot in a moment.",
      },
      502,
    );
  }
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

  // 2. User-JWT client for the access gate, user_context fetch, and tools.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader! } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 2.5 Parse the body ONCE, up front. parse_meal branches here so it runs
  // for ANY signed-in user (product decision 2026-07-07): AI food logging is
  // NOT behind the paid Drona gate, only behind a valid JWT + its own 40/day
  // rate bucket. It must therefore branch BEFORE the paid access gate below.
  // Coach chat parses the same body here and reuses it (body.messages).
  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    trace.status = "bad_request";
    trace.error_message = "invalid JSON body";
    return respond({ error: "Invalid JSON body" }, 400);
  }

  if ((body as Record<string, unknown>).mode === "parse_meal") {
    return await handleParseMealRequest({
      admin,
      userClient,
      trace,
      userId,
      startedAtMs,
      body: body as Record<string, unknown>,
      respond,
    });
  }

  // 3. Drona access gate. Reads the user's current state via
  // get_coach_access_status() — paid / trialing / trial_ended / eligible_for_trial.
  //
  // We REQUIRE either paid or trialing here. Free users (eligible_for_trial /
  // trial_ended) get a 402 with the state in the body, and the client renders
  // a paywall or "Start Free Trial" CTA based on the returned state instead
  // of ever hitting this function.
  //
  // Why we don't auto-start the trial here: it's a UX decision the client
  // should make explicitly (user taps "Start Free Trial"), not a side effect
  // of opening the chat. The client calls start_coach_trial() separately
  // when the user opts in, then re-attempts the chat.
  //
  // This gate runs BEFORE the rate-limit count+insert below so a locked-out
  // (eligible_for_trial / trial_ended) user can't burn today's quota just by
  // hitting this endpoint — otherwise those denied requests would count
  // against them if they started a trial later the same day.
  try {
    const { data: accessData, error: accessErr } = await userClient.rpc(
      "get_coach_access_status",
    );
    if (accessErr) {
      // Treat as no access — fail-closed. The error is logged for diagnosis.
      console.log("[ai-coach] access status rpc error:", accessErr.message);
      trace.status = "internal_error";
      trace.error_message = `access_status_failed: ${accessErr.message}`;
      return respond({ error: "Access check failed" }, 500);
    }
    const state = (accessData as { state?: string } | null)?.state ?? "unauthenticated";
    if (state !== "paid" && state !== "trialing") {
      // 402 Payment Required. The client switches on `state` to render the
      // right surface: 'eligible_for_trial' → trial-start CTA; 'trial_ended'
      // → paywall; 'unauthenticated' → re-auth.
      trace.status = "unauthorized";
      trace.error_message = `no_drona_access:${state}`;
      return respond(
        { error: "drona_access_required", state, details: accessData },
        402,
      );
    }
  } catch (e) {
    console.log("[ai-coach] access status check threw:", String(e));
    trace.status = "internal_error";
    trace.error_message = `access_status_threw: ${String(e).slice(0, 200)}`;
    return respond({ error: "Access check failed" }, 500);
  }

  // 3.5 Rate limit (paid AND trial alike): rolling 24h window, counted only
  // now that access is confirmed so denied requests never consume quota.
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
    // Rolling window: the user can retry once the OLDEST counted request ages
    // out of it. Derive the hint from that row rather than a fixed 1h value
    // (the window is 24h, so 3600s would tell clients to retry ~23h early).
    let retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
    const { data: oldest } = await admin
      .from("ai_coach_rate_limit")
      .select("request_at")
      .eq("user_id", userId)
      .gte("request_at", sinceIso)
      .order("request_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (oldest?.request_at) {
      const freesAtMs = new Date(oldest.request_at).getTime() + RATE_LIMIT_WINDOW_MS;
      retryAfter = Math.max(0, Math.ceil((freesAtMs - Date.now()) / 1000));
    }
    return respond({ error: "Rate limit exceeded", retry_after_seconds: retryAfter }, 429);
  }

  const { error: logErr } = await admin
    .from("ai_coach_rate_limit")
    .insert({ user_id: userId });
  if (logErr) {
    trace.status = "internal_error";
    trace.error_message = `rate_limit_log_failed: ${logErr.message}`;
    return respond({ error: "Rate limit log failed" }, 500);
  }

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

  // Phase 4 goal-aware retrieval: surface user_profiles.goal from the
  // userContext blob so we can pass it into coach_search_research as
  // p_user_goal. The RPC boosts weighted_score 1.15× for papers whose
  // topic_tags overlap the goal's tag set (hypertrophy → 'hypertrophy',
  // 'muscle-growth', etc.). Null/'general' → no boost.
  const userGoal: string | null = (() => {
    if (!userContext || typeof userContext !== "object") return null;
    const profile = (userContext as Record<string, unknown>).profile;
    if (!profile || typeof profile !== "object") return null;
    const g = (profile as Record<string, unknown>).goal;
    return typeof g === "string" && g.length > 0 ? g : null;
  })();

  // 5. Validate messages (body was parsed once above, before the rate gate)
  const incomingMessages = body.messages;
  if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) {
    trace.status = "bad_request";
    trace.error_message = "messages must be a non-empty array";
    return respond({ error: trace.error_message }, 400);
  }

  trace.message_count = incomingMessages.length;
  const lastUser = [...incomingMessages].reverse().find((m) => m.role === "user");
  trace.last_user_message_preview = preview(lastUser?.content ?? null);

  // 6. Retrieval (Phase 2.2): embed last user message, look up top-k research
  //    via the weighted-similarity RPC. Non-fatal — if Voyage or the RPC
  //    fails, the coach falls back to user_context + core_principles.
  let retrievedResearch: Array<{
    id: string; title: string; authors: string[]; year?: number; url?: string;
    practical_takeaway: string; trust_score?: number;
  }> = [];
  if (!VOYAGE_API_KEY) {
    trace.retrieval_status = "skipped_no_voyage_key";
  } else if (!lastUser?.content) {
    trace.retrieval_status = "skipped_empty_message";
  } else {
    const queryEmbedding = await embedQuery(lastUser.content, admin, userId);
    if (!queryEmbedding) {
      trace.retrieval_status = "embed_failed";
    } else {
      try {
        const { data, error } = await userClient.rpc("coach_search_research", {
          p_query_embedding: JSON.stringify(queryEmbedding),
          p_top_k: RETRIEVAL_TOP_K,
          p_floor: RETRIEVAL_FLOOR,
          // Phase 4: hypertrophy/strength/fat_loss/endurance/general
          // → boost weighted_score 1.15× when topic_tags match the goal.
          p_user_goal: userGoal,
        });
        if (error) {
          trace.retrieval_status = `rpc_error: ${error.message}`.slice(0, 200);
          console.log("[ai-coach] retrieval RPC error:", error.message);
        } else if (Array.isArray(data)) {
          retrievedResearch = data.map((r: Record<string, unknown>) => ({
            id: String(r.id),
            title: String(r.title),
            authors: Array.isArray(r.authors) ? (r.authors as string[]) : [],
            year: r.year ? Number(r.year) : undefined,
            url: r.url ? String(r.url) : undefined,
            practical_takeaway: String(r.practical_takeaway ?? ""),
            trust_score: r.trust_score ? Number(r.trust_score) : undefined,
          }));
          trace.retrieved_doc_ids = retrievedResearch.map((r) => r.id);
          trace.retrieval_status = retrievedResearch.length > 0 ? "ok" : "no_matches";
          console.log(
            `[ai-coach] retrieved ${retrievedResearch.length} research entries`,
          );
        } else {
          trace.retrieval_status = "unexpected_response_shape";
        }
      } catch (e) {
        trace.retrieval_status = `threw: ${String(e)}`.slice(0, 200);
        console.log("[ai-coach] retrieval threw:", String(e));
      }
    }
  }

  // Generate-flow routing (Phase 2.5): client sets `force_tool` to one of
  // 'generate_workout' | 'generate_plan'. We narrow the toolkit to that
  // single terminal tool and force tool_choice on it.
  //
  // Refine-flow routing: client sets `mode` to 'refine_workout' |
  // 'refine_plan'. We expose the read toolkit AND the matching terminal
  // tool. tool_choice is auto by default — the model decides whether to
  // chat (probing priorities) or emit the refined structured output. The
  // confirmation gate is enforced by REFINE_BEHAVIOR in the system prompt.
  //
  // Escape hatch: in refine mode the client MAY ALSO send `force_tool` to
  // force the terminal tool on the next turn. This is used when the
  // client detects an affirmative user reply (e.g. "yes, go ahead") and
  // wants to guarantee the model emits structured output instead of
  // writing the workout as text. The terminal tool is part of the refine
  // toolkit, so tool_choice can name it.
  const rawForceTool = (body as { force_tool?: unknown }).force_tool;
  const forceTool: 'generate_workout' | 'generate_plan' | null =
    rawForceTool === 'generate_workout' || rawForceTool === 'generate_plan'
      ? rawForceTool
      : null;
  const rawMode = (body as { mode?: unknown }).mode;
  const explicitMode: 'chat' | 'refine_workout' | 'refine_plan' | 'discuss_workout' | 'discuss_plan' | null =
    rawMode === 'chat'
    || rawMode === 'refine_workout' || rawMode === 'refine_plan'
    || rawMode === 'discuss_workout' || rawMode === 'discuss_plan'
      ? rawMode
      : null;
  // Resolution order: explicit `mode` wins, otherwise derive from
  // `force_tool` (back-compat with existing generate flows that only send
  // force_tool), otherwise default to 'chat'.
  const mode: 'chat' | 'generate_workout' | 'generate_plan' | 'refine_workout' | 'refine_plan' | 'discuss_workout' | 'discuss_plan' =
    explicitMode ?? forceTool ?? 'chat';
  // Cross-mode compatibility check: only honor force_tool when the tool
  // is actually exposed in the resolved mode's toolkit. Refine and discuss
  // modes both include the matching generate tool, so they can force it;
  // mismatched combos (refine_workout + generate_plan, etc.) get dropped
  // to null rather than producing an Anthropic 400. Explicit `mode: 'chat'`
  // exposes no generate_* tool, so a force_tool there must be dropped too —
  // otherwise `{ mode: 'chat', force_tool: 'generate_plan' }` would send a
  // tool_choice for a tool that isn't in `tools` (400).
  const forceToolAllowed =
    !forceTool
    || (mode === 'generate_workout' && forceTool === 'generate_workout')
    || (mode === 'generate_plan' && forceTool === 'generate_plan')
    || (mode === 'refine_workout' && forceTool === 'generate_workout')
    || (mode === 'refine_plan' && forceTool === 'generate_plan')
    || (mode === 'discuss_workout' && forceTool === 'generate_workout')
    || (mode === 'discuss_plan' && forceTool === 'generate_plan');
  const effectiveForceTool: 'generate_workout' | 'generate_plan' | null =
    forceToolAllowed ? forceTool : null;

  const { system, tools } = buildSystemPrompt({ userContext, retrievedResearch, mode });
  trace.model = MODEL;

  // ── Streaming branch (Phase 2.6) ────────────────────────────────────────
  // Client opts in via `stream: true` in the request body. We return an SSE
  // response and the tool-use loop runs in a fire-and-forget IIFE, writing
  // text deltas, tool-call status, and a final `done` event with citations.
  const streamMode = (body as { stream?: unknown }).stream === true;
  if (streamMode) {
    const initialConversation: AnthropicMessage[] = incomingMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    const { response: sseResponse, sse } = createSSEResponse();

    // Pick the right output budget. Multi-day plans easily push 2k+ tokens
    // of JSON tool input — leaving this at CHAT_MAX_TOKENS makes plan
    // generation silently fail at the cap. Refine modes use the same
    // generate-sized budget because a refine session ends with an emission
    // of the matching terminal tool, which carries the same JSON payload
    // as a fresh generate — even though the back-and-forth chat turns are
    // short (Anthropic bills actual output, so the larger ceiling is free
    // when unused).
    const maxTokens =
      forceTool === 'generate_plan' || mode === 'refine_plan' || mode === 'discuss_plan'
        ? GENERATE_PLAN_MAX_TOKENS
        : forceTool === 'generate_workout' || mode === 'refine_workout' || mode === 'discuss_workout'
          ? GENERATE_WORKOUT_MAX_TOKENS
          : CHAT_MAX_TOKENS;

    // Headers flush as soon as we return; body fills asynchronously.
    (async () => {
      try {
        const statusPhase = effectiveForceTool
          ? `generating_${effectiveForceTool === 'generate_workout' ? 'workout' : 'plan'}`
          : mode === 'refine_workout' || mode === 'refine_plan'
            ? 'refining'
            : mode === 'discuss_workout' || mode === 'discuss_plan'
              ? 'discussing'
              : 'thinking';
        sse.write("status", { phase: statusPhase });
        const result = await runStreamingToolLoop(sse, system, tools, initialConversation, userClient, trace, effectiveForceTool, maxTokens);

        // Citations: same regex as non-streaming path
        const refs = new Set<number>();
        for (const m of result.finalText.matchAll(/\[(\d+)\]/g)) {
          const n = parseInt(m[1], 10);
          if (n >= 1 && n <= retrievedResearch.length) refs.add(n);
        }
        const citations = Array.from(refs)
          .sort((a, b) => a - b)
          .map((n) => {
            const r = retrievedResearch[n - 1];
            return { n, id: r.id, title: r.title, authors: r.authors, year: r.year, url: r.url };
          });

        trace.status = "success";
        trace.input_tokens = result.totalInput || null;
        trace.output_tokens = result.totalOutput || null;
        trace.cache_creation_input_tokens = result.totalCacheCreation || null;
        trace.cache_read_input_tokens = result.totalCacheRead || null;
        trace.citation_ids = citations.map((c) => c.id);
        trace.response_preview = preview(result.finalText);

        // Phase 3 observability: one row per coach turn into token_usage_log.
        // The trace table already captures this for the Conversations page,
        // but the unified log powers the cost-page breakdowns where coach +
        // ingest + review-agent costs sit side-by-side.
        void logTokenUsage(admin, {
          pipeline: "coach",
          provider: "anthropic",
          model: MODEL,
          input_tokens: result.totalInput,
          output_tokens: result.totalOutput,
          cache_read_tokens: result.totalCacheRead,
          cache_creation_tokens: result.totalCacheCreation,
          latency_ms: Date.now() - startedAtMs,
          status: "success",
          metadata: {
            user_id: userId,
            // Use the resolved mode so refine sessions show as 'refine_*'
            // instead of bucketed under 'chat'. Helps cost-page breakdowns.
            mode,
            message_count: incomingMessages.length,
            tool_calls: trace.tool_calls,
            citation_count: citations.length,
            retrieval_status: trace.retrieval_status,
            stream: true,
          },
        });

        // Trial usage is no longer tracked separately — daily limit (paid or
        // trial) is enforced by the rate-limit table at the top of the handler.
        // Clients call get_coach_access_status to read messages_today /
        // daily_limit / messages_left. Nothing to do here on success.

        sse.write("done", {
          citations,
          usage: {
            input_tokens: result.totalInput,
            output_tokens: result.totalOutput,
            cache_creation_input_tokens: result.totalCacheCreation,
            cache_read_input_tokens: result.totalCacheRead,
          },
          tool_calls: trace.tool_calls,
          hit_iteration_cap: result.hitIterationCap,
          // Phase 2.5: included redundantly in done so a client that missed
          // the live 'structured' event (e.g., reconnected mid-stream) still
          // gets the generated workout/plan on the final event.
          structured: result.structured ?? null,
        });
      } catch (e) {
        trace.status = "internal_error";
        trace.error_message = `stream_threw: ${String(e)}`.slice(0, 200);
        sse.write("error", { error: String(e) });
        // Error path: still log usage so the Errors page surfaces this.
        // input/output tokens unknown for stream-aborts so we just record
        // the latency + error message.
        void logTokenUsage(admin, {
          pipeline: "coach",
          provider: "anthropic",
          model: MODEL,
          latency_ms: Date.now() - startedAtMs,
          status: "error",
          error_message: `stream_threw: ${String(e)}`.slice(0, 200),
          metadata: { user_id: userId, mode, stream: true },
        });
      } finally {
        trace.http_status = 200;
        try { await recordTrace(admin, trace, startedAtMs); } catch { /* swallow */ }
        sse.close();
      }
    })();

    return sseResponse;
  }

  // 6. Non-streaming tool-use loop (legacy / fallback path).
  //
  // Keep behavior in sync with the streaming branch above:
  //  - same per-mode max_tokens budget (so generate_plan gets 4096)
  //  - force tool_choice on iter 0 when force_tool is set
  //  - terminal tools (generate_workout / generate_plan) are NOT executed;
  //    their input IS the structured response, returned in `structured`
  //    just like the streaming `done` event does
  let conversation: AnthropicMessage[] = incomingMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Same budget logic as the streaming branch — refine modes get the
  // generate-sized ceiling because the session ends with an emission of
  // the matching terminal tool.
  const nonStreamMaxTokens =
    forceTool === 'generate_plan' || mode === 'refine_plan' || mode === 'discuss_plan'
      ? GENERATE_PLAN_MAX_TOKENS
      : forceTool === 'generate_workout' || mode === 'refine_workout' || mode === 'discuss_workout'
        ? GENERATE_WORKOUT_MAX_TOKENS
        : CHAT_MAX_TOKENS;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let finalText: string | null = null;
  let structured: { name: string; input: Record<string, unknown> } | null = null;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      // Force the matching terminal tool ONLY on the first iteration so
      // follow-up turns (after we've appended tool_results) are free to
      // either chat or call another tool. Identical to streaming behavior.
      // Use effectiveForceTool here so refine modes (which set it to null
      // even when forceTool was technically present) never auto-force.
      const toolChoice = (effectiveForceTool && iter === 0)
        ? { type: "tool" as const, name: effectiveForceTool }
        : undefined;
      const apiResult = await callAnthropic({
        model: MODEL,
        max_tokens: nonStreamMaxTokens,
        system,
        tools,
        messages: conversation,
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
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

      // Tool calls. Split terminal tools (generate_workout / generate_plan)
      // from regular data-fetch tools — terminal tools are NOT executed
      // server-side; their `input` IS the structured response.
      const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
      const terminalUse = toolUses.find(
        (b) => typeof b.name === "string" && TERMINAL_TOOLS.has(b.name),
      );
      if (terminalUse) {
        trace.tool_calls.push(terminalUse.name ?? "<terminal>");
        structured = {
          name: terminalUse.name ?? "",
          input: terminalUse.input ?? {},
        };
        finalText = contentBlocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
          .trim() || null;
        break;
      }

      // Regular data-fetch tools: execute each, append assistant + tool_result
      // turns, loop again.
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

  // ── Citations (Phase 2.3) ───────────────────────────────────────────────────
  // The model writes inline `[N]` markers referencing the numbered entries in
  // <retrieved_research>. Parse them out, map back to each entry's metadata,
  // and return a structured citations[] array. Only the entries the model
  // ACTUALLY referenced make it into the payload (vs all 8 retrieved).
  interface Citation {
    n: number;
    id: string;
    title: string;
    authors: string[];
    year?: number;
    url?: string;
  }
  let citations: Citation[] = [];
  if (finalText && retrievedResearch.length > 0) {
    const refs = new Set<number>();
    for (const m of finalText.matchAll(/\[(\d+)\]/g)) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= retrievedResearch.length) refs.add(n);
    }
    citations = Array.from(refs)
      .sort((a, b) => a - b)
      .map((n) => {
        const r = retrievedResearch[n - 1];
        return {
          n,
          id: r.id,
          title: r.title,
          authors: r.authors,
          year: r.year,
          url: r.url,
        };
      });
    trace.citation_ids = citations.map((c) => c.id);
  }

  trace.status = "success";
  trace.input_tokens = totalInput || null;
  trace.output_tokens = totalOutput || null;
  trace.cache_creation_input_tokens = totalCacheCreation || null;
  trace.cache_read_input_tokens = totalCacheRead || null;
  trace.response_preview = preview(finalText);

  // Phase 3 observability: mirror the streaming branch's log.
  void logTokenUsage(admin, {
    pipeline: "coach",
    provider: "anthropic",
    model: MODEL,
    input_tokens: totalInput,
    output_tokens: totalOutput,
    cache_read_tokens: totalCacheRead,
    cache_creation_tokens: totalCacheCreation,
    latency_ms: Date.now() - startedAtMs,
    status: "success",
    metadata: {
      user_id: userId,
      mode,
      message_count: incomingMessages.length,
      tool_calls: trace.tool_calls,
      citation_count: citations.length,
      retrieval_status: trace.retrieval_status,
      stream: false,
    },
  });

  // Trial usage is no longer tracked separately — uniform daily limit (paid
  // or trial) is enforced by the rate-limit table at the top of the handler.

  return respond(
    {
      response: finalText,
      citations,
      usage: {
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cache_creation_input_tokens: totalCacheCreation,
        cache_read_input_tokens: totalCacheRead,
      },
      tool_calls: trace.tool_calls,
      // Phase 2.5: parity with the streaming `done` event. When a terminal
      // tool fired, its input IS the response — clients should render this
      // rather than `response`.
      structured,
    },
    200,
  );
});
