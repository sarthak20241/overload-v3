import { forwardRef, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Body from 'react-native-body-highlighter';
import { ShareCanvas } from './ShareCanvas';
import {
  RAMP_DARK,
  buildBodyData,
  buildScale,
} from '@/components/ui/BodyHeatmap';
import { bodyHeadline } from '@/lib/share/shareCopy';

const UNTRAINED = '#2c2c31';
const OUTLINE = 'rgba(255,255,255,0.16)';
const MUTED = '#8a8a93';
const FG = '#ffffff';
const FONT_BOLD = 'SpaceGrotesk_700Bold';
const FONT_MEDIUM = 'SpaceGrotesk_500Medium';

interface Props {
  counts: Record<string, number>;
  gender?: string | null;
  windowLabel: string;
}

export const BodyShareCard = forwardRef<View, Props>(function BodyShareCard(
  { counts, gender, windowLabel },
  ref,
) {
  const data = useMemo(() => buildBodyData(counts, RAMP_DARK, UNTRAINED), [counts]);
  const scale = useMemo(() => buildScale(counts, RAMP_DARK), [counts]);

  const topMuscles = useMemo(() => {
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, sets]) => ({
        name,
        sets,
        color: scale[name] ?? UNTRAINED,
      }));
  }, [counts, scale]);

  const libGender = gender === 'F' ? 'female' : 'male';

  return (
    <ShareCanvas
      ref={ref}
      eyebrow="BODY DISTRIBUTION"
      headline={bodyHeadline(counts)}
      footer={windowLabel}
      statRow={topMuscles.map((m) => ({
        label: m.name,
        value: String(m.sets),
        dotColor: m.color,
      }))}
    >
      <View style={styles.bodies}>
        {(['front', 'back'] as const).map((side) => (
          <View key={side} style={styles.bodyCol}>
            <Body
              data={data}
              side={side}
              gender={libGender}
              scale={2.1}
              border={OUTLINE}
              defaultFill={UNTRAINED}
            />
            <Text style={styles.sideLabel}>
              {side === 'front' ? 'Front' : 'Back'}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.rampRow}>
        <Text style={styles.rampCap}>Less</Text>
        <View style={styles.swatches}>
          {RAMP_DARK.map((c) => (
            <View key={c} style={[styles.swatch, { backgroundColor: c }]} />
          ))}
        </View>
        <Text style={styles.rampCap}>More</Text>
      </View>
    </ShareCanvas>
  );
});

const styles = StyleSheet.create({
  bodies: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: 60,
  },
  bodyCol: {
    alignItems: 'center',
    gap: 12,
  },
  sideLabel: {
    fontFamily: FONT_MEDIUM,
    fontSize: 28,
    color: MUTED,
    letterSpacing: 1,
  },
  rampRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginTop: 32,
  },
  rampCap: {
    fontFamily: FONT_MEDIUM,
    fontSize: 26,
    color: MUTED,
  },
  swatches: {
    flexDirection: 'row',
    gap: 6,
  },
  swatch: {
    width: 44,
    height: 16,
    borderRadius: 4,
  },
});
