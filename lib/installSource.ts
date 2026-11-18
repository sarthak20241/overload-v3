/**
 * Sends the Android install source to PostHog once per install.
 *
 * Google Play's install referrer says which store link brought the person in
 * (lib/installReferrer.ts reads it). expo-application already carries the
 * Play Install Referrer library in the shipped build, so this needs no new
 * native code and goes out by OTA.
 *
 * The props go on the person with $set_once (setPersonProperties), so the first
 * answer wins and a later reinstall never overwrites it. Works before sign-up:
 * PostHog merges the anonymous person into the account on identify.
 *
 * iOS has no install referrer. Apple shows App Store campaign links (`ct=`)
 * only in App Store Connect, so on iOS the sign-up question
 * (`acquisition_source_answered`) is the signal.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { posthog } from '@/lib/analytics';
import {
  afterReferrerFailure,
  installSourceProps,
  parseInstallReferrer,
  referrerKeys,
  shouldReadReferrer,
} from '@/lib/installReferrer';

const SENT_KEY = 'overload.install_source_sent.v1';
const TIMEOUT_MS = 5000;

let started = false;

export async function captureInstallSourceOnce(): Promise<void> {
  if (started || !posthog || Platform.OS !== 'android') return;
  started = true;
  let stored: string | null = null;
  try {
    stored = await AsyncStorage.getItem(SENT_KEY);
    if (!shouldReadReferrer(stored)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const referrerCall = Application.getInstallReferrerAsync();
    // If the timeout wins, a late rejection must not surface as unhandled.
    referrerCall.catch(() => {});
    const raw = await Promise.race<string | null>([
      referrerCall,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    // Play did not answer in time: counts as a failed try, so a phone where
    // Play always hangs stops waiting after MAX_REFERRER_TRIES opens.
    if (raw == null) {
      await AsyncStorage.setItem(SENT_KEY, afterReferrerFailure(stored));
      return;
    }
    const props = installSourceProps(parseInstallReferrer(raw));
    // The SDK defers calls made while it is still loading its stored state,
    // and an error in deferred work never reaches this catch. Wait for it.
    await posthog.ready();
    posthog.capture('install_attributed', {
      ...props,
      // Names only, never values: a custom link could carry anything.
      install_referrer_keys: referrerKeys(raw),
    });
    // On the person, not only the event. First open is usually before
    // sign-up, and a raw $set_once from an anonymous visitor never reaches a
    // person in 'identified_only' mode. Called directly (not through the
    // error-swallowing setUserPropsOnce) so a throw lands in the catch below
    // and the read is retried.
    posthog.setPersonProperties(undefined, props, false);
    // Mark it done only after the queue went out. A failed send throws into
    // the catch below and the read is tried again on a later open ($set_once
    // keeps the first value, so a repeat is harmless).
    await posthog.flush();
    await AsyncStorage.setItem(SENT_KEY, '1');
  } catch {
    // Play's referrer service can be briefly unavailable, so a failure is
    // tried again on later opens, up to MAX_REFERRER_TRIES. Sideloaded
    // builds and emulators without Play end there. Never breaks the app.
    try {
      await AsyncStorage.setItem(SENT_KEY, afterReferrerFailure(stored));
    } catch {}
  }
}
