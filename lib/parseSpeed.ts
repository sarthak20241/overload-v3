/**
 * The user's food-parse tier: Quick (fast mode, estimate-first, the default)
 * or Thorough (the full catalog + decide pipeline).
 *
 * Sticky per device via AsyncStorage, guestMode's idiom: the default is the
 * ABSENCE of the key, so a fresh install, a cleared cache, or a storage error
 * all land on Quick. Corrections ignore this entirely - a follow-up on a meal
 * under review always runs the full pipeline, which is the existing behaviour
 * in nutrition.tsx, not something this flag controls.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ParseSpeed = 'quick' | 'thorough';

const KEY = 'overload.parseSpeed';

export async function getParseSpeed(): Promise<ParseSpeed> {
  try {
    return (await AsyncStorage.getItem(KEY)) === 'thorough' ? 'thorough' : 'quick';
  } catch {
    // Fail open to the default tier, never block logging on storage.
    return 'quick';
  }
}

export async function setParseSpeed(v: ParseSpeed): Promise<void> {
  try {
    if (v === 'thorough') await AsyncStorage.setItem(KEY, v);
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // Losing the preference is survivable; surfacing an error here is not worth it.
  }
}
