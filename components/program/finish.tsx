/**
 * The finish kit for the Goal & Plan screens (.planning/phase-metrics/SPEC.md,
 * section 9): one type scale, one spacing scale, the list row, the skeleton
 * blocks shown while a screen loads, and a stagger that respects reduce
 * motion. Every Goal, phase and pillar screen draws from here, so sizes are
 * never one-offs. No native dependency: Reanimated and react-native-svg only.
 */
import type { ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { Colors, FontWeight } from '@/constants/theme';

/** The spacing scale: 4 / 8 / 12 / 16 / 24 / 32. */
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** The type scale. Negative letter-spacing on the large text only. */
export const T = StyleSheet.create({
  title: { fontSize: 28, lineHeight: 32, fontWeight: FontWeight.bold, letterSpacing: -0.5 },
  hero: { fontSize: 56, lineHeight: 58, fontWeight: FontWeight.bold, letterSpacing: -2, fontVariant: ['tabular-nums'] },
  heroSmall: { fontSize: 44, lineHeight: 46, fontWeight: FontWeight.bold, letterSpacing: -1.4, fontVariant: ['tabular-nums'] },
  unit: { fontSize: 18, lineHeight: 22, fontWeight: FontWeight.medium },
  section: { fontSize: 12, lineHeight: 16, fontWeight: FontWeight.semibold, letterSpacing: 1, textTransform: 'uppercase' },
  rowTitle: { fontSize: 18, lineHeight: 23, fontWeight: FontWeight.medium },
  /** A list row's second line: muted, regular. */
  rowSub: { fontSize: 15, lineHeight: 20, fontWeight: FontWeight.regular },
  rowValue: { fontSize: 15, lineHeight: 20, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
  status: { fontSize: 13, lineHeight: 16, fontWeight: FontWeight.semibold },
  meta: { fontSize: 14, lineHeight: 18, fontWeight: FontWeight.medium },
  body: { fontSize: 15, lineHeight: 21, fontWeight: FontWeight.regular },
  cardTitle: { fontSize: 22, lineHeight: 27, fontWeight: FontWeight.semibold, letterSpacing: -0.3 },
  /** A section heading on a page ("Your plan"). */
  heading: { fontSize: 22, lineHeight: 27, fontWeight: FontWeight.bold, letterSpacing: -0.3 },
  big: { fontSize: 26, lineHeight: 30, fontWeight: FontWeight.semibold, letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  dayLetter: { fontSize: 11, lineHeight: 14, fontWeight: FontWeight.semibold },
  dayName: { fontSize: 11, lineHeight: 14, fontWeight: FontWeight.semibold },
});

/** A status word's colour on the active theme. */
export function useStatusColor() {
  const { C } = useTheme();
  return (tone: 'ok' | 'warn' | 'dim') => (tone === 'ok' ? C.accentText : tone === 'warn' ? C.warningText : C.textDim);
}

/** The stagger for a screen's first render: a short FadeInDown per block, none under reduce motion. */
export function useStagger(stepMs = 30) {
  const reduce = useReducedMotion();
  return (index: number) => (reduce ? undefined : FadeInDown.duration(220).delay(index * stepMs));
}

/** A block that fades in on first render, keyed so a re-render does not replay it. */
export function Stagger({ index, step, children, style }: { index: number; step?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const entering = useStagger(step);
  return <Animated.View entering={entering(index)} style={style}>{children}</Animated.View>;
}

/** A section label, uppercase, muted. */
export function SectionLabel({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const { C } = useTheme();
  return <Text style={[T.section, { color: C.mutedFg }, style]}>{children}</Text>;
}

interface RowProps {
  title: string;
  /** The value, drawn in the foreground; `valueRest` follows it muted. */
  value?: string;
  valueRest?: string;
  /** A status word, coloured by tone. */
  status?: { label: string; tone: 'ok' | 'warn' | 'dim' } | null;
  /** The row navigates: a chevron, a pressed state and a haptic. */
  onPress?: () => void;
  icon?: keyof typeof Feather.glyphMap;
  /** A drawn icon instead of a Feather glyph (the plan rows' thin line icons, components/program/LineIcons). */
  iconNode?: ReactNode;
  subtitle?: ReactNode;
  /** Taller rows for a short list that is the page's main content (the plan rows: 64). */
  minHeight?: number;
  first?: boolean;
  last?: boolean;
  accessibilityLabel?: string;
}

/**
 * A list row: 52pt minimum, hairline dividers, a full-row press target with
 * a subtle pressed state, a chevron only when it navigates.
 */
export function Row({ title, value, valueRest, status, onPress, icon, iconNode, subtitle, minHeight, first, last, accessibilityLabel }: RowProps) {
  const { C } = useTheme();
  const statusColor = useStatusColor();
  const body = (
    <>
      {iconNode
        ? <View style={styles.rowIconWide}>{iconNode}</View>
        : icon && <Feather name={icon} size={22} color={C.foreground} style={styles.rowIcon} />}
      <View style={{ flex: 1 }}>
        <Text style={[T.rowTitle, { color: C.foreground }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[T.rowSub, { color: C.mutedFg, marginTop: 2 }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {(value || valueRest) && (
        <Text style={[T.rowValue, { color: C.mutedFg, marginRight: status ? S.lg : 0 }]} numberOfLines={1}>
          {value ? <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{value}</Text> : null}
          {valueRest ? `${value ? ' ' : ''}${valueRest}` : ''}
        </Text>
      )}
      {status && <Text style={[T.status, styles.rowStatus, { color: statusColor(status.tone) }]} numberOfLines={1}>{status.label}</Text>}
      {onPress && <Feather name="chevron-right" size={18} color={C.textMuted} style={{ marginLeft: S.sm }} />}
    </>
  );
  const border = [first && { borderTopWidth: StyleSheet.hairlineWidth }, !last && { borderBottomWidth: StyleSheet.hairlineWidth }, { borderColor: C.borderSubtle }];
  const tall = minHeight ? { minHeight, paddingVertical: 4 } : null;
  if (!onPress) return <View style={[styles.row, tall, border]}>{body}</View>;
  return (
    <Pressable
      onPress={() => { haptics.selection(); onPress(); }}
      style={({ pressed }) => [styles.row, tall, border, pressed && { backgroundColor: C.surfaceHover }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
    >
      {body}
    </Pressable>
  );
}

/** A load that failed with nothing to show yet: one calm line and a retry, not the "no program" empty state. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { C } = useTheme();
  return (
    <View style={{ paddingTop: S.xl, gap: S.md }}>
      <Text style={[T.body, { color: C.mutedFg }]}>I could not load your program just now. Check the connection and try again.</Text>
      <Pressable
        onPress={() => { haptics.selection(); onRetry(); }}
        style={({ pressed }) => [styles.retry, { backgroundColor: C.muted, opacity: pressed ? 0.85 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel="Try again"
      >
        <Text style={[T.rowTitle, { color: C.foreground, fontWeight: FontWeight.semibold }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

/** The coach's tip at the bottom of a screen: a quote with a 3px lime bar. */
export function CoachTip({ text }: { text: string | null | undefined }) {
  const { C } = useTheme();
  if (!text) return null;
  return (
    <View style={styles.tip} accessibilityLabel={`Drona: ${text}`}>
      <View style={[styles.tipBar, { backgroundColor: Colors.primary }]} />
      <Text style={[T.body, { color: C.foreground, flex: 1 }]}>{text}</Text>
    </View>
  );
}

/** One grey placeholder block. */
export function Bone({ w, h = 14, r = 6, style }: { w: number | `${number}%`; h?: number; r?: number; style?: StyleProp<ViewStyle> }) {
  const { C } = useTheme();
  return <View style={[{ width: w, height: h, borderRadius: r, backgroundColor: C.muted }, style]} />;
}

/**
 * The skeleton of a Goal-family screen while it loads: the title, the hero,
 * a week row and three rows, in the layout the real content takes, so
 * nothing jumps when it arrives.
 */
export function ScreenSkeleton({ variant }: { variant: 'goal' | 'pillar' | 'phase' }) {
  const { C } = useTheme();
  return (
    <View accessibilityLabel="Loading" style={{ paddingTop: S.sm }}>
      {variant === 'pillar' && <Bone w={160} h={12} style={{ marginBottom: S.md }} />}
      <Bone w={variant === 'pillar' ? 120 : 220} h={30} r={8} />
      <Bone w={150} h={14} style={{ marginTop: S.md }} />
      <View style={{ marginTop: S.xl, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <Bone w={150} h={48} r={10} />
        {variant === 'goal' && <Bone w={70} h={22} />}
      </View>
      {variant === 'goal' ? (
        <Bone w="100%" h={88} r={10} style={{ marginTop: S.lg }} />
      ) : (
        <View style={{ marginTop: S.xxl, flexDirection: 'row', justifyContent: 'space-between' }}>
          {Array.from({ length: 7 }, (_, i) => <Bone key={i} w={40} h={40} r={20} />)}
        </View>
      )}
      {variant === 'goal' && <Bone w="100%" h={120} r={22} style={{ marginTop: S.xl }} />}
      <View style={{ marginTop: S.xxl, borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
            <Bone w={110} h={14} />
            <View style={{ flex: 1 }} />
            <Bone w={70} h={12} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingVertical: S.sm },
  rowIcon: { width: 28, textAlign: 'center', marginRight: S.lg },
  rowIconWide: { width: 36, alignItems: 'center', marginRight: S.xl - 4 },
  rowStatus: { minWidth: 62, textAlign: 'right' },
  retry: { height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  tip: { flexDirection: 'row', gap: S.md, marginTop: S.xxl - 2 },
  tipBar: { width: 3, borderRadius: 2 },
});
