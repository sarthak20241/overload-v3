import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const GUEST_MODE_KEY = 'guest_mode_v1';

// Tracks "the user tapped Continue as guest." Persists across restarts so a
// guest doesn't get bounced to the auth screen on every cold start.
// Cleared on sign-in / sign-out so subsequent starts decide cleanly.

export async function getGuestMode(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(GUEST_MODE_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setGuestMode(active: boolean): Promise<void> {
  try {
    if (active) await AsyncStorage.setItem(GUEST_MODE_KEY, '1');
    else await AsyncStorage.removeItem(GUEST_MODE_KEY);
  } catch {
    // ignore
  }
}

export function useGuestMode(): { isGuest: boolean; isLoaded: boolean } {
  const [state, setState] = useState({ isGuest: false, isLoaded: false });
  useEffect(() => {
    let cancelled = false;
    getGuestMode().then((isGuest) => {
      if (!cancelled) setState({ isGuest, isLoaded: true });
    });
    return () => { cancelled = true; };
  }, []);
  return state;
}
