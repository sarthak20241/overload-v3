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
import { ChevronRightIcon, SparkleIcon } from '@/components/program/LineIcons';

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

/**
 * The Goal screen's palette, sampled from the approved reference
 * (.planning/phase-metrics/shots/goal-screen-v2-reference.webp): a cool
 * near-black page, a cool grey card with a faint top edge, softer muted text
 * and dividers. Dark mode only; light mode keeps the theme's colours.
 */
export function useGoalPalette() {
  const { C, mode } = useTheme();
  if (mode === 'dark') {
    return {
      bg: '#0B0D0F',
      card: '#15191C',
      cardBorder: 'rgba(255,255,255,0.05)',
      cardTop: 'rgba(255,255,255,0.06)',
      muted: '#A5A9B1',
      /** A plan row's second line and the chevrons: a step quieter than `muted`. */
      rowSub: '#9A9EA6',
      /** The hero's caps labels (CURRENT WEIGHT, GOAL). */
      label: '#8E939B',
      /** A bar below its target (sleep nights), and a progress line's track. */
      barOff: '#2A2E33',
      track: 'rgba(255,255,255,0.06)',
      chevron: '#6B7078',
      divider: 'rgba(255,255,255,0.07)',
      icon: 'rgba(255,255,255,0.9)',
      dash: 'rgba(255,255,255,0.35)',
      ring: 'rgba(255,255,255,0.7)',
    };
  }
  return {
    bg: C.background,
    card: C.card,
    cardBorder: C.borderSubtle,
    cardTop: C.borderSubtle,
    muted: C.mutedFg,
    rowSub: C.mutedFg,
    label: C.mutedFg,
    barOff: C.muted,
    track: C.muted,
    chevron: C.textMuted,
    divider: C.borderSubtle,
    icon: C.foreground,
    dash: C.textMuted,
    ring: C.mutedFg,
  };
}

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
  /** The subtitle as parts joined by a spaced dot (DotLine), instead of `subtitle`. */
  subtitleParts?: string[];
  /** Taller rows for a short list that is the page's main content (the plan rows). */
  minHeight?: number;
  /**
   * The Goal screen's list look (the reference): its own muted colours, a
   * thin 1.5-stroke chevron, and 1pt lines in its divider colour above the
   * first row, between rows, and below the last.
   */
  look?: {
    muted: string; divider: string; titleSize?: number; subSize?: number; iconColumn?: number;
    titleWeight?: TextStyle['fontWeight']; sub?: string; chevron?: string; chevronSize?: number;
  };
  first?: boolean;
  last?: boolean;
  accessibilityLabel?: string;
}

/**
 * A list row: 52pt minimum, hairline dividers, a full-row press target with
 * a subtle pressed state, a chevron only when it navigates.
 */
export function Row({ title, value, valueRest, status, onPress, icon, iconNode, subtitle, subtitleParts, minHeight, look, first, last, accessibilityLabel }: RowProps) {
  const { C } = useTheme();
  const statusColor = useStatusColor();
  const body = (
    <>
      {iconNode
        ? <View style={[styles.rowIconWide, look?.iconColumn ? { width: look.iconColumn, marginRight: 18 } : null]}>{iconNode}</View>
        : icon && <Feather name={icon} size={22} color={C.foreground} style={styles.rowIcon} />}
      <View style={{ flex: 1 }}>
        <Text style={[T.rowTitle, look?.titleSize ? { fontSize: look.titleSize, lineHeight: look.titleSize + 5 } : null, look?.titleWeight ? { fontWeight: look.titleWeight } : null, { color: C.foreground }]} numberOfLines={1}>{title}</Text>
        {subtitleParts && subtitleParts.length > 0
          ? <DotLine parts={subtitleParts} style={[T.rowSub, look?.subSize ? { fontSize: look.subSize, lineHeight: look.subSize + 5 } : null, { color: look?.sub ?? look?.muted ?? C.mutedFg }]} containerStyle={{ marginTop: 2 }} />
          : subtitle ? <Text style={[T.rowSub, look?.subSize ? { fontSize: look.subSize, lineHeight: look.subSize + 5 } : null, { color: look?.sub ?? look?.muted ?? C.mutedFg, marginTop: 2 }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {(value || valueRest) && (
        <Text style={[T.rowValue, look ? styles.lookValue : null, { color: look?.muted ?? C.mutedFg, marginRight: status ? S.lg : 0 }]} numberOfLines={1}>
          {value ? <Text style={{ color: C.foreground, fontWeight: look ? FontWeight.medium : FontWeight.semibold }}>{value}</Text> : null}
          {valueRest ? `${value ? ' ' : ''}${valueRest}` : ''}
        </Text>
      )}
      {/* The Goal look keeps a status word in the muted colour; only a problem (warn) gets colour. */}
      {status && (
        <Text
          style={[T.status, styles.rowStatus, look ? styles.lookStatus : null, { color: look ? (status.tone === 'warn' ? statusColor('warn') : look.muted) : statusColor(status.tone) }]}
          numberOfLines={1}
        >
          {status.label}
        </Text>
      )}
      {onPress && (look
        // The reference's chevron: a 1.5 stroke, its right tip about 2pt
        // inside the text column's edge.
        ? <View style={{ marginLeft: S.sm, marginRight: -6 }}><ChevronRightIcon size={look.chevronSize ?? 23} strokeWidth={1.5} color={look.chevron ?? look.muted} /></View>
        : <Feather name="chevron-right" size={18} color={C.textMuted} style={{ marginLeft: S.sm }} />)}
    </>
  );
  // The Goal look draws a full 1pt line (the reference's), not a hairline.
  const border = look
    ? [first && { borderTopWidth: 1 }, { borderBottomWidth: 1 }, { borderColor: look.divider }]
    : [first && { borderTopWidth: StyleSheet.hairlineWidth }, !last && { borderBottomWidth: StyleSheet.hairlineWidth }, { borderColor: C.borderSubtle }];
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

/**
 * One line of parts joined by a dot with 6pt of air on each side (the
 * reference's spacing, wider than a space). The dot is its own Text: a
 * nested Text cannot take a margin. The last part shrinks and is cut first.
 */
export function DotLine({ parts, style, containerStyle, colors }: {
  parts: string[];
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  /** A colour per part (index-matched to `parts`), for the one word that needs it, such as a warn status. */
  colors?: (string | undefined)[];
}) {
  const shown = parts.map((p, i) => ({ p, color: colors?.[i] })).filter((x) => x.p.length > 0);
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'baseline' }, containerStyle]} accessible accessibilityLabel={shown.map((x) => x.p).join(', ')}>
      {shown.map(({ p, color }, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'baseline', flexShrink: i === shown.length - 1 ? 1 : 0 }}>
          {i > 0 && <Text style={[style, { marginHorizontal: 6 }]}>·</Text>}
          <Text style={[style, { flexShrink: 1 }, color ? { color } : null]} numberOfLines={1}>{p}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Drona's note at the bottom of a Goal & Plan screen, drawn like the Goal
 * screen's focus: the lime four-point sparkle, a small caps label, the text.
 * Nothing at all when there is no text.
 */
export function CoachNote({ label, text, style }: { label: string; text: string | null | undefined; style?: StyleProp<ViewStyle> }) {
  const { C } = useTheme();
  if (!text) return null;
  return (
    <View style={[styles.note, style]} accessible accessibilityLabel={`${label}: ${text}`}>
      <SparkleIcon size={18} color={Colors.primary} />
      <View style={{ flex: 1 }}>
        <SectionLabel style={styles.noteLabel}>{label}</SectionLabel>
        <Text style={[styles.noteText, { color: C.foreground }]}>{text}</Text>
      </View>
    </View>
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
  lookValue: { fontSize: 14, lineHeight: 19, fontWeight: FontWeight.regular },
  lookStatus: { fontSize: 13, lineHeight: 17, fontWeight: FontWeight.regular },
  note: { flexDirection: 'row', gap: 14, alignItems: 'flex-start', marginTop: 28 },
  noteLabel: { fontSize: 11, lineHeight: 14 },
  noteText: { fontSize: 14, lineHeight: 19, fontWeight: FontWeight.regular, marginTop: 4 },
  retry: { height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  tip: { flexDirection: 'row', gap: S.md, marginTop: S.xxl - 2 },
  tipBar: { width: 3, borderRadius: 2 },
});
