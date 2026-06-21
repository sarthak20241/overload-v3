import { Platform } from 'react-native';

// Centralized haptics for the Pillar D "haptics map". Every call is fire-and-
// forget and swallows errors so an unsupported platform (web, a sim with no
// Taptic Engine, or a dev client built before expo-haptics was added) never
// crashes the UI. Use these named helpers at the meaningful moments rather than
// calling expo-haptics directly.
//
//   tap       — a set is logged / a primary button is pressed (light impact)
//   tick      — one notch of a stepper / picker (selection)
//   selection — a tab or toggle changes (selection)
//   success   — a new PR, a rest timer finishing, a save completing
//   warning   — a destructive confirm (discard / delete)
//   error     — an action failed

const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

// Lazy + defensive: a custom dev client built before expo-haptics was installed
// has no native module, and requiring it would throw at module-eval time. We
// load it on first use and cache null on failure, so the app boots either way.
type HapticsModule = typeof import('expo-haptics');
let mod: HapticsModule | null | undefined;
const getMod = (): HapticsModule | null => {
  if (mod === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('expo-haptics') as HapticsModule;
    } catch {
      mod = null;
    }
  }
  return mod;
};

const run = (fn: (h: HapticsModule) => Promise<unknown>): void => {
  if (!enabled) return;
  const h = getMod();
  if (!h) return;
  try {
    // Don't await — haptics should never block or surface a rejection.
    fn(h).catch(() => {});
  } catch {
    // ignore (older runtimes can throw synchronously)
  }
};

export const haptics = {
  tap: () => run((h) => h.impactAsync(h.ImpactFeedbackStyle.Light)),
  medium: () => run((h) => h.impactAsync(h.ImpactFeedbackStyle.Medium)),
  tick: () => run((h) => h.selectionAsync()),
  selection: () => run((h) => h.selectionAsync()),
  success: () => run((h) => h.notificationAsync(h.NotificationFeedbackType.Success)),
  warning: () => run((h) => h.notificationAsync(h.NotificationFeedbackType.Warning)),
  error: () => run((h) => h.notificationAsync(h.NotificationFeedbackType.Error)),
};

export type HapticKind = keyof typeof haptics;
