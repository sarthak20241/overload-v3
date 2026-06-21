import { useEffect, useRef, useState } from 'react';
import { Text, TextProps } from 'react-native';

interface Props extends TextProps {
  value: number;
  // Format the (fractional, mid-tween) number for display. Defaults to a
  // rounded integer.
  format?: (n: number) => string;
  durationMs?: number;
}

// Counts a stat value up to its target on mount (and re-tweens when the value
// changes), extending the dashboard's roll-up feel to stat numbers. Pure JS
// RAF tween in a self-contained component, so a parent re-render (e.g. the
// workout timer ticking) never restarts the animation.
export function AnimatedNumber({ value, format = (n) => String(Math.round(n)), durationMs = 700, ...rest }: Props) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs]);

  return <Text {...rest}>{format(display)}</Text>;
}
