/**
 * Onboarding UI kit (Phase 0 of the redesign, .planning/onboarding-redesign-plan.md).
 * Template v2 (user-approved direction, 2026-07-18): Cal AI-clean. The question
 * owns the screen: no eyebrow, no glow, display-size type, calm option rows with
 * radios, continuous progress bar, pinned pill CTA.
 *
 * The shared frame every intake step drops into. Owning the frame here keeps the
 * motion grammar (250 ms step fade, 400 ms staggered content, press-scale CTA)
 * and the haptic contract (selection tick on choose, tap on Continue) identical
 * across every step.
 *
 * Psychology contract (locked in the plan):
 * - The progress bar NEVER reads zero: welcome + account count as already done,
 *   so the first question opens with visible progress (goal gradient effect).
 * - There is no skip affordance. Steps arrive pre-answered with the most common
 *   choice instead (smart defaults) so Continue is always one tap.
 */
import React, { useEffect } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  Colors,
  FontFamily,
  FontSize,
  FontWeight,
  IconSize,
  Radius,
  Shadow,
  Spacing,
} from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { PressableScale } from '@/components/ui/PressableScale';
import { haptics } from '@/lib/haptics';

// ─── Header: back chevron + continuous progress bar ─────────────────────────

export function OnboardingHeader({
  onBack,
  progressIndex,
  progressTotal,
}: {
  onBack: () => void;
  /** Index of the current step among the progress steps (0-based). */
  progressIndex: number;
  progressTotal: number;
}) {
  const { C } = useTheme();
  // Head start (goal gradient): welcome counts as a completed slot, and the
  // current step's slot fills as "in progress", so the first question already
  // shows ~2/(n+1) of the bar.
  const fraction = Math.min(1, (progressIndex + 2) / (progressTotal + 1));
  const width = useSharedValue(fraction);
  useEffect(() => {
    width.value = withTiming(fraction, { duration: 350 });
  }, [fraction, width]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${width.value * 100}%` }));

  return (
    <View style={k.header}>
      <TouchableOpacity
        onPress={onBack}
        style={k.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Feather name="chevron-left" size={IconSize.lg} color={C.textMuted} />
      </TouchableOpacity>
      <View style={[k.progressTrack, { backgroundColor: C.muted }]}>
        <Animated.View
          // accentText, not raw lime: identical in dark, readable on cream in light.
          style={[k.progressFill, { backgroundColor: C.accentText }, fillStyle]}
        />
      </View>
      <View style={k.headerSpacer} />
    </View>
  );
}

// ─── Step container: fade-in fill with scrollable question content ──────────

export function QuestionStep({
  stepKey,
  question,
  sub,
  children,
  caption,
  footer,
  keyboardTaps = false,
}: {
  stepKey: string;
  question: string;
  sub: string;
  children?: React.ReactNode;
  /** Quiet one-liner under the content (e.g. "Most lifters start here."). */
  caption?: string;
  /** Pinned below the scroll area (PrimaryCta and friends). */
  footer?: React.ReactNode;
  /** Set for steps with text inputs so taps commit instead of dismissing. */
  keyboardTaps?: boolean;
}) {
  const { C } = useTheme();
  return (
    <Animated.View key={stepKey} entering={FadeIn.duration(250)} style={k.stepFill}>
      <ScrollView
        contentContainerStyle={k.stepScroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps={keyboardTaps ? 'handled' : 'never'}
      >
        <Text style={[k.question, { color: C.foreground }]}>{question}</Text>
        <Text style={[k.questionSub, { color: C.textMuted }]}>{sub}</Text>
        {children}
        {caption != null && (
          <Text style={[k.caption, { color: C.textDim }]}>{caption}</Text>
        )}
      </ScrollView>
      {footer != null && <View style={k.footer}>{footer}</View>}
    </Animated.View>
  );
}

// ─── Option card: icon circle + label (+ optional sub) + radio ──────────────

export function OptionCard({
  icon,
  title,
  sub,
  selected,
  onPress,
  index,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  sub?: string;
  selected: boolean;
  onPress: () => void;
  index: number;
}) {
  const { C } = useTheme();
  return (
    <Animated.View entering={FadeInDown.delay(100 + index * 60).duration(400)}>
      <PressableScale
        onPress={() => {
          haptics.selection();
          onPress();
        }}
        style={[
          k.option,
          {
            backgroundColor: selected ? C.primaryMuted : C.card,
            borderColor: selected ? C.primaryBorder : 'transparent',
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected }}
      >
        <View style={[k.optionIcon, { backgroundColor: C.muted }]}>
          <Feather name={icon} size={IconSize.sm} color={selected ? C.accentText : C.textMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[k.optionTitle, { color: C.foreground }]}>{title}</Text>
          {sub != null && <Text style={[k.optionSub, { color: C.textDim }]}>{sub}</Text>}
        </View>
        <View
          style={[
            k.radio,
            selected
              ? { backgroundColor: C.accentText, borderColor: C.accentText }
              : { borderColor: C.border },
          ]}
        >
          {selected && <View style={[k.radioDot, { backgroundColor: C.background }]} />}
        </View>
      </PressableScale>
    </Animated.View>
  );
}

// ─── Primary CTA: the one continue button (pill) ────────────────────────────

export function PrimaryCta({
  label,
  onPress,
  disabled = false,
  loading = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <PressableScale
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      disabled={disabled || loading}
      style={[k.primaryBtn, Shadow.playBtn, (disabled || loading) && { opacity: 0.7 }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {loading ? (
        <ActivityIndicator size="small" color={Colors.primaryFg} />
      ) : (
        <>
          <Text style={k.primaryBtnText}>{label}</Text>
          <Feather name="arrow-right" size={IconSize.sm} color={Colors.primaryFg} />
        </>
      )}
    </PressableScale>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const k = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
    gap: Spacing.md,
  },
  backBtn: { padding: 2 },
  headerSpacer: { width: 28 },
  progressTrack: {
    flex: 1,
    height: 4,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  progressFill: { height: 4, borderRadius: Radius.full },

  stepFill: { flex: 1 },
  stepScroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.xxxl,
    paddingBottom: Spacing.xxxl,
  },
  question: {
    fontFamily: FontFamily.display,
    fontSize: 36,
    letterSpacing: -0.5,
    lineHeight: 43,
  },
  questionSub: {
    fontSize: FontSize.md,
    lineHeight: 21,
    marginTop: Spacing.md,
    marginBottom: Spacing.xxxl,
  },
  caption: {
    fontSize: FontSize.sm,
    lineHeight: 18,
    marginTop: Spacing.lg,
  },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: 20,
    borderWidth: 1,
    minHeight: 68,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  optionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionTitle: { fontSize: 17, fontWeight: FontWeight.semibold },
  optionSub: { fontSize: FontSize.sm, marginTop: 2 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 8, height: 8, borderRadius: 4 },

  footer: {
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    height: 56,
    borderRadius: Radius.full,
  },
  primaryBtnText: {
    fontSize: 17,
    fontWeight: FontWeight.bold,
    color: Colors.primaryFg,
  },
});
