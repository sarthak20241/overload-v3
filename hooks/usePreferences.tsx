import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MusicApp } from '@/lib/musicLinks';

// Workout preferences live here. This mirrors useTheme's shape (Provider +
// context + AsyncStorage) but holds the whole preferences object under a single
// key, serialized as JSON. New keys can be added freely: on read we merge the
// stored blob over DEFAULT_PREFERENCES, so older installs (missing the new key)
// transparently pick up the default. That forward-safety is why the Phase A/B
// keys (intensity, inline timer) already live here even though their UI rows
// land with those phases — the store never needs a migration.

export type IntensityScale = 'rpe' | 'rir';

export interface WorkoutPreferences {
  // ── Logging ──────────────────────────────────────────────────────────────
  // Reveals the intensity (RPE/RIR) column on the set table. Surfaced in Phase B.
  intensityTrackingEnabled: boolean;
  // How that column is labelled & entered. RIR is shown as (10 - rpe).
  intensityScale: IntensityScale;

  // ── During workout ───────────────────────────────────────────────────────
  // Built-in stopwatch fills duration for time-based exercises. Surfaced in Phase A.
  inlineTimerForDuration: boolean;
  // Screen stays on while the active workout screen is mounted. Live in Phase 0.
  keepAwake: boolean;
  // Short rest between the LEFT and RIGHT side of a unilateral (L+R) set. Off =
  // log both sides back to back. Migration 0056 / unilateral feature.
  restBetweenSides: boolean;
  // Soft chime + buzz ~3s before rest ends; the chime plays through a
  // duckOthers audio session, so the user's music dips and comes back.
  restEndCue: boolean;

  // ── Music ────────────────────────────────────────────────────────────────
  // 'off' hides the top-bar music shortcut; anything else picks which app the
  // one-tap jump opens (see lib/musicLinks). We never play or read music.
  musicApp: MusicApp;
}

export const DEFAULT_PREFERENCES: WorkoutPreferences = {
  intensityTrackingEnabled: false,
  intensityScale: 'rir',
  inlineTimerForDuration: true,
  keepAwake: false,
  restBetweenSides: false,
  restEndCue: true,
  musicApp: 'off',
};

// Fixed inter-side rest target (seconds) when restBetweenSides is on. Kept a
// constant (not a pref) to keep the settings sheet lean in v1.
export const REST_BETWEEN_SIDES_SECONDS = 20;

const PREFS_KEY = 'overload_workout_prefs';

interface PreferencesContextType {
  prefs: WorkoutPreferences;
  // False until the stored blob has been read; lets callers avoid persisting a
  // default over a not-yet-hydrated value on first paint.
  ready: boolean;
  setPreference: <K extends keyof WorkoutPreferences>(key: K, value: WorkoutPreferences[K]) => void;
}

const PreferencesContext = createContext<PreferencesContextType>({
  prefs: DEFAULT_PREFERENCES,
  ready: false,
  setPreference: () => {},
});

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<WorkoutPreferences>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);
  // If the user toggles a preference before the initial AsyncStorage read
  // resolves, don't let the on-disk blob clobber that change.
  const touchedBeforeReadyRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY)
      .then((stored) => {
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as Partial<WorkoutPreferences>;
            // Merge over defaults so newly-added keys are forward-safe — but keep
            // any local edit the user made before hydration completed.
            setPrefs((prev) => (touchedBeforeReadyRef.current ? prev : { ...DEFAULT_PREFERENCES, ...parsed }));
          } catch {
            /* corrupt blob — keep defaults */
          }
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const setPreference = useCallback(
    <K extends keyof WorkoutPreferences,>(key: K, value: WorkoutPreferences[K]) => {
      // Mark the store user-touched so a late hydration read won't overwrite it.
      touchedBeforeReadyRef.current = true;
      setPrefs((prev) => {
        const next = { ...prev, [key]: value };
        AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});
        return next;
      });
    },
    [],
  );

  const value = useMemo(() => ({ prefs, ready, setPreference }), [prefs, ready, setPreference]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  return useContext(PreferencesContext);
}
