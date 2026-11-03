/**
 * The app's one big "you did it" moment: full-screen colourful confetti.
 * Used for the onboarding commit and for finishing the first-week path.
 *
 * Rendered through the root Portal so it covers the whole screen (header,
 * tab bar and safe areas too), not just the box of whoever mounts it. Two
 * cannons spray up from the bottom corners in a wide fan; low gravity and a
 * staggered spray keep it floating down slowly. No second rain from the top:
 * the owner asked for one burst, not confetti over the next screen.
 *
 * Unmount it in onDone, which fires when the last piece has landed. Move on
 * to the next screen from there too, so no confetti falls over it. A
 * backstop timer calls onDone anyway if the library never reports its end,
 * and onDone fires at most once.
 */
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { CannonConfetti } from 'react-native-fast-confetti';
import { Portal } from '@/components/ui/Portal';

// A party, not a brand moment: many bright hues, with the lime in the mix.
const COLORS = [
  '#c8ff00', // lime
  '#ff4d6d', // pink-red
  '#ffb703', // amber
  '#3a86ff', // blue
  '#8338ec', // violet
  '#00d1b2', // teal
  '#ff7a00', // orange
  '#ffffff',
];

const BACKSTOP_MS = 6000;

export function Celebration({ onDone }: { onDone: () => void }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const fired = useRef(false);
  const finish = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    doneRef.current();
  }, []);
  useEffect(() => {
    const t = setTimeout(finish, BACKSTOP_MS);
    return () => clearTimeout(t);
  }, [finish]);

  return (
    <Portal>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <CannonConfetti
          autoplay
          gravity={1.1}
          drag={3}
          sprayDuration={700}
          fadeOutOnEnd
          colors={COLORS}
          onAnimationEnd={finish}
        >
          <CannonConfetti.Origin position="bottom-left" target="top-center" spread={1.2} count={130} initialSpeed={2.8}>
            <CannonConfetti.Flake size={10} />
            <CannonConfetti.Flake size={8} radius={4} />
          </CannonConfetti.Origin>
          <CannonConfetti.Origin position="bottom-right" target="top-center" spread={1.2} count={130} initialSpeed={2.8}>
            <CannonConfetti.Flake size={10} />
            <CannonConfetti.Flake size={8} radius={4} />
          </CannonConfetti.Origin>
        </CannonConfetti>
      </View>
    </Portal>
  );
}
