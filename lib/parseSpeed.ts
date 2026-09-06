/**
 * The user's food-parse tier: Quick (fast mode, estimate-first, the default),
 * Thorough (the full catalog + decide pipeline), or Precise (Pro: Drona reads
 * the product's real numbers off the web, cross-checks two sources, and banks
 * the answer so the next log of the same food is free and instant).
 *
 * Sticky per device via AsyncStorage, guestMode's idiom: the default is the
 * ABSENCE of the key, so a fresh install, a cleared cache, or a storage error
 * all land on Quick. Corrections ignore this entirely - a follow-up on a meal
 * under review always runs the full pipeline, which is the existing behaviour
 * in nutrition.tsx, not something this flag controls.
 *
 * Entitlement is NOT stored here. Precise is Pro-only, but a preference that
 * remembered "you were Pro" would strand a lapsed subscriber on a tier the
 * server now refuses. The stored value is only what the user asked for; who is
 * allowed to have it is read live from useCoachAccess at the call site
 * (effectiveParseSpeed), which degrades Precise to Thorough rather than letting
 * a stale preference turn into a 402 the user cannot log through.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ParseSpeed = 'quick' | 'thorough' | 'precise';

const KEY = 'overload.parseSpeed';

/** Wire value for a tier. The stored keys are the words the UI uses; the
 *  server's are the pipeline's own ('fast' / 'super', with smart being the
 *  absence of the field). Keeping the two vocabularies apart means renaming a
 *  tier in the sheet never silently changes which pipeline runs. */
export function parseSpeedWire(v: ParseSpeed): 'fast' | 'super' | null {
  if (v === 'quick') return 'fast';
  if (v === 'precise') return 'super';
  return null;
}

export async function getParseSpeed(): Promise<ParseSpeed> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v === 'thorough' || v === 'precise' ? v : 'quick';
  } catch {
    // Fail open to the default tier, never block logging on storage.
    return 'quick';
  }
}

export async function setParseSpeed(v: ParseSpeed): Promise<void> {
  try {
    if (v === 'quick') await AsyncStorage.removeItem(KEY);
    else await AsyncStorage.setItem(KEY, v);
  } catch {
    // Losing the preference is survivable; surfacing an error here is not worth it.
  }
}

/** Which tier actually runs, given what the user picked and what they are
 *  entitled to. Precise without Pro falls back to Thorough: the closest tier we
 *  can honour, and the one that keeps the log going. Deliberately NOT a silent
 *  drop to Quick - someone who asked for the most careful answer should not be
 *  handed the fastest one. */
export function effectiveParseSpeed(picked: ParseSpeed, canUsePrecise: boolean): ParseSpeed {
  return picked === 'precise' && !canUsePrecise ? 'thorough' : picked;
}
