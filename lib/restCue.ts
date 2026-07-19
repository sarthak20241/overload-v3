import { requireOptionalNativeModule } from 'expo-modules-core';
import { haptics } from './haptics';

// Rest-ending heads-up: ~3s before the rest timer hits zero, a soft chime is
// played through a `duckOthers` audio session, so the OS dips whatever the
// user's music app is playing, with a buzz layered on top. Deactivating the
// session (endRestEndCue) is what restores the music to full volume, timed to
// land with the rest-done success buzz.
//
// expo-audio is a native module, so it's loaded lazily and every call is
// fail-soft: on a dev client built before the module was added (or any audio
// error) the cue degrades to the haptic alone instead of crashing.

type ExpoAudio = typeof import('expo-audio');

let audio: ExpoAudio | null | undefined; // undefined = not yet attempted
let player: import('expo-audio').AudioPlayer | null = null;

// Two flags, deliberately independent, because the audio session is taken on a
// promise chain that can outlive the cue window:
//   wantCue      — INTENT: the cue should be running (set by start, cleared by end).
//   sessionOwned — FACT: we activated a session and still owe a deactivate.
// Collapsing these into one flag is what made the duck stick: end would clear it,
// then the still-in-flight activate would re-duck, and every later end call would
// early-return — leaving the user's music quiet for the rest of the session.
let wantCue = false;
let sessionOwned = false;

function loadAudio(): ExpoAudio | null {
  if (audio !== undefined) return audio;
  // Ask the native side through the supported API (it returns null rather than
  // throwing) BEFORE requiring the JS package. On a dev client built without
  // expo-audio, evaluating the package throws — and although the try/catch below
  // handles that, Metro's dev runtime redboxes any module-eval failure anyway
  // (verified on-sim), so the require must not run where it can't succeed.
  if (!requireOptionalNativeModule('ExpoAudio')) {
    audio = null;
    return audio;
  }
  try {
    audio = require('expo-audio') as ExpoAudio;
  } catch {
    audio = null;
  }
  return audio;
}

// Hand the session back so the user's music returns to full volume. Cheap and
// idempotent: a no-op unless we currently hold a session.
function releaseSession(a: ExpoAudio | null) {
  if (!sessionOwned) return;
  sessionOwned = false;
  try {
    void a?.setIsAudioActiveAsync(false).catch(() => {});
  } catch {
    // Nothing to restore if audio never started.
  }
}

export function startRestEndCue() {
  haptics.warning();
  const a = loadAudio();
  if (!a) return;
  wantCue = true;
  try {
    if (!player) {
      player = a.createAudioPlayer(require('@/assets/sounds/rest-cue.wav'));
    }
    const p = player;
    // Sequence session-setup BEFORE playback: set the duck mode, activate the
    // session, THEN play. Firing these as parallel fire-and-forget promises let
    // the chime start before the duckOthers session was live, so the first duck
    // often didn't apply. playsInSilentMode: an opted-in cue, like an interval
    // timer — it should sound even with the ring switch off.
    a.setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      interruptionModeAndroid: 'duckOthers',
      shouldPlayInBackground: false,
    })
      .then(() => {
        sessionOwned = true;
        return a.setIsAudioActiveAsync(true);
      })
      .then(() => {
        // The window can close while the session is still settling — a fast
        // "Skip", the next set logged, or the app backgrounding. Whoever lands
        // last has to leave the music un-ducked. Deactivate unconditionally
        // rather than via releaseSession(): our activate may have resolved
        // AFTER an endRestEndCue already released, so the flag can't be
        // trusted here (a redundant deactivate is harmless).
        if (!wantCue) {
          sessionOwned = false;
          void a.setIsAudioActiveAsync(false).catch(() => {});
          return;
        }
        p.seekTo(0);
        p.play();
      })
      .catch(() => {
        // Session setup failed — still fire the chime so the cue isn't silent.
        if (wantCue) { p.seekTo(0); p.play(); }
        else releaseSession(a);
      });
  } catch {
    // Haptic already fired; the duck is a bonus, not a requirement.
  }
}

export function endRestEndCue() {
  // Checks BOTH flags: a session taken by a chain that outlived the intent must
  // still be released, which is exactly the case the old `!active` guard missed.
  if (!wantCue && !sessionOwned) return;
  wantCue = false;
  try {
    player?.pause();
  } catch {
    // Player may not exist yet; the session release below is what matters.
  }
  releaseSession(loadAudio());
}
