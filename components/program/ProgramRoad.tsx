/**
 * The program's road: one row per phase (weeks, name, kcal and split), each
 * opening to its kcal and macro chips, the week strip, fuel days, activity
 * goals and the diet / training / recovery directives. Shared by onboarding's
 * plan reveal (app/onboarding.tsx) and the program draft Drona builds from the
 * goal questions (AICoachModal GenerateProgramScreen), so a plan reads the
 * same in both places, and the same as the Goal screen once it is saved.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import { REST, shortDayLabel, weekPatternFor } from '@/lib/weekPattern';
import { fuelDaysText } from '@/lib/fuelDays';
import { activityText } from '@/lib/activityGoals';
import type { GeneratedProgram } from '@/lib/programData';

type Directive = { icon: 'zap' | 'activity' | 'moon' | 'trending-up'; label: string; text: string };

export function ProgramRoad({
  program,
  delay = 90,
  openFirst = false,
}: {
  program: GeneratedProgram;
  /** Start with phase 1 open (the program draft); onboarding starts closed. */
  openFirst?: boolean;
  /** Entrance delay, so it can follow other cards in a stagger. */
  delay?: number;
}) {
  const { C } = useTheme();
  const roadRows = useMemo(() => {
    let offset = 0;
    return program.phases.map((ph, idx) => {
      const start = offset + 1;
      const end = offset + ph.duration_weeks;
      offset = end;
      const weeks = start === end ? `Wk ${start}` : `Wk ${start}-${end}`;
      // A closed row says only how you eat and train; the why is inside.
      const meta = [
        ph.diet.calories != null ? `${ph.diet.calories.toLocaleString()} kcal` : null,
        // A phase without a named split still says how often you train.
        ph.training_block?.split_type ??
          (ph.training_block?.days_per_week
            ? `${ph.training_block.days_per_week} ${ph.training_block.days_per_week === 1 ? 'day' : 'days'} a week`
            : null),
      ]
        .filter(Boolean)
        .join(' · ');
      const macros = [
        ph.diet.protein_g != null ? { label: 'PROTEIN', value: `${ph.diet.protein_g}g` } : null,
        ph.diet.carb_g != null ? { label: 'CARBS', value: `${ph.diet.carb_g}g` } : null,
        ph.diet.fat_g != null ? { label: 'FAT', value: `${ph.diet.fat_g}g` } : null,
      ].filter(Boolean) as Array<{ label: string; value: string }>;
      // Same three icons the Goal screen uses, so a phase reads the same here
      // as it will there once it is saved. Fuel days and activity goals ride
      // along when the phase has them.
      const directives = [
        { icon: 'zap' as const, label: 'DIET', text: ph.diet_directive ?? null },
        { icon: 'zap' as const, label: 'FUEL DAYS', text: ph.fuel_days && ph.fuel_days.length > 0 ? fuelDaysText(ph.fuel_days) : null },
        { icon: 'activity' as const, label: 'TRAINING', text: ph.training_directive ?? null },
        { icon: 'trending-up' as const, label: 'MOVEMENT', text: ph.activity ? activityText(ph.activity) : null },
        { icon: 'moon' as const, label: 'RECOVERY', text: ph.readiness_directive ?? null },
      ].filter((d) => !!d.text) as Directive[];
      return {
        key: `${idx}-${ph.name}`,
        weeks,
        name: ph.name,
        meta,
        kcal: ph.diet.calories ?? null,
        macros,
        week: weekPatternFor(ph.training_block),
        split: ph.training_block?.split_type ?? null,
        directives,
      };
    });
  }, [program]);

  // Which row is open, if any. One at a time: every open row is a long scroll.
  const [openPhase, setOpenPhase] = useState<string | null>(
    openFirst && program.phases[0] ? `0-${program.phases[0].name}` : null,
  );

  // The whole route to the goal, not just week one.
  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(400)}
      style={[st.roadCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
    >
      <Text style={[st.eyebrow, { color: C.textMuted }]}>THE ROAD</Text>
      <Text style={[st.roadTitle, { color: C.foreground }]}>{program.title}</Text>
      {program.objective ? (
        <ClampedText
          text={program.objective}
          lines={2}
          style={[st.roadObjective, { color: C.textSecondary }]}
        />
      ) : null}
      <View style={st.roadList}>
        {roadRows.map((row) => {
          const open = openPhase === row.key;
          return (
            <View key={row.key}>
              <Pressable
                onPress={() => setOpenPhase(open ? null : row.key)}
                style={st.roadRow}
                hitSlop={6}
              >
                <Text style={[st.roadWeeks, { color: C.accentText }]}>{row.weeks}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[st.roadName, { color: C.foreground }]} numberOfLines={open ? undefined : 1}>
                    {row.name}
                  </Text>
                  {row.meta && !open ? (
                    <Text style={[st.roadMeta, { color: C.textMuted }]} numberOfLines={1}>{row.meta}</Text>
                  ) : null}
                </View>
                <Feather
                  name={open ? 'chevron-up' : 'chevron-down'}
                  size={14}
                  color={C.textMuted}
                  style={{ marginTop: 2 }}
                />
              </Pressable>

              {open && (
                <Animated.View entering={FadeIn.duration(180)} style={st.roadDetail}>
                  {(row.kcal != null || row.macros.length > 0) && (
                    <View style={st.roadChipRow}>
                      {row.kcal != null && (
                        <View
                          style={[
                            st.roadChip,
                            { backgroundColor: C.primaryMuted, borderColor: C.primaryBorder },
                          ]}
                        >
                          <Text style={[st.roadChipValue, { color: C.accentText }]}>
                            {row.kcal.toLocaleString()}
                          </Text>
                          <Text style={[st.roadChipLabel, { color: C.accentText }]}>KCAL / DAY</Text>
                        </View>
                      )}
                      {row.macros.map((m) => (
                        <View
                          key={m.label}
                          style={[st.roadChip, { backgroundColor: C.muted, borderColor: 'transparent' }]}
                        >
                          <Text style={[st.roadChipValue, { color: C.foreground }]}>{m.value}</Text>
                          <Text style={[st.roadChipLabel, { color: C.textMuted }]}>{m.label}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {row.week && (
                    <View style={{ marginTop: Spacing.md }}>
                      <Text style={[st.roadDetailLabel, { color: C.textMuted }]}>
                        {row.split ? `YOUR WEEK · ${row.split}` : 'YOUR WEEK'}
                      </Text>
                      <View style={st.roadWeekStrip}>
                        <View style={[st.roadWeekRule, { backgroundColor: C.borderSubtle }]} />
                        {row.week.map((label, i) => {
                          const rest = label === REST;
                          return (
                            <View key={i} style={st.roadWeekCell}>
                              <View
                                style={[
                                  st.roadWeekDot,
                                  rest
                                    ? { backgroundColor: C.background, borderColor: C.borderSubtle }
                                    : { backgroundColor: C.accentText, borderColor: C.accentText },
                                ]}
                              />
                              <Text style={[st.roadWeekDay, { color: C.textMuted }]}>D{i + 1}</Text>
                              <Text
                                numberOfLines={1}
                                style={[
                                  st.roadWeekLabel,
                                  {
                                    color: rest ? C.textMuted : C.foreground,
                                    fontWeight: rest ? FontWeight.medium : FontWeight.semibold,
                                  },
                                ]}
                              >
                                {shortDayLabel(label)}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  )}

                  {row.directives.map((d) => (
                    <View key={d.label} style={st.roadDirectiveRow}>
                      <View style={[st.roadDirectiveIcon, { backgroundColor: C.primaryMuted }]}>
                        <Feather name={d.icon} size={12} color={C.accentText} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[st.roadDetailLabel, { color: C.textMuted }]}>{d.label}</Text>
                        <Text style={[st.roadDetailText, { color: C.textSecondary }]}>{d.text}</Text>
                      </View>
                    </View>
                  ))}
                </Animated.View>
              )}
            </View>
          );
        })}
      </View>
    </Animated.View>
  );
}

/** Two lines of text that open in full on a tap. */
export function ClampedText({ text, lines, style }: { text: string; lines: number; style: StyleProp<TextStyle> }) {
  const [open, setOpen] = useState(false);
  // New text starts closed again.
  useEffect(() => setOpen(false), [text]);
  return (
    <Text
      style={style}
      numberOfLines={open ? undefined : lines}
      onPress={() => setOpen((o) => !o)}
      suppressHighlighting
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityHint={open ? undefined : 'Shows the rest'}
    >
      {text}
    </Text>
  );
}

const st = StyleSheet.create({
  roadCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    marginTop: Spacing.md,
  },
  roadTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: Spacing.xs },
  roadObjective: { fontSize: FontSize.sm, lineHeight: 19, marginTop: 4 },
  roadList: { marginTop: Spacing.md, gap: Spacing.sm },
  roadRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  roadWeeks: {
    width: 64,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    paddingTop: 2,
  },
  roadName: { fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  roadMeta: { fontSize: FontSize.xs, lineHeight: 16, marginTop: 1 },
  roadDetail: { marginTop: Spacing.sm },
  roadDirectiveRow: { flexDirection: 'row', gap: 10, marginTop: Spacing.md, alignItems: 'flex-start' },
  roadDirectiveIcon: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  roadChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  roadChip: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'flex-start',
    gap: 1,
  },
  roadChipValue: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  roadChipLabel: { fontSize: 8, fontWeight: FontWeight.semibold, letterSpacing: 0.7 },
  roadDetailLabel: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.8, marginBottom: 3 },
  roadDetailText: { fontSize: FontSize.sm, lineHeight: 19 },
  roadWeekStrip: { flexDirection: 'row', marginTop: 4 },
  roadWeekRule: { position: 'absolute', left: 12, right: 12, top: 4, height: StyleSheet.hairlineWidth },
  roadWeekCell: { flex: 1, alignItems: 'center', gap: 3 },
  roadWeekDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1 },
  roadWeekDay: { fontSize: 8, fontWeight: FontWeight.semibold, letterSpacing: 0.4 },
  roadWeekLabel: { fontSize: 9, textAlign: 'center' },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
  },
});
