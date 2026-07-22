/**
 * Stable anonymous device id for the guest-first onboarding plan route.
 *
 * Kept in SecureStore rather than AsyncStorage on purpose: on iOS the keychain
 * survives an app-data clear (and often a reinstall), so the per-device rate
 * limit can't be reset just by clearing data. It's a fairness key, not a
 * security control - the IP and global caps are the real abuse ceiling - so a
 * best-effort in-memory fallback is fine when SecureStore is unavailable.
 */
import * as SecureStore from 'expo-secure-store';
import { newClientId } from '@/lib/syncQueue';

const DEVICE_ID_KEY = 'overload_device_id_v1';

let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
    const fresh = newClientId();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    // SecureStore unavailable (rare): fall back to a per-session id. The plan
    // still generates; only the persistence of the rate-limit key is weaker.
    cached = cached ?? newClientId();
    return cached;
  }
}
