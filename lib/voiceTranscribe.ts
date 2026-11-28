/**
 * Upload one recorded clip to the transcribe edge function and get its text.
 *
 * Multipart with the file's own uri (React Native's fetch streams it from
 * disk), so the clip is never base64'd in JS memory. An expired Clerk token
 * gets one retry with a fresh one (lib/authRetry.ts), as every other call
 * does. The local file is deleted once the server has answered or the upload
 * failed: no clip is kept on the phone either.
 *
 * Dev only: EXPO_PUBLIC_VOICE_URL points the upload at a local server
 * (scripts/voice-eval/dev-server.ts, the real handler with the fake engine),
 * so the whole flow runs on a simulator without a speech key. Ignored in a
 * store build.
 */
import { File } from 'expo-file-system';
import { sendWithFreshTokenRetry } from '@/lib/authRetry';
import { getFreshSupabaseAccessToken, getSupabaseAccessToken } from '@/lib/supabase';
import { transcribeOutcome, type TranscribeOutcome, VOICE_FORMAT } from '@/lib/voiceInput';

const UPLOAD_TIMEOUT_MS = 30_000;

function endpoint(): string {
  const dev = __DEV__ ? process.env.EXPO_PUBLIC_VOICE_URL : undefined;
  if (dev) return dev;
  // Same region pin as the food parse (lib/dietData.ts): the query parameter
  // and the x-region header below.
  return `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/transcribe?forceFunctionRegion=us-east-1`;
}

export function deleteClip(uri: string | null | undefined) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Already gone, or in a folder the OS clears on its own (cache).
  }
}

export async function transcribeClip(uri: string, purpose: 'food' | 'chat'): Promise<TranscribeOutcome> {
  const token = await getSupabaseAccessToken();
  if (!token) return transcribeOutcome(401, null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const send = (t: string) => {
    const form = new FormData();
    // React Native's FormData takes a file as { uri, name, type }.
    form.append('audio', { uri, name: `clip.${VOICE_FORMAT}`, type: 'audio/mp4' } as unknown as Blob);
    form.append('purpose', purpose);
    return fetch(endpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'x-region': 'us-east-1' },
      body: form,
      signal: controller.signal,
    });
  };
  try {
    const res = await sendWithFreshTokenRetry(send, token, getFreshSupabaseAccessToken);
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return transcribeOutcome(res.status, body);
  } catch {
    return transcribeOutcome(0, null);
  } finally {
    clearTimeout(timer);
    deleteClip(uri);
  }
}
