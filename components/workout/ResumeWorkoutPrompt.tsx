import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { useWorkout } from '@/hooks/useWorkout';
import { useClerkUser } from '@/hooks/useClerkUser';
import { Colors } from '@/constants/theme';
import {
  getActiveWorkoutSnapshot,
  clearActiveWorkout,
  type ActiveWorkoutSnapshot,
} from '@/lib/activeWorkoutPersistence';

/**
 * Offers to resume a workout that was interrupted by a crash, OS-kill, or
 * swipe-away. The snapshot is hydrated at boot (app/_layout.tsx); this reads it
 * once on entering the app and prompts when there's no live session. A snapshot
 * left behind by a different (now signed-out) account is dropped rather than
 * offered, so one user never resumes another's session.
 *
 * Mounted once in app/(app)/_layout.tsx, which only renders after Clerk has
 * loaded, so the owner comparison below sees a stable user id.
 */
export function ResumeWorkoutPrompt() {
  const router = useRouter();
  const workout = useWorkout();
  const { user } = useClerkUser();
  const [snap, setSnap] = useState<ActiveWorkoutSnapshot | null>(null);
  const evaluated = useRef(false);

  useEffect(() => {
    if (evaluated.current) return;
    evaluated.current = true;
    const saved = getActiveWorkoutSnapshot();
    if (!saved || workout.isActive) return;
    if (saved.ownerId !== (user?.id ?? null)) {
      // Belongs to a different account — don't leak it into this session.
      clearActiveWorkout();
      return;
    }
    setSnap(saved);
  }, []);

  if (!snap) return null;

  const exerciseCount = snap.exercises.length;
  const setCount = snap.exercises.reduce(
    (n, ex) => n + ex.sets.filter((s) => s.completed).length,
    0,
  );
  const label =
    snap.routineName && snap.routineName !== 'New Workout'
      ? snap.routineName
      : 'your workout';

  const resume = () => {
    workout.hydrateFromSnapshot(snap);
    setSnap(null);
    router.push(`/workout/${snap.workoutScreenId}` as any);
  };

  const discard = () => {
    clearActiveWorkout();
    setSnap(null);
  };

  return (
    <ThemedAlert
      visible={!!snap}
      icon="rotate-ccw"
      iconColor={Colors.primary}
      title="Resume your workout?"
      message={`Looks like ${label} is still going. Everything you logged is saved.`}
      stats={[
        { label: 'Sets logged', value: String(setCount) },
        { label: 'Exercises', value: String(exerciseCount) },
      ]}
      buttons={[
        { text: 'Discard', style: 'destructive', onPress: discard },
        { text: 'Resume', style: 'primary', onPress: resume },
      ]}
      onClose={() => setSnap(null)}
    />
  );
}
