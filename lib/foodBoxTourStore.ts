/**
 * Whether this user has had the food box tour (lib/foodBoxTour). Per user, on
 * the device: a second account on the same phone gets its own first time.
 * Absence of the key = not yet, the lib/autoLog idiom.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const keyFor = (userId: string) => `overload.foodBoxTour.done.${userId}`;

export async function getFoodBoxTourDone(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(keyFor(userId))) === '1';
  } catch {
    // Unreadable storage: say done. A missed tour costs nothing; a tour that
    // comes back on every open is the thing to avoid.
    return true;
  }
}

export async function setFoodBoxTourDone(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(userId), '1');
  } catch {
    // The worst case is one more tour on the next open.
  }
}
