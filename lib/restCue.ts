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
let active = false;

function loadAudio(): ExpoAudio | null {
  if (audio !== undefined) return audio;
  // Probe the native registry BEFORE requiring. On a dev client built without
  // expo-audio, evaluating the package throws — and although the try/catch
  // handles it, Metro's dev runtime redboxes any module-eval failure anyway
  // (verified on-sim 2026-07-17). Checking the registry first means the
  // require never runs where it can't succeed.
  const hasNative = !!(globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules?.ExpoAudio;
  if (!hasNative) {
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

export function startRestEndCue() {
  haptics.warning();
  const a = loadAudio();
  if (!a) return;
  try {
    if (!player) {
      // playsInSilentMode: an interval-timer-style cue the user opted into —
      // it should sound even with the ring switch off, like music does.
      void a.setAudioModeAsync({
        playsInSilentMode: true,
        interruptionMode: 'duckOthers',
        interruptionModeAndroid: 'duckOthers',
        shouldPlayInBackground: false,
      }).catch(() => {});
      player = a.createAudioPlayer(require('@/assets/sounds/rest-cue.wav'));
    }
    active = true;
    void a.setIsAudioActiveAsync(true).catch(() => {});
    player.seekTo(0);
    player.play();
  } catch {
    // Haptic already fired; the duck is a bonus, not a requirement.
  }
}

export function endRestEndCue() {
  if (!active) return;
  active = false;
  const a = loadAudio();
  try {
    player?.pause();
    void a?.setIsAudioActiveAsync(false).catch(() => {});
  } catch {
    // Nothing to restore if audio never started.
  }
}
