/**
 * Voice input: the rules, with no native or network imports, so Deno tests
 * them directly (lib/voiceInput.test.ts). The mic itself is
 * components/voice/MicButton.tsx; the upload is lib/voiceTranscribe.ts; the
 * server is supabase/functions/transcribe.
 *
 * The flow, for both the food box and Drona chat: tap the mic, speak, tap
 * again (or it stops itself at a minute). The clip is uploaded, the text
 * comes back, and it is ADDED to whatever is already in the box for the user
 * to read and send. Voice never sends anything by itself.
 */

/** The app stops recording here. The server allows a little over a minute
 *  (transcribe/audio.ts MAX_AUDIO_SECONDS) for a stop that lands late. */
export const MAX_CLIP_MS = 60_000;
/** A tap-tap with nothing said. Dropped on the phone, never uploaded. */
export const MIN_CLIP_MS = 500;

/**
 * What the recorder is asked for: mono AAC at 16 kHz and 32 kbps in an m4a.
 * Speech engines resample to 16 kHz anyway, so more is only upload time on a
 * slow connection: 60 s is about 240 KB. Plain data (no expo-audio import);
 * the shape is expo-audio's RecordingOptions. `ios.outputFormat` is
 * IOSOutputFormat.MPEG4AAC, `audioQuality` 64 is AudioQuality.MEDIUM.
 *
 * Swapping to an engine that needs WAV (Wispr Flow takes 16 kHz PCM): record
 * with ios.outputFormat 'lpcm', android has no PCM encoder in MediaRecorder,
 * so that swap needs a server-side decode or a PCM recorder there.
 */
export const VOICE_RECORDING = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: 'aac ', audioQuality: 64 },
  web: { mimeType: 'audio/webm', bitsPerSecond: 32000 },
} as const;

export const VOICE_FORMAT = 'm4a' as const;

/** Add what was said after what is typed. Never replaces typed text, never
 *  pushes the box past `max` (the transcript is cut at a word instead). */
export function insertTranscript(current: string, said: string, max?: number): string {
  const words = said.replace(/\s+/g, ' ').trim();
  if (!words) return current;
  if (!current.trim()) return max ? cutAtWord(words, max) : words;
  const base = current.replace(/[ \t]+$/, '');
  const joiner = base.endsWith('\n') ? '' : ' ';
  const joined = base + joiner + words;
  if (!max || joined.length <= max) return joined;
  const room = max - base.length - joiner.length;
  if (room <= 0) return current;
  const part = cutAtWord(words, room);
  return part ? base + joiner + part : current;
}

function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space) : cut;
}

export interface MicPermission {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}

export type MicStep = 'record' | 'explain' | 'settings' | 'unavailable';

/**
 * What a tap on the mic does, from the phone's answer.
 *   record       permission is on
 *   explain      our own words first, then the phone's prompt (a first ask,
 *                or a "no" the phone still lets us ask again)
 *   settings     the phone will not ask again: offer Settings
 *   unavailable  no recorder on this build
 */
export function micStep(p: MicPermission | null): MicStep {
  if (!p) return 'unavailable';
  if (p.granted) return 'record';
  return p.canAskAgain ? 'explain' : 'settings';
}

/** The first app version whose binary declares the microphone (iOS usage
 *  string, Android RECORD_AUDIO). On an older binary iOS would end the app
 *  the moment it asked for the mic, so the button is not shown there. */
export const VOICE_FROM_VERSION = [1, 0, 6];

export function voiceSupported(env: {
  nativeVersion: string | null;
  platform: string;
  isDev: boolean;
  /** EXPO_PUBLIC_VOICE_DEV=1: a dev client rebuilt from this app.json. */
  devFlag: boolean;
}): boolean {
  if (env.platform !== 'ios' && env.platform !== 'android') return false;
  if (env.isDev && env.devFlag) return true;
  if (!env.nativeVersion) return false;
  const parts = env.nativeVersion.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < VOICE_FROM_VERSION.length; i++) {
    const a = parts[i] ?? 0;
    if (a !== VOICE_FROM_VERSION[i]) return a > VOICE_FROM_VERSION[i];
  }
  return true;
}

/** The recorder's meter (dBFS, about -160 silent to 0 loud) as 0..1 for the
 *  level ring. Room noise sits near -55, speech around -30 to -10. */
export function levelFromMetering(db: number | undefined): number {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 55) / 55));
}

export type TranscribeOutcome =
  | { ok: true; text: string }
  | {
    ok: false;
    kind:
      | 'nothing_heard'
      | 'too_long'
      | 'too_large'
      | 'bad_audio'
      | 'rate_limited'
      | 'no_access'
      | 'unavailable'
      | 'failed'
      | 'offline';
    message: string;
  };

/** The server's answer (status 0 = never reached) as text or the words to show. */
export function transcribeOutcome(status: number, body: Record<string, unknown> | null): TranscribeOutcome {
  const error = typeof body?.error === 'string' ? body.error : null;
  if (status === 200) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    return text ? { ok: true, text } : fail('nothing_heard');
  }
  if (status === 0) return fail('offline');
  if (error === 'too_short') return fail('nothing_heard');
  if (error === 'too_long') return fail('too_long');
  if (error === 'too_large') return fail('too_large');
  if (error === 'bad_audio') return fail('bad_audio');
  if (status === 429) {
    const secs = Number(body?.retry_after_seconds ?? 0) || 60;
    const wait = secs >= 3600 ? `${Math.ceil(secs / 3600)} h` : `${Math.max(1, Math.ceil(secs / 60))} min`;
    return { ok: false, kind: 'rate_limited', message: `That's a lot of talking for now. Try the mic again in ${wait}.` };
  }
  if (status === 402) return fail('no_access');
  if (status === 503) return fail('unavailable');
  return fail('failed');
}

const MESSAGES: Record<Exclude<TranscribeOutcome, { ok: true }>['kind'], string> = {
  nothing_heard: "I didn't catch that. Try again a little closer to the mic.",
  too_long: 'That ran past a minute. Keep it shorter and tap again.',
  too_large: 'That clip was too big to send. Keep it shorter and tap again.',
  bad_audio: "That recording didn't come through. Tap the mic and try again.",
  rate_limited: "That's a lot of talking for now. Try the mic again soon.",
  no_access: "Voice comes with in-app AI, and your plan doesn't include it. You can still type.",
  unavailable: "Voice isn't switched on yet. Type it for now.",
  failed: "I couldn't make that out. Try again, or type it.",
  offline: 'No connection right now. Type it, or try the mic again in a moment.',
};

function fail(kind: keyof typeof MESSAGES): TranscribeOutcome {
  return { ok: false, kind, message: MESSAGES[kind] };
}

/** The words around the phone's own mic prompt. They must stay true: the
 *  clip goes to the speech service (OpenAI) to be written out; for a food
 *  log, the names of foods the user logs go with it as spelling hints; a
 *  chat question's words are tidied by Drona's model (Anthropic) before
 *  they land in the box. Overload keeps neither the audio nor the words. */
export const MIC_COPY = {
  explainTitle: 'Talk instead of typing',
  explainBody:
    "Tap the mic, say it, tap again. I'll write it out in the box so you can check it before you send. " +
    'The clip goes to our speech service to be turned into text, with the food names you log so it spells them right. ' +
    "For questions to me, our AI tidies the words. We don't keep the clip.",
  explainAllow: 'Turn on the mic',
  explainLater: 'Not now',
  settingsTitle: 'The mic is off for Overload',
  settingsBody: 'Turn on Microphone for Overload in Settings to talk instead of type. Typing always works.',
  settingsOpen: 'Open Settings',
  settingsLater: 'Not now',
  deniedToast: 'No problem. Typing works just as well.',
} as const;
