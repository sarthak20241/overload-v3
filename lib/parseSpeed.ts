/**
 * The user's food-parse tier: Quick (fast mode, estimate-first, the default)
 * or Precise (Pro: Drona reads the product's real numbers off the web,
 * cross-checks two sources, and banks the answer so the next log of the same
 * food is free and instant).
 *
 * There used to be a third, Thorough (the full catalog + decide pipeline with
 * no speed field). It is no longer offered: a device that still stores it
 * reads as Quick. Logged rows keep their 'thorough' tier label; only the pick
 * is gone.
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
 * (effectiveParseSpeed), which degrades Precise to Quick rather than letting
 * a stale preference turn into a 402 the user cannot log through.
 *
 * Two screens pick the tier (the Nutrition food box and the food search), so
 * the last pick is also kept in memory: a screen that comes back into focus
 * reads it at once (peekParseSpeed) instead of waiting on storage while a
 * hand-off from the other screen is already parsing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ParseSpeed = 'quick' | 'precise';

const KEY = 'overload.parseSpeed';

/** What each tier is called and does, one short line each. Shared by the
 *  tier sheet and the food search's mode switch, so the two never describe
 *  the same mode in different words. */
export const PARSE_SPEED_COPY: Record<ParseSpeed, { title: string; sub: string }> = {
  quick: { title: 'Quick', sub: 'Fast estimate from your words.' },
  precise: { title: 'Precise', sub: 'Reads the label. Best for packaged food.' },
};

/** Wire value for a tier. The stored keys are the words the UI uses; the
 *  server's are the pipeline's own ('fast' / 'super'). Keeping the two
 *  vocabularies apart means renaming a tier in the sheet never silently
 *  changes which pipeline runs. */
export function parseSpeedWire(v: ParseSpeed): 'fast' | 'super' {
  return v === 'precise' ? 'super' : 'fast';
}

let _last: ParseSpeed | null = null;

/** The last tier read or picked in this app run, or null before any. */
export function peekParseSpeed(): ParseSpeed | null {
  return _last;
}

export async function getParseSpeed(): Promise<ParseSpeed> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    // A stored 'thorough' (the retired tier) falls through to Quick here.
    _last = v === 'precise' ? 'precise' : 'quick';
  } catch {
    // Fail open to the default tier, never block logging on storage.
    _last = _last ?? 'quick';
  }
  return _last;
}

export async function setParseSpeed(v: ParseSpeed): Promise<void> {
  _last = v;
  try {
    if (v === 'quick') await AsyncStorage.removeItem(KEY);
    else await AsyncStorage.setItem(KEY, v);
  } catch {
    // Losing the preference is survivable; surfacing an error here is not worth it.
  }
}

/** Which tier actually runs, given what the user picked and what they are
 *  entitled to. Precise without Pro falls back to Quick, the one tier left,
 *  so the log still goes through. */
export function effectiveParseSpeed(picked: ParseSpeed, canUsePrecise: boolean): ParseSpeed {
  return picked === 'precise' && !canUsePrecise ? 'quick' : picked;
}
