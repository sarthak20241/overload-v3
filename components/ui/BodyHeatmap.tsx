/**
 * Body Distribution — front + back silhouettes shaded by how much each muscle
 * was trained, replacing the old muscle-split donut.
 *
 * One hue (lime), four steps. The picture and the legend speak the same
 * language: a legend dot uses the exact fill its muscle got on the body, so
 * "darker/brighter = more work" is the only thing the reader has to learn.
 *
 * Set counts come straight from `workout_sets` grouped by `exercises.muscle_group`,
 * so this is "sets logged", not tonnage. Intensity is relative to the busiest
 * muscle in the same window, which keeps a light week readable instead of flat.
 */
import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Body, { type Slug, type ExtendedBodyPart } from 'react-native-body-highlighter';
import { Colors, Spacing, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';

/**
 * Our 11 `muscle_group` values mapped onto the library's anatomical slugs.
 * A group may cover several slugs (Back is three), and every slug in the list
 * gets that group's intensity so the whole region lights together.
 */
const GROUP_SLUGS: Record<string, Slug[]> = {
  Chest: ['chest'],
  Back: ['upper-back', 'lower-back', 'trapezius'],
  Shoulders: ['deltoids'],
  Quads: ['quadriceps'],
  Hamstrings: ['hamstring'],
  Biceps: ['biceps'],
  Triceps: ['triceps'],
  Calves: ['calves'],
  Core: ['abs', 'obliques'],
  Glutes: ['gluteal'],
};

const MAPPED_GROUPS = Object.keys(GROUP_SLUGS);

/**
 * Every slug the library draws, including the ones no exercise maps to.
 *
 * These all have to be listed explicitly: the library ships a hard-coded
 * `color` on each asset part (#3f3f3f for muscles, #bebebe for the head) and
 * that colour outranks `defaultFill`, so an untouched part would render dark
 * charcoal on our white card. Passing `styles.fill` — the only thing with
 * higher priority — is what actually puts the silhouette on our palette.
 */
const ALL_SLUGS: Slug[] = [
  'abs', 'adductors', 'ankles', 'biceps', 'calves', 'chest', 'deltoids',
  'feet', 'forearm', 'gluteal', 'hair', 'hamstring', 'hands', 'head',
  'knees', 'lower-back', 'neck', 'obliques', 'quadriceps', 'tibialis',
  'trapezius', 'triceps', 'upper-back',
];

/**
 * Sequential lime ramps, low → high, one per theme.
 *
 * Light runs pale → deep olive (pure #c8ff00 washes out on a white card).
 * Dark runs dim → full lime. Both are ordered by lightness, so the ramp still
 * reads as an ordered scale in greyscale and for colour-blind readers.
 */
const RAMP_LIGHT = ['#e8f0c0', '#cde383', '#a3c62b', '#6d9900'];
const RAMP_DARK = ['#3c4a1a', '#688210', '#9bc500', '#c8ff00'];

const STEPS = 4;

export interface BodyHeatmapEntry {
  name: string;
  sets: number;
  color: string;
}

/** Sets per muscle group → that group's colour on the ramp. */
function buildScale(counts: Record<string, number>, ramp: string[]): Record<string, string> {
  const mapped: Record<string, number> = {};
  for (const g of MAPPED_GROUPS) {
    if (counts[g]) mapped[g] = counts[g];
  }

  const max = Math.max(0, ...Object.values(mapped));
  const scale: Record<string, string> = {};
  if (max <= 0) return scale;

  for (const [group, value] of Object.entries(mapped)) {
    if (value <= 0) continue;
    const step = Math.min(STEPS, Math.max(1, Math.ceil((value / max) * STEPS)));
    scale[group] = ramp[step - 1];
  }
  return scale;
}

interface Props {
  /** Sets logged per `muscle_group`, e.g. `{ Chest: 42, Back: 30 }`. */
  counts: Record<string, number>;
  /** From `user_profiles.gender`. Only 'F' switches the silhouette. */
  gender?: string | null;
  /** Width available inside the card, used to size the two bodies. */
  width: number;
  /** How many muscles the legend lists, busiest first. */
  legendLimit?: number;
}

export function BodyHeatmap({ counts, gender, width, legendLimit = 6 }: Props) {
  const { C, mode } = useTheme();
  const ramp = mode === 'dark' ? RAMP_DARK : RAMP_LIGHT;
  const untrained = mode === 'dark' ? '#2c2c31' : '#e7e6df';
  const outline = mode === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)';

  const scale = useMemo(() => buildScale(counts, ramp), [counts, ramp]);

  /** Explicit fill for every slug — see ALL_SLUGS for why none can be omitted. */
  const data = useMemo<ExtendedBodyPart[]>(() => {
    const litFill: Partial<Record<Slug, string>> = {};
    for (const [group, color] of Object.entries(scale)) {
      for (const slug of GROUP_SLUGS[group] || []) litFill[slug] = color;
    }
    return ALL_SLUGS.map((slug) => ({
      slug,
      styles: { fill: litFill[slug] ?? untrained },
    }));
  }, [scale, untrained]);

  /** Busiest muscles first, coloured to match their fill on the body. */
  const legend = useMemo<BodyHeatmapEntry[]>(() => {
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, legendLimit)
      .map(([name, sets]) => ({
        name,
        sets,
        color: scale[name] ?? untrained,
      }));
  }, [counts, scale, ramp, untrained, legendLimit]);

  // Two bodies plus the gap have to fit the card. The library draws at
  // 200x400 per unit scale, and 0.62 keeps the pair from towering over the
  // rest of the card on a large phone.
  const bodyScale = Math.min(0.62, (width - Spacing.md) / 2 / 200);
  const libGender = gender === 'F' ? 'female' : 'male';

  return (
    <View style={styles.wrap}>
      <View style={styles.bodies}>
        {(['front', 'back'] as const).map((side) => (
          <View key={side} style={styles.bodyCol}>
            <Body
              data={data}
              side={side}
              gender={libGender}
              scale={bodyScale}
              border={outline}
              defaultFill={untrained}
            />
            <Text style={[styles.sideLabel, { color: C.textMuted }]}>
              {side === 'front' ? 'Front' : 'Back'}
            </Text>
          </View>
        ))}
      </View>

      <View style={[styles.scaleRow, { borderTopColor: C.borderSubtle }]}>
        <Text style={[styles.scaleCap, { color: C.textDim }]}>Less</Text>
        <View style={styles.swatches}>
          {ramp.map((c) => (
            <View key={c} style={[styles.swatch, { backgroundColor: c }]} />
          ))}
        </View>
        <Text style={[styles.scaleCap, { color: C.textDim }]}>More</Text>
      </View>

      <View style={styles.legend}>
        {legend.map((m) => (
          <View key={m.name} style={styles.legendRow}>
            <View style={[styles.dot, { backgroundColor: m.color }]} />
            <Text style={[styles.legendName, { color: C.foreground }]} numberOfLines={1}>
              {m.name}
            </Text>
            <Text style={[styles.legendVal, { color: C.textMuted }]}>{m.sets}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: Spacing.md },
  bodies: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.md },
  bodyCol: { alignItems: 'center', gap: Spacing.xs },
  sideLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
    letterSpacing: 0.4,
  },
  scaleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
  },
  scaleCap: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  swatches: { flexDirection: 'row', gap: 3 },
  swatch: { width: 20, height: 8, borderRadius: 2 },
  legend: { marginTop: Spacing.md, gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  legendName: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  legendVal: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
