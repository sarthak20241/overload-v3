/**
 * "Connect your AI later": the dashboard card a buyer sees after tapping
 * "Do it later" on the paywall's success screen.
 *
 * One value per account on the device:
 *   'later'      tapped Do it later: the card shows
 *   'done'       opened ChatGPT or Claude from the connector screen: hidden
 *   'dismissed'  closed the card with its X: hidden for good
 * No value: the card never shows (most accounts never see it).
 *
 * Opening ChatGPT or Claude from the setup screen is the best sign this app
 * has that they connected; the connector itself lives on the server.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ConnectNudge } from '@/lib/aiConnect';

export type { ConnectNudge };

const key = (userId: string) => `connect_nudge_v1::${userId}`;

export async function readConnectNudge(userId: string): Promise<ConnectNudge | null> {
  try {
    const v = await AsyncStorage.getItem(key(userId));
    return v === 'later' || v === 'done' || v === 'dismissed' ? v : null;
  } catch {
    return null;
  }
}

/** 'later' never overwrites 'done' or 'dismissed': a second purchase screen
 *  must not bring back a card the user already finished with. 'done' only
 *  closes a waiting reminder: opening ChatGPT from Profile before any "Do it
 *  later" leaves nothing stored, so a later "Do it later" still shows it. */
export async function setConnectNudge(userId: string, next: ConnectNudge): Promise<void> {
  try {
    const now = await readConnectNudge(userId);
    if (next === 'later' && (now === 'done' || now === 'dismissed')) return;
    if (next === 'done' && now !== 'later') return;
    await AsyncStorage.setItem(key(userId), next);
  } catch {
    /* best effort: the card is a reminder, not state that must survive */
  }
}
