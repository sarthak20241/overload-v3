// The speech engine, behind one interface, so the vendor can change without
// touching the handler or the app.
//
// Today's engine is OpenAI `gpt-transcribe` ($0.0045 per minute on the pricing
// page, 2026-11-28). It replaces gpt-4o-transcribe and whisper-1, which shut
// down 2027-02-26.
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

export type SttFailure = "timeout" | "vendor_busy" | "vendor_error";

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
        if (typeof data?.text !== "string") return { ok: false, reason: "vendor_error" };
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

/** The engine for this deploy, from its secrets. Null when none is set up,
 *  which the handler answers with 503 not_configured. */
export function pickProvider(env: Record<string, string | undefined>, fetchFn?: typeof fetch): SttProvider | null {
  const which = (env.STT_PROVIDER ?? "openai").trim().toLowerCase();
  if (which === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    const languages = (env.STT_LANGUAGES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(s));
    return openAiProvider({
      apiKey,
      fetchFn,
      model: env.STT_MODEL?.trim() || OPENAI_STT_MODEL,
      languages,
    });
  }
  // "wispr" lands here until its provider is written (see the top of file).
  return null;
}
