/**
 * form-check — Drona's eyes.
 *
 * Two modes, both cheap and both text-only:
 *
 *   analyze       Takes the compact FormSummary the phone produced (per-rep
 *                 flags, angles, tempo) and writes the coaching note. NO video,
 *                 NO frames and NO keypoints ever reach this function; pose
 *                 estimation happens on device. That is what keeps a form check
 *                 at a fraction of a cent instead of the dollars a vision model
 *                 would cost, and it is also the privacy promise the UI makes.
 *
 *   author_rules  Invents a FormRuleSpec for an exercise nothing in the catalog
 *                 resembles. Reached only after the free tiers of the
 *                 resolution ladder miss (see lib/form/resolve.ts), so it fires
 *                 roughly once per novel movement, ever.
 *
 * The SCORE is computed on device, deterministically. The model is handed the
 * number and told to write about it; it never gets to decide it. Two identical
 * sets must score identically or the feature is not trustworthy.
 *
 * Access: any signed-in user, metered. Form check is a retention hook, not a
 * paid-tier feature, so it branches BEFORE the paid Drona gate and carries its
 * own daily bucket (migration 0101), exactly like parse_meal.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Throws at module load when unset, deliberately. A default issuer here would
// mean accepting tokens from the wrong Clerk instance, which is a privacy bug,
// so a dead function is the safer failure.
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER");
if (!CLERK_ISSUER) throw new Error("CLERK_ISSUER is required");

const MODEL = "claude-haiku-4-5";
const ANALYZE_MAX_TOKENS = 700;
const AUTHOR_MAX_TOKENS = 1600;
const ANTHROPIC_TIMEOUT_MS = 30000;

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Paid and trialing users. */
const FORM_CHECK_LIMIT = 20;
/** Free tier. Enough to feel the value, small enough to bound spend. */
const FREE_FORM_CHECK_LIMIT = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

async function verifyClerkJwt(
  authHeader: string | null,
): Promise<{ sub: string | null; reason: string }> {
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

// ── Anthropic ───────────────────────────────────────────────────────────────

type AnthropicResult =
  | { ok: true; data: Record<string, any> }
  | { ok: false; status: number; body: string };

async function callAnthropic(payload: Record<string, unknown>): Promise<AnthropicResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
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
    const aborted = (e as Error).name === "AbortError";
    return { ok: false, status: aborted ? 504 : 502, body: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Static system text is identical on every call, so it caches well. */
function cacheableSystem(text: string): unknown {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

function withToolCache(tools: unknown[]): unknown[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 && t && typeof t === "object" && !("type" in (t as object))
      ? { ...(t as object), cache_control: { type: "ephemeral" } }
      : t
  );
}

/** Pull the forced terminal tool's input. Its `input` IS the response. */
function terminalInput(
  data: Record<string, any>,
  toolName: string,
): Record<string, unknown> | null {
  const blocks: Array<Record<string, any>> = data.content ?? [];
  const terminal = blocks.find((b) => b.type === "tool_use" && b.name === toolName);
  if (!terminal) return null;
  return (terminal.input ?? {}) as Record<string, unknown>;
}

// ── usage logging ───────────────────────────────────────────────────────────

/**
 * Best effort, never allowed to fail the request. supabase-js resolves with
 * `{ error }` instead of throwing, so the error has to be inspected explicitly.
 */
async function logTokenUsage(
  admin: SupabaseClient,
  args: {
    mode: string;
    userId: string | null;
    usage: Record<string, number> | undefined;
    latencyMs: number;
    status: string;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    const u = args.usage ?? {};
    const { error } = await admin.rpc("log_token_usage", {
      p_pipeline: "form_check",
      p_provider: "anthropic",
      p_model: MODEL,
      p_input_tokens: u.input_tokens ?? 0,
      p_output_tokens: u.output_tokens ?? 0,
      p_cache_read_tokens: u.cache_read_input_tokens ?? 0,
      p_cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
      p_metadata: { user_id: args.userId, mode: args.mode },
      p_latency_ms: args.latencyMs,
      p_status: args.status,
      p_error_message: args.errorMessage?.slice(0, 200) ?? null,
    });
    if (error) console.log("[form-check] token log failed", error.message);
  } catch (e) {
    console.log("[form-check] token log threw", (e as Error).message);
  }
}

// ── analyze ─────────────────────────────────────────────────────────────────

const WRITE_NOTE_TOOL = {
  name: "write_form_note",
  description: "Deliver the coaching note for a checked set.",
  input_schema: {
    type: "object",
    properties: {
      note: {
        type: "string",
        description:
          "Two or three sentences, second person, coach voice. Lead with what went well, then the single most important fix. No em dashes.",
      },
      headline: {
        type: "string",
        description: "Four words or fewer summing up the set, e.g. 'Solid depth, watch the chest'.",
      },
      focus: {
        type: "string",
        description:
          "The one cue id from the provided list the lifter should work on next set, or an empty string when nothing needs fixing.",
      },
    },
    required: ["note", "headline", "focus"],
  },
};

const ANALYZE_SYSTEM = `You are Coach Drona, a calm, seasoned strength coach reviewing one set a lifter just filmed.

You are given a MEASURED summary of that set: rep count, a deterministic form score, per-rep tempo, which fault cues fired on which reps, and joint angle aggregates in degrees. Pose estimation ran on the lifter's phone. You never see the video.

Rules, in priority order:

1. NEVER invent a number. Every number in your note must appear in the payload you were given. If you want to say how deep they went, use the angle you were handed. Do not estimate weight, do not guess what they were lifting, do not describe anything you were not told.
2. The score is already computed. Do not recompute, dispute, or explain the arithmetic behind it.
3. Lead with what was genuinely good, then give ONE fix. Not three. A lifter can hold one cue in their head for the next set.
4. If no cues fired, say so plainly and briefly. Do not manufacture a problem to sound useful.
5. If cues fired on only some reps, say which part of the set went wrong. "The first four were clean, then the depth went" is far more useful than a set-wide average.
6. Speak in second person, warm and direct, the way a good coach talks standing next to the rack. Economical. Two or three sentences.
7. Never use em dashes. Never sound like a system: no "Error", "Invalid", "Detected", "Analysis shows".
8. Never give medical advice or diagnose pain or injury.

The cue list you are given includes a plain-language detail for each fault. Use it to explain the fix, in your own words, not verbatim.`;

/**
 * Ceilings on the parts of a summary that get pasted into the prompt.
 *
 * The client builds summaries from a validated spec, so these mirror
 * lib/form/spec.ts LIMITS and never reject an honest payload. They exist for
 * the dishonest one: without them a caller can spend a single rate-limit slot
 * and still hand the model an arbitrarily large body to read.
 */
const MAX_NAME_CHARS = 120;
const MAX_CUES = 10;
const MAX_MEASURES = 12;
/** Generous next to a real entry (~200 bytes) and still bounds the prompt. */
const MAX_ENTRY_BYTES = 2_000;

/** Is this an array within its count limit, with no oversized entry? */
function withinPromptBudget(v: unknown, maxLen: number): boolean {
  if (v === undefined || v === null) return true;
  if (!Array.isArray(v)) return false;
  if (v.length > maxLen) return false;
  return v.every((entry) => JSON.stringify(entry ?? null).length <= MAX_ENTRY_BYTES);
}

interface FormSummaryPayload {
  exerciseName?: unknown;
  repCount?: unknown;
  score?: unknown;
  cues?: unknown;
  reps?: unknown;
  measures?: unknown;
  unusableReason?: unknown;
  [k: string]: unknown;
}

async function handleAnalyze(args: {
  admin: SupabaseClient;
  userId: string;
  body: Record<string, unknown>;
  startedAtMs: number;
  respond: (body: unknown, status: number) => Response;
}): Promise<Response> {
  const { admin, userId, body, startedAtMs, respond } = args;
  const summary = body.summary as FormSummaryPayload | undefined;

  if (!summary || typeof summary !== "object") {
    return respond({ error: "form_check requires a summary object" }, 400);
  }
  const exerciseName = typeof summary.exerciseName === "string" ? summary.exerciseName.trim() : "";
  if (!exerciseName) {
    return respond({ error: "summary.exerciseName is required" }, 400);
  }
  if (exerciseName.length > MAX_NAME_CHARS) {
    return respond({ error: "summary.exerciseName is too long" }, 400);
  }
  const repCount = Number(summary.repCount ?? 0);
  if (!Number.isFinite(repCount) || repCount < 0 || repCount > 200) {
    return respond({ error: "summary.repCount is out of range" }, 400);
  }
  // Everything below is forwarded into the prompt, so it is bounded HERE rather
  // than at the persist step further down: a rejected request must cost nothing
  // at the model. The limits match the spec validator in lib/form/spec.ts, so
  // no summary a real spec can produce is ever refused.
  if (!withinPromptBudget(summary.cues, MAX_CUES)) {
    return respond({ error: "summary.cues is out of range" }, 400);
  }
  if (!withinPromptBudget(summary.measures, MAX_MEASURES)) {
    return respond({ error: "summary.measures is out of range" }, 400);
  }

  // A set the device already judged unusable never reaches the model: there is
  // nothing to write about, and the honest message is better than prose.
  if (summary.unusableReason) {
    return respond({ note: null, unusable: String(summary.unusableReason) }, 200);
  }

  const score = clampScore(summary.score);

  const result = await callAnthropic({
    model: MODEL,
    max_tokens: ANALYZE_MAX_TOKENS,
    system: cacheableSystem(ANALYZE_SYSTEM),
    tools: withToolCache([WRITE_NOTE_TOOL]),
    tool_choice: { type: "tool", name: WRITE_NOTE_TOOL.name },
    messages: [{ role: "user", content: JSON.stringify(compactSummary(summary)) }],
  });

  const latencyMs = Date.now() - startedAtMs;

  if (!result.ok) {
    void logTokenUsage(admin, {
      mode: "analyze",
      userId,
      usage: undefined,
      latencyMs,
      status: "error",
      errorMessage: `anthropic_${result.status}: ${result.body}`,
    });
    return respond(
      { error: "form_check_failed", message: "I could not write that one up. Try again in a moment." },
      result.status === 504 ? 504 : 502,
    );
  }

  const input = terminalInput(result.data, WRITE_NOTE_TOOL.name);
  void logTokenUsage(admin, {
    mode: "analyze",
    userId,
    usage: result.data.usage,
    latencyMs,
    status: input ? "success" : "error",
    errorMessage: input ? undefined : "no_terminal_tool",
  });

  if (!input || typeof input.note !== "string") {
    return respond(
      { error: "form_check_failed", message: "I could not write that one up. Try again in a moment." },
      502,
    );
  }

  const note = input.note.trim();
  const headline = typeof input.headline === "string" ? input.headline.trim().slice(0, 60) : null;
  const focus = typeof input.focus === "string" && input.focus.trim() ? input.focus.trim() : null;

  // Persist under service_role. Clients hold SELECT/DELETE only, so a score
  // written here cannot be edited afterwards.
  const { data: saved, error: saveErr } = await admin
    .from("form_checks")
    .insert({
      user_id: userId,
      exercise_id: typeof body.exercise_id === "string" ? body.exercise_id : null,
      exercise_name: exerciseName.slice(0, 120),
      movement_pattern: typeof summary.pattern === "string" ? summary.pattern : null,
      source: summary.source === "upload" ? "upload" : "live",
      summary,
      note,
      score,
    })
    .select("id, created_at")
    .single();

  if (saveErr) {
    // The coaching is still worth delivering even if the write failed.
    console.log("[form-check] could not save", saveErr.message);
  }

  return respond(
    {
      id: saved?.id ?? null,
      created_at: saved?.created_at ?? null,
      note,
      headline,
      focus,
      score,
    },
    200,
  );
}

/**
 * Trim the payload before it reaches the model. A 30 rep set carries a lot of
 * repeated structure that costs tokens and adds nothing; the model needs the
 * shape of the set, not every field the device computed.
 */
function compactSummary(s: FormSummaryPayload): Record<string, unknown> {
  const reps = Array.isArray(s.reps) ? s.reps.slice(0, 40) : [];
  return {
    exercise: s.exerciseName,
    pattern: s.pattern ?? null,
    reps_counted: s.repCount,
    score_out_of_100: clampScore(s.score),
    duration_ms: s.durationMs ?? null,
    tracking_confidence: s.confidence ?? null,
    per_rep: reps.map((r) => {
      const rep = r as Record<string, unknown>;
      return {
        n: rep.n,
        faults: rep.flags,
        depth_value: rep.bottom,
        down_ms: rep.tempoDownMs,
        up_ms: rep.tempoUpMs,
      };
    }),
    faults_that_fired: Array.isArray(s.cues) ? s.cues : [],
    angle_aggregates: Array.isArray(s.measures) ? s.measures : [],
  };
}

function clampScore(v: unknown): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ── author_rules ────────────────────────────────────────────────────────────

const AUTHOR_TOOL = {
  name: "author_form_rules",
  description: "Return form-checking rules for an exercise, or declare it uncheckable.",
  input_schema: {
    type: "object",
    properties: {
      unsupported: {
        type: "boolean",
        description:
          "True when a single fixed phone camera cannot meaningfully judge this exercise (machine isolation, cardio, static holds, anything where the fault is invisible from outside).",
      },
      pattern: {
        type: "string",
        enum: [
          "squat",
          "hinge",
          "lunge",
          "horizontal_press",
          "vertical_press",
          "horizontal_pull",
          "vertical_pull",
          "elbow_flexion",
          "elbow_extension",
          "none",
        ],
        description: "The movement family this exercise belongs to.",
      },
      spec: {
        type: "object",
        description:
          "A FormRuleSpec. Omit entirely when unsupported is true. Must follow the schema in the system prompt exactly.",
      },
    },
    required: ["unsupported", "pattern"],
  },
};

const AUTHOR_SYSTEM = `You author form-checking rules for a strength training app. Given an exercise name, you return either a declaration that it cannot be checked, or a rule spec.

The rules are evaluated against 17 COCO body keypoints from an on-device pose model, filmed from a fixed phone. You see no video. Be conservative: a rule that fires wrongly teaches a lifter the wrong thing, which is worse than no rule at all.

Say unsupported: true when a fixed side-on camera genuinely cannot judge the movement. That includes machine isolation work, cardio, static holds, grip and forearm work, and anything whose fault is internal (spinal rounding cannot be seen with 17 keypoints, so never write a rule claiming to detect it).

VALID JOINT NAMES, exactly these:
nose, leftEye, rightEye, leftEar, rightEar, leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle, and the side-agnostic forms shoulder, elbow, wrist, hip, knee, ankle, ear, eye, plus midHip and midShoulder.
Prefer the side-agnostic forms (knee, hip, elbow). The engine resolves them to whichever side faces the camera, so the same spec works filmed from either side.

SPEC SHAPE:
{
  "version": 1,
  "view": "side" | "front" | "any",
  "setup": "one sentence telling the lifter where to put the phone, in coach voice",
  "measures": [ ... ],
  "rep": { "driver": "<measure id>", "downIncreases": bool, "top": number, "bottom": number, "minRepMs": number, "maxRepMs": number },
  "cues": [ ... ]
}

MEASURE KINDS:
- { "kind": "jointAngle", "id": "knee", "at": ["hip","knee","ankle"] }  interior angle at the middle joint, degrees, 0 folded to 180 straight
- { "kind": "segmentVertical", "id": "torsoLean", "from": "hip", "to": "shoulder" }  tilt away from upright, degrees
- { "kind": "segmentHorizontal", "id": "backAngle", "from": "hip", "to": "shoulder" }  tilt away from horizontal, degrees
- { "kind": "verticalGap", "id": "hipBelowKnee", "from": "knee", "to": "hip" }  how much LOWER 'to' is than 'from', in torso lengths, positive means lower
- { "kind": "horizontalGap", "id": "handOverFoot", "from": "ankle", "to": "wrist" }  horizontal distance, in torso lengths

REP RULES:
'driver' names one measure. 'downIncreases' says whether that measure grows on the way down (a knee angle SHRINKS as you squat, so false). 'top' and 'bottom' are hysteresis thresholds and must be ordered to match downIncreases, and differ by at least 5.
Keep rep thresholds GENEROUS. A partial rep should still count and then get flagged as shallow by a cue. If the rep threshold itself demands perfect depth, a sloppy set shows zero reps and the lifter thinks the app is broken.
minRepMs at least 100, maxRepMs at most 60000.

CUE RULES:
{ "id": "shallow", "measure": "<measure id>", "sample": "bottom"|"top"|"min"|"max"|"mean"|"range", "test": {"op":"<"|">"|"between"|"outside", "a": number, "b": number}, "severity": "warn"|"bad", "live": "short badge, max 28 chars", "detail": "one sentence explaining the fix" }
A cue describes the FAULT: it fires when the test passes. 'bad' is for faults that risk injury or waste the set; 'warn' is a quality note. At most 4 cues. Ids are short lowerCamel. Every cue must reference a measure you actually declared.

VOICE: 'live' and 'detail' and 'setup' are read by the lifter. Second person, warm, direct, coach standing next to the rack. Never use em dashes. Never sound like a system.`;

async function handleAuthorRules(args: {
  admin: SupabaseClient;
  userId: string;
  body: Record<string, unknown>;
  startedAtMs: number;
  respond: (body: unknown, status: number) => Response;
}): Promise<Response> {
  const { admin, userId, body, startedAtMs, respond } = args;
  const name = typeof body.exercise_name === "string" ? body.exercise_name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS) {
    return respond({ error: "author_rules requires an exercise_name" }, 400);
  }

  const result = await callAnthropic({
    model: MODEL,
    max_tokens: AUTHOR_MAX_TOKENS,
    system: cacheableSystem(AUTHOR_SYSTEM),
    tools: withToolCache([AUTHOR_TOOL]),
    tool_choice: { type: "tool", name: AUTHOR_TOOL.name },
    messages: [{ role: "user", content: `Exercise name: ${name}` }],
  });

  const latencyMs = Date.now() - startedAtMs;

  if (!result.ok) {
    void logTokenUsage(admin, {
      mode: "author_rules",
      userId,
      usage: undefined,
      latencyMs,
      status: "error",
      errorMessage: `anthropic_${result.status}: ${result.body}`,
    });
    return respond({ error: "author_failed" }, result.status === 504 ? 504 : 502);
  }

  const input = terminalInput(result.data, AUTHOR_TOOL.name);
  void logTokenUsage(admin, {
    mode: "author_rules",
    userId,
    usage: result.data.usage,
    latencyMs,
    status: input ? "success" : "error",
    errorMessage: input ? undefined : "no_terminal_tool",
  });

  if (!input) return respond({ error: "author_failed" }, 502);

  if (input.unsupported === true) {
    return respond({ unsupported: true, pattern: "none" }, 200);
  }

  // Cheap shape check only. The CLIENT runs the canonical validator
  // (lib/form/spec.ts) before persisting or using the spec, and re-validates on
  // every read, so a spec that slips through here can never be acted on. The
  // check below exists to fail fast, not to be the gate.
  if (!looksLikeSpec(input.spec)) {
    return respond({ error: "author_failed", reason: "malformed_spec" }, 502);
  }

  return respond(
    { unsupported: false, pattern: input.pattern ?? null, spec: input.spec },
    200,
  );
}

function looksLikeSpec(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    s.version === 1 &&
    typeof s.view === "string" &&
    Array.isArray(s.measures) &&
    s.measures.length > 0 &&
    typeof s.rep === "object" &&
    s.rep !== null &&
    Array.isArray(s.cues)
  );
}

// ── entrypoint ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const startedAtMs = Date.now();
  const respond = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });

  if (!ANTHROPIC_API_KEY) {
    console.log("[form-check] missing ANTHROPIC_API_KEY");
    return respond({ error: "Server not configured" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  const auth = await verifyClerkJwt(authHeader);
  console.log(
    "[form-check] auth",
    JSON.stringify({ has_header: !!authHeader, reason: auth.reason }),
  );
  if (!auth.sub) {
    // The reason is logged just above; it stays out of the response so an
    // unauthenticated caller learns nothing about why verification failed.
    return respond({ error: "Unauthorized" }, 401);
  }
  const userId = auth.sub;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader! } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return respond({ error: "Invalid JSON body" }, 400);
  }

  const mode = body.mode === "author_rules" ? "author_rules" : "analyze";

  // Access check. Form check is available on the free tier with a smaller cap,
  // so unlike the Pro-only coach flows this accepts 'free' as well as 'paid'
  // and 'trialing'. Fail closed if the check itself errors.
  const { data: accessData, error: accessErr } = await userClient.rpc("get_coach_access_status");
  if (accessErr) {
    console.log("[form-check] access check failed", accessErr.message);
    return respond({ error: "Access check failed" }, 500);
  }
  const state = (accessData as { state?: string } | null)?.state ?? "unauthenticated";
  if (state !== "paid" && state !== "trialing" && state !== "free") {
    return respond({ error: "drona_access_required", state, details: accessData }, 402);
  }
  const freeTier = state === "free";
  const cap = freeTier ? FREE_FORM_CHECK_LIMIT : FORM_CHECK_LIMIT;

  // Both modes consume a slot. Authoring is rare (once per novel movement) but
  // metering it is what stops a client looping made-up exercise names.
  const { data: slotData, error: slotErr } = await userClient.rpc("try_reserve_form_check_slot", {
    p_cap: cap,
  });
  if (slotErr) {
    console.log("[form-check] slot reserve failed", slotErr.message);
    return respond({ error: "Rate limit check failed" }, 500);
  }
  const slotRow = Array.isArray(slotData) ? slotData[0] : slotData;
  const inserted = Boolean((slotRow as { inserted?: boolean } | null)?.inserted);
  const count = Number((slotRow as { current_count?: number } | null)?.current_count ?? 0);

  if (!inserted) {
    if (freeTier) {
      return respond(
        {
          error: "free_cap_hit",
          state: "free",
          feature: "form_check",
          checks_today: count,
          daily_limit: cap,
        },
        402,
      );
    }
    const sinceIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { data: oldest } = await admin
      .from("form_check_rate_limit")
      .select("request_at")
      .eq("user_id", userId)
      .gte("request_at", sinceIso)
      .order("request_at", { ascending: true })
      .limit(1);
    const oldestAt = oldest?.[0]?.request_at ? Date.parse(oldest[0].request_at) : Date.now();
    const retryAfter = Math.max(1, Math.ceil((oldestAt + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000));
    return respond({ error: "Rate limit exceeded", retry_after_seconds: retryAfter }, 429);
  }

  try {
    if (mode === "author_rules") {
      return await handleAuthorRules({ admin, userId, body, startedAtMs, respond });
    }
    return await handleAnalyze({ admin, userId, body, startedAtMs, respond });
  } catch (e) {
    console.log("[form-check] threw", (e as Error).message);
    return respond({ error: "form_check_failed" }, 500);
  }
});
