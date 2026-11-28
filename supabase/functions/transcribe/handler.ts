// POST /transcribe: one short voice clip in, its text out.
//
// The app records a clip (food box or Drona chat), sends it here as
// multipart (`audio` file + `purpose`), and puts the text in the input box
// for the user to read and send. Nothing is sent on the user's behalf.
//
// Order, cheapest refusal first, and nothing paid before it is allowed:
//   method -> declared size -> Clerk JWT -> engine set up -> access ->
//   body (read with a byte limit) -> the clip's own size, format and length
//   -> rate-limit slot -> vocabulary -> engine -> (chat only) cleanup -> text.
// Access comes before the body, so a caller with no in-app AI never has a
// megabyte buffered for them.
// An engine failure that most likely billed nothing gives its slot back.
//
// Privacy: the audio is held in memory for this request only. It is never
// written to storage or a log, and neither is the transcript or the user's
// food names: `log` gets sizes, timings and statuses only.
//
// Every side effect is a dependency, so the rules are tested without a
// network (transcribe.test.ts); index.ts wires them to Clerk, Supabase and
// the engine.

import { inspectAudio, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, MIN_AUDIO_SECONDS } from "./audio.ts";
import { type CleanupCall, cleanTranscript } from "./cleanup.ts";
import type { SttProvider, VoicePurpose } from "./stt.ts";
import { buildVocabulary, contextFor } from "./vocabulary.ts";

export interface TranscribeDeps {
  verify(authHeader: string | null): Promise<{ sub: string } | { error: string }>;
  /** get_coach_access_status() for this caller. */
  access(authHeader: string): Promise<{ state?: string; ai_blocked?: boolean } | { error: string }>;
  /** One slot of the voice rate limit (migration 20261128120000). */
  reserve(
    authHeader: string,
    free: boolean,
  ): Promise<{ ok: true; slotId: number } | { ok: false; retryAfterSeconds: number; reason: string } | { error: string }>;
  /** The names of foods this user logs, most recent first. */
  userFoods(authHeader: string): Promise<string[]>;
  /** Give back the slot this request was granted (the engine failed before
   *  it billed). Runs as the service role: clients cannot call it. */
  release(userId: string, slotId: number): Promise<void>;
  provider: SttProvider | null;
  /** Null turns the chat cleanup off (no Anthropic key). */
  cleanup: CleanupCall | null;
  log(event: Record<string, unknown>): void;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// The multipart wrapper around the file is a few hundred bytes. Anything
// declaring more than this is refused before its body is read, and a body
// with no declared length (chunked) is cut off as soon as it passes it.
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + 64 * 1024;

/** The body, read up to `max` bytes; null once it passes `max`. */
async function readLimited(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Engine failures that give the slot back: a 429, or a refused or broken
 *  call with no answer. Most of these bill nothing; a 5xx after the vendor
 *  started work might, and the day cap bounds that. A timeout or a 200 with
 *  a bad body may well have been billed, so their slots stay spent. */
const REFUNDED: ReadonlySet<string> = new Set(["vendor_busy", "vendor_error"]);

export async function handleTranscribe(req: Request, deps: TranscribeDeps): Promise<Response> {
  const started = Date.now();
  const ev: Record<string, unknown> = {};
  const done = (status: string, res: Response) => {
    deps.log({ status, http: res.status, latency_ms: Date.now() - started, ...ev });
    return res;
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return done("method_not_allowed", json({ error: "method_not_allowed" }, 405));

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    ev.bytes = declared;
    return done("too_large", json({ error: "too_large", max_bytes: MAX_AUDIO_BYTES }, 413));
  }

  const authHeader = req.headers.get("Authorization");
  const claims = await deps.verify(authHeader);
  if ("error" in claims) return done("unauthorized", json({ error: "Unauthorized" }, 401));
  ev.user_id = claims.sub;

  const provider = deps.provider;
  if (!provider) return done("not_configured", json({ error: "not_configured" }, 503));
  ev.provider = provider.name;

  // Voice follows the AI food log's gate: every signed-in plan with in-app
  // AI (free, trial, Pro), never Connect, whose AI is the user's own.
  const access = await deps.access(authHeader!);
  if ("error" in access) return done("access_failed", json({ error: "Access check failed" }, 500));
  const state = access.state ?? "unauthenticated";
  ev.state = state;
  if (state !== "paid" && state !== "trialing" && state !== "free") {
    return done("no_access", json({ error: "drona_access_required", state }, 402));
  }
  if (access.ai_blocked === true) {
    return done("connect_no_ai", json({ error: "pro_required", state: "free", feature: "voice", plan: "connect" }, 402));
  }

  const body = await readLimited(req, MAX_BODY_BYTES);
  if (!body) return done("too_large", json({ error: "too_large", max_bytes: MAX_AUDIO_BYTES }, 413));
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return done("bad_request", json({ error: "bad_request", detail: "expected multipart form data" }, 400));
  }
  const purposeRaw = form.get("purpose");
  if (purposeRaw !== "food" && purposeRaw !== "chat") {
    return done("bad_request", json({ error: "bad_request", detail: "purpose must be food or chat" }, 400));
  }
  const purpose: VoicePurpose = purposeRaw;
  ev.purpose = purpose;
  const file = form.get("audio");
  if (!(file instanceof File)) return done("bad_request", json({ error: "bad_request", detail: "audio file missing" }, 400));

  ev.bytes = file.size;
  if (file.size > MAX_AUDIO_BYTES) return done("too_large", json({ error: "too_large", max_bytes: MAX_AUDIO_BYTES }, 413));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const audio = inspectAudio(bytes);
  if (!audio.ok) return done("bad_audio", json({ error: "bad_audio" }, 422));
  ev.format = audio.format;
  ev.audio_s = audio.seconds;
  if (audio.seconds > MAX_AUDIO_SECONDS) {
    return done("too_long", json({ error: "too_long", max_seconds: MAX_AUDIO_SECONDS }, 413));
  }
  if (audio.seconds < MIN_AUDIO_SECONDS) return done("too_short", json({ error: "too_short" }, 422));

  if (!provider.formats.includes(audio.format)) {
    return done("unsupported_format", json({ error: "unsupported_format", formats: provider.formats }, 415));
  }

  const slot = await deps.reserve(authHeader!, state === "free");
  if ("error" in slot) return done("rate_limit_failed", json({ error: "Rate limit check failed" }, 500));
  if (!slot.ok) {
    ev.reason = slot.reason;
    return done(
      "rate_limited",
      json({ error: "voice_rate_limited", reason: slot.reason, retry_after_seconds: slot.retryAfterSeconds }, 429),
    );
  }

  let userFoods: string[] = [];
  if (purpose === "food") {
    try {
      userFoods = await deps.userFoods(authHeader!);
    } catch {
      ev.vocab_read_failed = true;
    }
  }
  const vocabulary = buildVocabulary(userFoods, purpose);
  ev.keywords = vocabulary.length;

  const heard = await provider.transcribe(
    { bytes, format: audio.format, seconds: audio.seconds },
    { purpose, vocabulary, context: contextFor(purpose) },
  );
  if (!heard.ok) {
    ev.reason = heard.reason;
    if (REFUNDED.has(heard.reason)) {
      try {
        await deps.release(claims.sub, slot.slotId);
        ev.slot_released = true;
      } catch {
        ev.slot_released = false;
      }
    }
    return done("stt_failed", json({ error: "stt_failed", reason: heard.reason }, 502));
  }
  ev.model = heard.model;
  ev.chars = heard.text.length;

  let text = heard.text.trim();
  let cleaned = false;
  if (purpose === "chat" && deps.cleanup && text) {
    const tidy = await cleanTranscript(text, vocabulary, deps.cleanup);
    text = tidy.text;
    cleaned = tidy.cleaned;
    if (!tidy.cleaned && tidy.rejected) ev.cleanup_rejected = tidy.rejected;
  }
  ev.cleaned = cleaned;

  return done(text ? "ok" : "empty", json({ text, provider: provider.name, audio_seconds: audio.seconds, cleaned }));
}
