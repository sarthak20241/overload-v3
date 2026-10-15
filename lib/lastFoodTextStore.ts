// Phone storage for lib/lastFoodText. A failure is a lost draft, never a
// failed send.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LastFoodText } from './lastFoodText';

const KEY = 'overload.foodBox.lastSent';

export async function loadLastFoodText(): Promise<LastFoodText | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastFoodText>;
    return typeof v.text === 'string' && typeof v.at === 'number'
      ? { text: v.text, at: v.at, userId: typeof v.userId === 'string' ? v.userId : null }
      : null;
  } catch {
    return null;
  }
}

export async function saveLastFoodText(last: LastFoodText): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    // A lost draft costs one retype.
  }
}
