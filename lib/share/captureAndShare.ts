import { RefObject } from 'react';
import { View, InteractionManager } from 'react-native';

let viewShot: typeof import('react-native-view-shot') | null = null;
let sharing: typeof import('expo-sharing') | null = null;

try {
  viewShot = require('react-native-view-shot');
} catch {}
try {
  sharing = require('expo-sharing');
} catch {}

export const isShareAvailable = () => !!viewShot && !!sharing;

export async function captureAndShare(ref: RefObject<View | null>): Promise<boolean> {
  if (!viewShot || !sharing) return false;
  if (!ref.current) return false;

  const available = await sharing.isAvailableAsync();
  if (!available) return false;

  await new Promise<void>((r) => InteractionManager.runAfterInteractions(() => r()));

  const uri = await viewShot.captureRef(ref, {
    format: 'png',
    width: 1080,
    height: 1920,
    quality: 1,
  });

  await sharing.shareAsync(uri, {
    mimeType: 'image/png',
    dialogTitle: 'Share',
  });

  return true;
}
