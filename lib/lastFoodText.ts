// The last food text the user sent from the Nutrition box, kept on the phone so
// the empty box can offer it back ("use again"). People log the same breakfast
// most days and retype it whole: one user resent an 8-item message word for word
// 52 minutes later (live, 2026-10-14). Local only, never synced: it is the
// user's own draft, not diary data.
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface LastFoodText {
  text: string;
  /** When it was sent, epoch ms. */
  at: number;
}

const KEY = 'overload.foodBox.lastSent';
/** Offered back for this long. Past it, the last meal is history, not a draft. */
export const RECALL_MS = 12 * 60 * 60 * 1000;

export function isRecallable(last: LastFoodText | null, now: number): last is LastFoodText {
  return !!last && !!last.text.trim() && now - last.at >= 0 && now - last.at < RECALL_MS;
}

export async function loadLastFoodText(): Promise<LastFoodText | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastFoodText>;
    return typeof v.text === 'string' && typeof v.at === 'number' ? { text: v.text, at: v.at } : null;
  } catch {
    return null;
  }
}

export async function saveLastFoodText(last: LastFoodText): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    // A lost draft costs one retype; never fail a send over it.
  }
}
