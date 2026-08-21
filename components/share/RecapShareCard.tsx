import { forwardRef, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Body from 'react-native-body-highlighter';
import { ShareCanvas } from './ShareCanvas';
import { RAMP_DARK, buildBodyData } from '@/components/ui/BodyHeatmap';
import { recapCoachLine, formatDate } from '@/lib/share/shareCopy';

const UNTRAINED = '#2c2c31';
const OUTLINE = 'rgba(255,255,255,0.16)';
const FG = '#ffffff';
const MUTED = '#8a8a93';
const FONT_BOLD = 'SpaceGrotesk_700Bold';
const FONT_MEDIUM = 'SpaceGrotesk_500Medium';

interface Props {
  name: string;
  startedAt: Date | string;
  durationSeconds: number;
  totalVolumeKg: number;
  setCount: number;
  exerciseCount: number;
  counts: Record<string, number>;
  gender?: string | null;
  prCount?: number;
}

export const RecapShareCard = forwardRef<View, Props>(function RecapShareCard(
  { name, startedAt, durationSeconds, totalVolumeKg, setCount, exerciseCount, counts, gender, prCount = 0 },
  ref,
) {
  const data = useMemo(() => buildBodyData(counts, RAMP_DARK, UNTRAINED), [counts]);
  const hasMuscle = Object.values(counts).some((v) => v > 0);
  const libGender = gender === 'F' ? 'female' : 'male';

  const statRow = useMemo(() => {
    const vol = totalVolumeKg >= 1000
      ? `${(totalVolumeKg / 1000).toFixed(1)}t`
      : `${Math.round(totalVolumeKg)}kg`;

    const stats: { label: string; value: string; dotColor?: string }[] = [
      { label: 'Volume', value: vol },
    ];

    if (prCount > 0) {
      stats.push({ label: 'PRs', value: String(prCount), dotColor: '#c8ff00' });
    } else {
      stats.push({ label: 'Sets', value: String(setCount) });
    }

    stats.push({ label: 'Time', value: `${Math.floor(durationSeconds / 60)}m` });
    return stats;
  }, [totalVolumeKg, setCount, durationSeconds, prCount]);

  const d = typeof startedAt === 'string' ? new Date(startedAt) : startedAt;
  const subline = `${exerciseCount} exercise${exerciseCount !== 1 ? 's' : ''} · ${formatDate(d)}`;

  return (
    <ShareCanvas
      ref={ref}
      eyebrow="WORKOUT RECAP"
      headline={name || 'Workout done.'}
      subline={subline}
      footer={formatDate(d)}
      statRow={statRow}
      coachLine={recapCoachLine(prCount, durationSeconds)}
    >
      {hasMuscle ? (
        // Both sides, like the Body Distribution card. Front-only used to hide
        // the whole session for anything pull- or leg-biased: a back day lit
        // nothing but the tips of the traps.
        <View style={styles.bodies}>
          {(['front', 'back'] as const).map((side) => (
            <View key={side} style={styles.bodyCol}>
              <Body
                data={data}
                side={side}
                gender={libGender}
                scale={1.7}
                border={OUTLINE}
                defaultFill={UNTRAINED}
              />
              <Text style={styles.sideLabel}>
                {side === 'front' ? 'Front' : 'Back'}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.bigStat}>
          <Text style={styles.bigNumber}>{Math.round(totalVolumeKg)}</Text>
          <Text style={styles.bigUnit}>kg</Text>
        </View>
      )}
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
  bigStat: {
    alignItems: 'center',
  },
  bigNumber: {
    fontFamily: FONT_BOLD,
    fontSize: 200,
    color: FG,
    lineHeight: 220,
  },
  bigUnit: {
    fontFamily: FONT_BOLD,
    fontSize: 60,
    color: '#8a8a93',
    marginTop: -20,
  },
});
