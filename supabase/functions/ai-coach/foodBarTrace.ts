// One food box message, as one row of food_bar_traces.
//
// Why this exists. Reviewing a live chat on 2026-11-05 we could not say why a
// message went where it went. The pieces were scattered and some were wrong:
// parse_traces holds the PARALLEL parse (its outcome said "meal" while the
// app drew a save card), coach_traces.tool_calls is names with no inputs, the
// router's score was stored nowhere when Jev never answered, and the reply and
// create calls left no trace of their own. This row holds all of it, keyed by
// a request id that parse_traces, coach_traces and token_usage_log also carry.
//
// Pure on purpose: the collector only appends, and buildFoodBarTraceRow turns
// what it gathered into the row. index.ts inserts the row once, after the
// response, so none of this is on the path the user waits for.

/** A model or Jev call, one per round trip. */
export interface ModelCallRecord {
  /** extract, decide, web_label, router_model, agent, reply, create, jev:food_intent ... */
  stage: string;
  provider: "anthropic" | "typesafe";
  model: string | null;
  /** When the call started, ms since the request began. */
  at_ms: number;
  ms: number;
  ok: boolean;
  http_status?: number | null;
  error?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens?: number | null;
  /** The call was sent the earlier turns of this conversation. */
  saw_recent_turns: boolean;
  /** The call was sent the meal card on screen. */
  saw_card: boolean;
  /** Jev only: how many questions it was asked in the one call. */
  questions?: number;
}

/** A step from any source, with when it happened when that is known. */
export interface TraceStep {
  /** parse, agent_parse, router, agent, reply, create, auto_log, edge */
  src: string;
  tool: string;
  at_ms?: number;
  input?: unknown;
  result?: unknown;
}

export interface FoodBarTraceCollector {
  readonly requestId: string;
  /** Request start, epoch ms. Every at_ms is relative to it. */
  readonly t0: number;
  readonly calls: ModelCallRecord[];
  readonly steps: TraceStep[];
  call(rec: Omit<ModelCallRecord, "at_ms"> & { at_ms?: number }): void;
  step(s: TraceStep): void;
  /** ms since the request began. */
  now(): number;
  /** The same collector, with every stage and src prefixed ("agent_parse"),
   *  for work done on another path's behalf: the agent's own parses. */
  scoped(prefix: string): FoodBarTraceCollector;
}

export function createFoodBarTrace(requestId: string, t0: number, clock: () => number = Date.now): FoodBarTraceCollector {
  const calls: ModelCallRecord[] = [];
  const steps: TraceStep[] = [];
  const make = (prefix: string | null): FoodBarTraceCollector => ({
    requestId,
    t0,
    calls,
    steps,
    now: () => clock() - t0,
    call: (rec) => {
      // Recording must never break a parse: a bad record is dropped, not thrown.
      try {
        calls.push({
          ...rec,
          stage: prefix ? `${prefix}:${rec.stage}` : rec.stage,
          at_ms: rec.at_ms ?? Math.max(0, clock() - t0 - rec.ms),
        });
      } catch { /* never */ }
    },
    step: (s) => {
      try {
        steps.push({ ...s, src: prefix ? `${prefix}:${s.src}` : s.src, at_ms: s.at_ms ?? clock() - t0 });
      } catch { /* never */ }
    },
    scoped: (p) => make(prefix ? `${prefix}:${p}` : p),
  });
  return make(null);
}

/** Did a Messages payload carry the conversation and the card? Read off what
 *  was actually SENT, not what the caller meant to send, so the answer stays
 *  true when a prompt builder drops one. parseMeal sends both inside the user
 *  JSON as `recent_turns` and `previous_meal`. */
export function sawContext(payload: Record<string, unknown>): { saw_recent_turns: boolean; saw_card: boolean } {
  let s = "";
  try {
    s = JSON.stringify(payload.messages ?? "");
  } catch { /* unserialisable: say no */ }
  // Unescaped first: the user content is JSON inside JSON. An EMPTY list is
  // not having seen the turns.
  const flat = s.replace(/\\"/g, '"');
  return { saw_recent_turns: flat.includes('"recent_turns":[{'), saw_card: flat.includes('"previous_meal":{') };
}

/** A tool result, short enough to keep. Strings stay strings; anything else is
 *  JSON. Cut, never dropped, so a reader can see that there WAS a result. */
export function summarize(v: unknown, max = 400): string | null {
  if (v === undefined || v === null) return null;
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}

/** The parse's own steps, tagged with their source. A step with no time of its
 *  own takes the time of the step before it, so a stable sort keeps the
 *  parse's order AND interleaves it with the router and the agent. */
export function fromParseSteps(
  src: string,
  steps: Array<{ tool: string; input?: unknown; result?: unknown; at_ms?: number; iter?: number }> | null | undefined,
): TraceStep[] {
  return (steps ?? []).map((s) => ({
    src,
    tool: s.tool,
    ...(typeof s.at_ms === "number" ? { at_ms: s.at_ms } : {}),
    ...(s.input !== undefined ? { input: capped(s.input) } : {}),
    ...(s.result !== undefined ? { result: capped(s.result) } : {}),
  }));
}

/** Step payloads big enough to keep whole (a search's hits, a lookup's row)
 *  stay as they are; past this they become a cut string, so one huge step
 *  cannot make the row huge. */
export const STEP_PAYLOAD_MAX = 4000;

export function capped(v: unknown): unknown {
  if (v === null || typeof v !== "object") {
    return typeof v === "string" && v.length > STEP_PAYLOAD_MAX ? summarize(v, STEP_PAYLOAD_MAX) : v;
  }
  let n = 0;
  try {
    n = JSON.stringify(v).length;
  } catch {
    return summarize(v, STEP_PAYLOAD_MAX);
  }
  return n > STEP_PAYLOAD_MAX ? summarize(v, STEP_PAYLOAD_MAX) : v;
}

/** Every step in the order it happened. Untimed steps inherit the time of the
 *  step before them FROM THE SAME SOURCE, so a source's own order is never
 *  broken, and ties keep the order they were given in. A source whose first
 *  step is untimed takes the time of the step just before it in the list, so
 *  it is not pulled to the very front. */
export function orderSteps(steps: TraceStep[]): TraceStep[] {
  const last = new Map<string, number>();
  let prev = 0;
  const timed = steps.map((s, i) => {
    const t = typeof s.at_ms === "number" ? s.at_ms : (last.get(s.src) ?? prev);
    last.set(s.src, t);
    prev = t;
    return { s, t, i };
  });
  timed.sort((a, b) => a.t - b.t || a.i - b.i);
  return timed.map((x) => x.s);
}

// ── What the app sent ───────────────────────────────────────────────────────

/** The request, as the trace keeps it. Text is capped; nothing is invented. */
export interface FoodBarRequestView {
  text: string;
  meal_hint: string | null;
  speed: string | null;
  streamed: boolean;
  local_date: string | null;
  local_hour: number | null;
  client_id: string | null;
  auto_log: boolean;
  can_create: boolean;
  supports: string[];
  /** How many card lines the app sent (previous_items), before any cap. */
  previous_items_sent: number;
  previous_text: string | null;
  previous_words: string | null;
  /** How many recent_turns arrived, before readFoodContext kept the last few. */
  recent_turns_sent: number;
  /** The turns the server kept and the models could see, text capped. */
  recent_turns: { role: string; text: string }[];
  pending_meal: unknown;
}

const TEXT_MAX = 2000;
const TURN_MAX = 300;

export function readRequestView(
  body: Record<string, unknown>,
  kept: { recentTurns: { role: string; text: string }[]; pendingMeal: unknown },
  derived: { text: string; mealHint: string | null; localDate: string | null; localHour: number | null; streamed: boolean; autoLog: boolean; clientId: string | null; canCreate: boolean },
): FoodBarRequestView {
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
  return {
    text: derived.text.slice(0, TEXT_MAX),
    meal_hint: derived.mealHint,
    speed: typeof body.speed === "string" ? body.speed.slice(0, 20) : null,
    streamed: derived.streamed,
    local_date: derived.localDate,
    local_hour: derived.localHour,
    client_id: derived.clientId,
    auto_log: derived.autoLog,
    can_create: derived.canCreate,
    supports: Array.isArray(body.supports) ? (body.supports as unknown[]).filter((s) => typeof s === "string").slice(0, 10) as string[] : [],
    previous_items_sent: Array.isArray(body.previous_items) ? body.previous_items.length : 0,
    previous_text: str(body.previous_text, TEXT_MAX),
    previous_words: str(body.previous_words, TEXT_MAX),
    recent_turns_sent: Array.isArray(body.recent_turns) ? body.recent_turns.length : 0,
    recent_turns: kept.recentTurns.map((t) => ({ role: t.role, text: t.text.slice(0, TURN_MAX) })),
    pending_meal: kept.pendingMeal ?? null,
  };
}

// ── The router ──────────────────────────────────────────────────────────────

/** FoodIntentDecision, restated so this module imports nothing. */
export interface RouterDecisionLike {
  intent: string;
  source: string;
  confidence: number | null;
  note: string;
  savedMatch: { id: string; name: string; confidence: number } | null;
  hasFood?: number | null;
  pendingAction?: string | null;
  resumeAgent?: boolean;
  jevMiss?: string | null;
}

export interface RouterView {
  /** False when the router did not run (mode off) or threw. */
  ran: boolean;
  ms: number | null;
  intent: string | null;
  confidence: number | null;
  /** jev | model | default */
  source: string | null;
  note: string | null;
  resume_agent: boolean;
  saved_match: { id: string; name: string; confidence: number } | null;
  has_food: number | null;
  pending_action: string | null;
  /** Why Jev's verdict was not used: a timeout, an HTTP error, a score under
   *  the floor. Null when Jev answered and was used. */
  jev_miss: string | null;
}

export function routerView(d: RouterDecisionLike | null, ms: number | null, missing = "router_did_not_run"): RouterView {
  return {
    ran: !!d,
    ms,
    intent: d?.intent ?? null,
    confidence: d?.confidence ?? null,
    source: d?.source ?? null,
    note: d?.note ?? null,
    resume_agent: d?.resumeAgent === true,
    saved_match: d?.savedMatch ? { id: d.savedMatch.id, name: d.savedMatch.name, confidence: d.savedMatch.confidence } : null,
    has_food: d?.hasFood ?? null,
    pending_action: d?.pendingAction ?? null,
    jev_miss: d?.jevMiss ?? (d ? null : missing),
  };
}

// ── What was served ─────────────────────────────────────────────────────────

/** The body the food box was sent back (JSON) or the stream's `end` event. */
export interface ServedBody {
  parsed?: { meal_type?: string; items?: ReadonlyArray<object>; drona_line?: string; corrects_previous?: boolean } | null;
  declined?: { message?: string; cleared?: boolean; pending_meal?: unknown } | null;
  proposal?: { items?: unknown[]; note?: string } | null;
  create?: { tool?: string; input?: Record<string, unknown> } | null;
  logged?: unknown;
  auto_log_skipped?: unknown;
  saved_suggestions?: unknown[];
  error?: string;
  message?: string;
}

export interface ServedView {
  /** meal | declined | create | reply | refused | error */
  kind: string;
  http_status: number;
  meal_type?: string | null;
  items?: Array<{ food_name: unknown; quantity: unknown; serving_label: unknown; grams: unknown; kcal: unknown; source: unknown }>;
  drona_line?: string | null;
  corrects_previous?: boolean;
  message?: string | null;
  cleared?: boolean;
  pending_meal?: unknown;
  create?: { tool: string | null; name: unknown; log_now: unknown; items: number | null };
  proposal?: boolean;
  logged?: unknown;
  auto_log_skipped?: unknown;
  saved_suggestions?: number;
  error?: string | null;
}

/** What the app got. `servedAction` is the server's own word for it, because
 *  a reply rides the decline channel: the body alone cannot tell them apart. */
export function servedView(body: ServedBody, httpStatus: number, servedAction: string | null): ServedView {
  if (httpStatus >= 400 || body.error) {
    return { kind: httpStatus === 402 || httpStatus === 429 ? "refused" : "error", http_status: httpStatus, error: body.error ?? null, message: body.message ?? null };
  }
  if (body.create) {
    const input = body.create.input ?? {};
    return {
      kind: "create",
      http_status: httpStatus,
      create: {
        tool: body.create.tool ?? null,
        name: input.name ?? null,
        log_now: input.log_now ?? null,
        items: Array.isArray(input.items) ? input.items.length : null,
      },
    };
  }
  if (body.parsed) {
    return {
      kind: "meal",
      http_status: httpStatus,
      meal_type: body.parsed.meal_type ?? null,
      items: (body.parsed.items ?? []).map((o) => o as Record<string, unknown>).map((i) => ({
        food_name: i.food_name, quantity: i.quantity, serving_label: i.serving_label, grams: i.grams, kcal: i.kcal, source: i.source,
      })),
      drona_line: body.parsed.drona_line ?? null,
      corrects_previous: body.parsed.corrects_previous === true,
      proposal: !!body.proposal,
      saved_suggestions: body.saved_suggestions?.length ?? 0,
      ...(body.logged !== undefined ? { logged: body.logged } : {}),
      ...(body.auto_log_skipped !== undefined ? { auto_log_skipped: body.auto_log_skipped } : {}),
    };
  }
  return {
    kind: servedAction === "reply" ? "reply" : "declined",
    http_status: httpStatus,
    message: body.declined?.message ?? null,
    ...(body.declined?.cleared ? { cleared: true } : {}),
    ...(body.declined?.pending_meal ? { pending_meal: body.declined.pending_meal } : {}),
    ...(body.auto_log_skipped !== undefined ? { auto_log_skipped: body.auto_log_skipped } : {}),
  };
}

// ── The row ─────────────────────────────────────────────────────────────────

export interface FoodBarTraceInput {
  requestId: string;
  userId: string;
  request: FoodBarRequestView;
  router: RouterView;
  /** The server's view of the card: lines it kept, whether they may be cut at
   *  the cap, and so whether it counted as open. */
  card: { lines: number; may_be_cut: boolean; open: boolean };
  /** What decideFoodAction chose, before any follow-up call ran. Null when the
   *  request never reached the decision (refused, threw). */
  planned: string | null;
  /** What the food box actually did. */
  action: string | null;
  /** Why action differs from planned, or why a fallback answered. */
  fallback: string | null;
  /** parse (the first parse) or food_agent: whose meal was served. */
  answeredBy: string | null;
  tierUsed: string | null;
  served: ServedView;
  steps: TraceStep[];
  calls: ModelCallRecord[];
  latencyMs: number;
  status: "ok" | "error" | "refused";
  error: string | null;
}

const STEPS_MAX = 400;
const CALLS_MAX = 80;

export function buildFoodBarTraceRow(i: FoodBarTraceInput): Record<string, unknown> {
  const anthropic = i.calls.filter((c) => c.provider === "anthropic");
  const sum = (xs: ModelCallRecord[], k: "input_tokens" | "output_tokens") => xs.reduce((n, c) => n + (c[k] ?? 0), 0);
  const ordered = orderSteps(i.steps);
  const calls = [...i.calls].sort((a, b) => a.at_ms - b.at_ms);
  return {
    request_id: i.requestId,
    user_id: i.userId,
    status: i.status,
    error: i.error ? i.error.slice(0, 500) : null,
    input_text: i.request.text,
    meal_hint: i.request.meal_hint,
    speed: i.request.speed,
    tier_used: i.tierUsed,
    streamed: i.request.streamed,
    client_id: i.request.client_id,
    auto_log: i.request.auto_log,
    can_create: i.request.can_create,
    request: i.request,
    card_lines: i.card.lines,
    card_may_be_cut: i.card.may_be_cut,
    card_open: i.card.open,
    recent_turns_sent: i.request.recent_turns_sent,
    router_intent: i.router.intent,
    router_confidence: i.router.confidence,
    router_source: i.router.source,
    router: i.router,
    planned_action: i.planned,
    served_action: i.action,
    fallback: i.fallback,
    answered_by: i.answeredBy,
    served_kind: i.served.kind,
    served: i.served,
    steps: ordered.slice(0, STEPS_MAX),
    steps_dropped: Math.max(0, ordered.length - STEPS_MAX),
    model_calls: calls.slice(0, CALLS_MAX),
    anthropic_calls: anthropic.length,
    jev_calls: i.calls.length - anthropic.length,
    input_tokens: sum(anthropic, "input_tokens"),
    output_tokens: sum(anthropic, "output_tokens"),
    latency_ms: Math.round(i.latencyMs),
  };
}

/** Why the served action is not the planned one, in one short word, or null.
 *  The reasons are the ones resolveFoodBarOutcome can produce. */
export function fallbackReason(o: {
  planned: string | null;
  action: string | null;
  followupError?: string | null;
  agentKind?: string | null;
  agentReason?: string | null;
  agentRan: boolean;
}): string | null {
  if (!o.planned || !o.action) return null;
  if (o.planned === "agent") {
    if (!o.agentRan) return "agent_did_not_start";
    if (o.agentKind === "failed") return `agent_failed:${o.agentReason ?? "unknown"}`;
    return null;
  }
  if (o.planned !== o.action) return `${o.planned}_failed:${o.followupError ?? "unknown"}`;
  return null;
}
