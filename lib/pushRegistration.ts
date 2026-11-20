/**
 * Server push wiring: save this phone's Expo push token for the signed-in
 * account (save_push_token), take it off on sign-out (clear_push_token), and
 * ask for permission at the moment lib/pushAsk.ts picks (a food log on a
 * second logging day). The server side is supabase/functions/drona-push.
 *
 * Everything here is best-effort and never throws: a missing token only means
 * Drona cannot reach this phone, never that a food log failed.
 */

import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { getExpoPushToken, getPushPermission, requestNotificationPermission } from '@/lib/notifications';
import { ASK_COPY, askDecision, noteFoodDay } from '@/lib/pushAsk';
import { localDayISO } from '@/lib/bodyLog';
import { track } from '@/lib/analytics';

const TOKEN_KEY = 'push.token.v1'; // { token, savedAt }
const DAYS_KEY = 'push.foodDays.v1';
const ASKED_KEY = 'push.askedAt.v1';
/** A token already saved is saved again at most this often (a phone switch moves it sooner). */
const RESAVE_MS = 12 * 60 * 60 * 1000;

const projectId = (): string | undefined =>
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
  (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

type SavedToken = { token: string; userId: string | null; savedAt: number };

/**
 * Save the token when permission is already granted. Never asks. A save for
 * the same account inside RESAVE_MS is skipped before the native token call.
 * `userId` (from PushSync) catches a phone that changed account without the
 * sign-out path; callers without it (a food log) only refresh.
 */
export async function syncPushToken(opts: { force?: boolean; userId?: string } = {}): Promise<boolean> {
  if (!isSupabaseConfigured || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return false;
  try {
    const saved = await readJson<SavedToken>(TOKEN_KEY);
    const sameUser = !opts.userId || saved?.userId === opts.userId;
    if (!opts.force && saved && sameUser && Date.now() - saved.savedAt < RESAVE_MS) return true;
    const token = await getExpoPushToken(projectId());
    if (!token) return false;
    let tz: string | null = null;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch { /* no zone */ }
    const { data, error } = await supabase.rpc('save_push_token', { p_token: token, p_platform: Platform.OS, p_tz: tz });
    if (error || data !== true) return false;
    const record: SavedToken = { token, userId: opts.userId ?? saved?.userId ?? null, savedAt: Date.now() };
    await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign-out: stop this account's pushes to this phone. Call BEFORE Clerk drops
 * the session, while the JWT still names the account.
 */
export async function clearPushToken(): Promise<void> {
  try {
    const saved = await readJson<{ token: string }>(TOKEN_KEY);
    await AsyncStorage.multiRemove([TOKEN_KEY, DAYS_KEY, ASKED_KEY]);
    if (saved?.token && isSupabaseConfigured) {
      await supabase.rpc('clear_push_token', { p_token: saved.token });
    }
  } catch {
    /* best-effort: the server drops it anyway once Expo reports it dead */
  }
}

/**
 * A food log landed. Fire and forget from every place that tracks
 * meal_logged. On the second logging day (and never before), Drona asks.
 */
export function noteFoodLogged(): void {
  void (async () => {
    try {
      const days = noteFoodDay((await readJson<string[]>(DAYS_KEY)) ?? [], localDayISO());
      await AsyncStorage.setItem(DAYS_KEY, JSON.stringify(days));
      const decision = askDecision({
        days,
        askedAt: await AsyncStorage.getItem(ASKED_KEY),
        perm: await getPushPermission(),
        now: new Date().toISOString(),
      });
      if (decision === 'sync') {
        await syncPushToken();
      } else if (decision === 'ask') {
        await AsyncStorage.setItem(ASKED_KEY, new Date().toISOString());
        // Let the saved meal settle on screen first.
        setTimeout(askNow, 1200);
      }
    } catch {
      /* never in the way of a food log */
    }
  })();
}

function askNow(): void {
  track('push_ask_shown');
  Alert.alert(ASK_COPY.title, ASK_COPY.body, [
    { text: ASK_COPY.no, style: 'cancel', onPress: () => track('push_ask_answered', { answer: 'not_now' }) },
    {
      text: ASK_COPY.yes,
      onPress: () => {
        track('push_ask_answered', { answer: 'yes' });
        void requestNotificationPermission().then((granted) => {
          if (granted) void syncPushToken({ force: true });
        });
      },
    },
  ]);
}
