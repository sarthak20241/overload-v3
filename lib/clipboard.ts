/**
 * Copy text to the system clipboard, whatever binary the JS is running in.
 *
 * expo-clipboard is a native module, so a dev client or store build made
 * before it was added has no such module and requiring it throws. Same
 * discipline as lib/haptics.ts: load lazily, cache the failure, never crash.
 * Older binaries fall back to React Native's own Clipboard, which RN 0.81
 * still ships (deprecated, removal announced), so an OTA update of this code
 * copies on every binary we have out. Returns false only when neither works.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

type ExpoClipboard = typeof import('expo-clipboard');
let expoMod: ExpoClipboard | null | undefined;

function getExpoClipboard(): ExpoClipboard | null {
  if (expoMod === undefined) {
    // Ask for the native side FIRST (same idiom as lib/restCue.ts): evaluating
    // the JS package on a binary without the module throws, and Metro's dev
    // runtime red-boxes that even inside try/catch.
    if (!requireOptionalNativeModule('ExpoClipboard')) {
      expoMod = null;
      return null;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      expoMod = require('expo-clipboard') as ExpoClipboard;
    } catch {
      expoMod = null;
    }
  }
  return expoMod;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  const expo = getExpoClipboard();
  if (expo) {
    try {
      await expo.setStringAsync(text);
      return true;
    } catch {
      // fall through to the core module
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rn = require('react-native') as { Clipboard?: { setString: (s: string) => void } };
    if (rn.Clipboard?.setString) {
      rn.Clipboard.setString(text);
      return true;
    }
  } catch {
    // no clipboard at all (web without permission, or a stripped runtime)
  }
  return false;
}
