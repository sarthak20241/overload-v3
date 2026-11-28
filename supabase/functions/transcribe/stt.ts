// The speech engine, behind one interface, so the vendor can change without
// touching the handler or the app.
//
// Two engines today: Google `gemini-3.5-transcribe` (the default when its key
// is set; free tier, $0.003 a minute paid) and OpenAI `gpt-transcribe`
// ($0.0045 a minute). Prices from their pricing pages, 2026-11-28.
//
// A Wispr Flow engine (invite-only today) fits the same shape:
//   - Wispr takes base64 16 kHz PCM WAV. A provider lists the formats it
//     takes (`formats`), and the handler refuses a clip in any other format,
//     so the swap is: the app records WAV (lib/voiceInput.ts VOICE_FORMAT),
//     and a `wispr` provider here maps `vocabulary` to `dictionary_context`,
//     `context` to `conversation`, and `languages` to `language`.
//   - pickProvider() below gets a `wispr` case reading its own key.
// Nothing else changes: the handler only ever sees SttProvider.

import type { AudioFormat } from "./audio.ts";

export type VoicePurpose = "food" | "chat";

export interface AudioClip {
  bytes: Uint8Array<ArrayBuffer>;
  format: AudioFormat;
  /** Read from the file's own header (audio.ts), not from the app. */
  seconds: number;
}

export interface TranscribeOptions {
  purpose: VoicePurpose;
  /** Words the engine should spell right: the user's foods, Indian dishes,
   *  training terms. One line each, already cleaned (vocabulary.ts). */
  vocabulary: string[];
  /** One or two sentences on what the speaker is doing. */
  context?: string;
  /** ISO-639-1 hints. Empty means let the engine detect. */
  languages?: string[];
}

/** timeout: no answer in time (it may still have run and billed).
 *  vendor_busy: a 429. vendor_error: any other refusal or a broken call.
 *  vendor_bad_reply: a 200 whose body has no text (answered, so billed). */
export type SttFailure = "timeout" | "vendor_busy" | "vendor_error" | "vendor_bad_reply";

export type SttResult =
  | {
    ok: true;
    text: string;
    audioSeconds: number;
    model: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  }
  | { ok: false; reason: SttFailure };

export interface SttProvider {
  /** Stable name, logged and returned to the app. */
  name: string;
  /** Clip formats this engine takes. */
  formats: AudioFormat[];
  transcribe(clip: AudioClip, opts: TranscribeOptions): Promise<SttResult>;
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

export const OPENAI_STT_MODEL = "gpt-transcribe";
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TIMEOUT_MS = 20_000;

const MIME: Record<AudioFormat, string> = { m4a: "audio/mp4", wav: "audio/wav" };

export function openAiProvider(cfg: {
  apiKey: string;
  fetchFn?: typeof fetch;
  model?: string;
  languages?: string[];
  timeoutMs?: number;
}): SttProvider {
  const fetchFn = cfg.fetchFn ?? fetch;
  const model = cfg.model ?? OPENAI_STT_MODEL;
  return {
    name: "openai",
    formats: ["m4a", "wav"],
    async transcribe(clip, opts) {
      // Multipart, as the docs show. `languages[]` and `keywords[]` are the
      // gpt-transcribe fields; the singular `language` must not be sent too.
      const form = new FormData();
      form.append("file", new File([clip.bytes], `clip.${clip.format}`, { type: MIME[clip.format] }));
      form.append("model", model);
      form.append("response_format", "json");
      for (const k of opts.vocabulary) form.append("keywords[]", k);
      for (const l of opts.languages ?? cfg.languages ?? []) form.append("languages[]", l);
      if (opts.context) form.append("prompt", opts.context);
      try {
        const res = await fetchFn(OPENAI_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(cfg.timeoutMs ?? OPENAI_TIMEOUT_MS),
        });
        if (!res.ok) {
          // Drain the body so the connection is released; never log it (it
          // can echo the request).
          await res.body?.cancel().catch(() => {});
          return { ok: false, reason: res.status === 429 ? "vendor_busy" : "vendor_error" };
        }
        const data = await res.json() as {
          text?: unknown;
          usage?: { type?: string; input_tokens?: number; output_tokens?: number };
        };
        if (typeof data?.text !== "string") return { ok: false, reason: "vendor_bad_reply" };
        const u = data.usage;
        return {
          ok: true,
          text: data.text,
          audioSeconds: clip.seconds,
          model,
          ...(u && u.type === "tokens" ? { usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens } } : {}),
        };
      } catch (e) {
        const name = (e as Error)?.name;
        return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "vendor_error" };
      }
    },
  };
}

// ── Gemini ─────────────────────────────────────────────────────────────────
//
// Google's speech-to-text model, gemini-3.5-transcribe, through the
// Interactions endpoint (docs: aistudio.google.com/docs/transcribe,
// 2026-11-28). Paid: $0.003 a minute of audio. Free tier: no charge, BUT on
// the free tier Google uses what is sent to improve its products and human
// reviewers may read it; its terms say not to send personal information
// there. A key from a Cloud project with billing on is the paid tier.
//
// The docs show no complete inline-audio example; this request is put
// together from the documented fields (input part type/data/mime_type, and
// generation_config.transcription_config language_codes/custom_vocabulary).
// Checked against the live API on 2026-11-28: an m4a and a wav clip both came
// back word for word.
// Verbatim mode (the default): the chat tidy-up does the cleaning, checked.

export const GEMINI_STT_MODEL = "gemini-3.5-transcribe";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_TIMEOUT_MS = 20_000;
/** Google's list has audio/m4a and audio/wav (not audio/mp4). */
const GEMINI_MIME: Record<AudioFormat, string> = { m4a: "audio/m4a", wav: "audio/wav" };

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function geminiProvider(cfg: {
  apiKey: string;
  fetchFn?: typeof fetch;
  model?: string;
  /** BCP-47, e.g. en-IN, hi-IN. Empty: the model detects the language. */
  languages?: string[];
  timeoutMs?: number;
}): SttProvider {
  const fetchFn = cfg.fetchFn ?? fetch;
  const model = cfg.model ?? GEMINI_STT_MODEL;
  return {
    name: "gemini",
    formats: ["m4a", "wav"],
    async transcribe(clip, opts) {
      const transcription_config: Record<string, unknown> = { language_codes: opts.languages ?? cfg.languages ?? [] };
      // Google: up to 1,000 terms, best results up to 100. We send at most 80.
      if (opts.vocabulary.length) transcription_config.custom_vocabulary = opts.vocabulary;
      try {
        const res = await fetchFn(GEMINI_URL, {
          method: "POST",
          headers: { "x-goog-api-key": cfg.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            input: [{ type: "audio", data: base64(clip.bytes), mime_type: GEMINI_MIME[clip.format] }],
            generation_config: { transcription_config },
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? GEMINI_TIMEOUT_MS),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return { ok: false, reason: res.status === 429 ? "vendor_busy" : "vendor_error" };
        }
        const data = await res.json() as {
          status?: string;
          steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
          usage?: Record<string, unknown>;
        };
        const text = (data?.steps ?? [])
          .filter((st) => st?.type === "model_output")
          .flatMap((st) => st.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
        if (data?.status !== "completed" || !text) return { ok: false, reason: "vendor_bad_reply" };
        const u = data.usage ?? {};
        const num = (v: unknown) => (typeof v === "number" ? v : undefined);
        // A live reply (2026-11-28) names them total_input_tokens and
        // total_output_tokens; the plain names are kept as a fallback.
        const usage = {
          input_tokens: num(u.total_input_tokens) ?? num(u.input_tokens),
          output_tokens: num(u.total_output_tokens) ?? num(u.output_tokens),
        };
        return {
          ok: true,
          text,
          audioSeconds: clip.seconds,
          model,
          ...(usage.input_tokens !== undefined || usage.output_tokens !== undefined ? { usage } : {}),
        };
      } catch (e) {
        const name = (e as Error)?.name;
        return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "vendor_error" };
      }
    },
  };
}

// ── Fake (tests and the local dev server only) ─────────────────────────────

export interface FakeProvider extends SttProvider {
  calls: { clip: AudioClip; opts: TranscribeOptions }[];
}

/** Answers with `text` (or fails with `fail`) and records every call. Never
 *  reachable from production: pickProvider() has no case for it. */
export function fakeProvider(cfg: { text?: string | ((clip: AudioClip, opts: TranscribeOptions) => string); fail?: SttFailure }): FakeProvider {
  const calls: FakeProvider["calls"] = [];
  return {
    name: "fake",
    formats: ["m4a", "wav"],
    calls,
    transcribe(clip, opts) {
      calls.push({ clip, opts });
      if (cfg.fail) return Promise.resolve({ ok: false, reason: cfg.fail });
      const text = typeof cfg.text === "function" ? cfg.text(clip, opts) : cfg.text ?? "";
      return Promise.resolve({ ok: true, text, audioSeconds: clip.seconds, model: "fake" });
    },
  };
}

// ── Choice ─────────────────────────────────────────────────────────────────

/** The engine for this deploy, from its secrets. STT_PROVIDER picks one;
 *  without it, Gemini when GEMINI_API_KEY is set, else OpenAI. Null when the
 *  chosen engine has no key, which the handler answers with 503. */
export function pickProvider(env: Record<string, string | undefined>, fetchFn?: typeof fetch): SttProvider | null {
  const chosen = env.STT_PROVIDER?.trim().toLowerCase();
  const which = chosen || (env.GEMINI_API_KEY?.trim() ? "gemini" : "openai");
  const rawLanguages = (env.STT_LANGUAGES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (which === "gemini") {
    const apiKey = env.GEMINI_API_KEY?.trim();
    if (!apiKey) return null;
    return geminiProvider({
      apiKey,
      fetchFn,
      model: env.STT_MODEL?.trim() || GEMINI_STT_MODEL,
      // BCP-47 as Google takes it: en-IN, hi-IN.
      languages: rawLanguages.filter((s) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(s)),
    });
  }
  if (which === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    return openAiProvider({
      apiKey,
      fetchFn,
      model: env.STT_MODEL?.trim() || OPENAI_STT_MODEL,
      languages: rawLanguages.map((s) => s.toLowerCase()).filter((s) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(s)),
    });
  }
  // "wispr" lands here until its provider is written (see the top of file).
  return null;
}
