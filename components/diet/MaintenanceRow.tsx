/**
 * MaintenanceRow: the calories this body burns, as Drona has learned them so
 * far, as a quiet block at the foot of the macros card. The number leads
 * ("2,290 kcal maintenance"), then what it is still learning from as two small
 * counters with a bar each ("4/8 weigh-ins", "6/14 full days logged"), and a
 * "Weigh in" chip that opens the Analytics weight log straight away. A tap
 * anywhere else opens MaintenanceSheet with the details.
 *
 * Owner's call (2026-10-20): the old one-line sentence read as text, and
 * "4 of 14" meant nothing to a first-time user. Counters, not sentences.
 *
 * Owner's call (2026-10-18): the logging screen must not grow another block,
 * and the learning is good news, not a request, so it is never a popup.
 * Learning is daily, changing is weekly: the estimate's running week is
 * rebuilt every day, so this row moves as weigh-ins and whole food days land,
 * while the calorie target only moves on the weekly check-in card.
 *
 * Reads the newest week row with an estimate (RLS: own rows only), on every
 * focus. Fails soft: no row, nothing shown. The words live in lib/maintenance.ts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { useSupabaseClient } from '@/lib/supabase';
import { localDayISO } from '@/lib/dailySuggestion';
import { currentWeekStart } from '@/lib/dronaCard';
import {
  DATA_WEEKS_TO_MEASURE, maintenanceView,
  type MaintenanceCounter, type MaintenanceFacts, type MaintenanceView,
} from '@/lib/maintenance';

export function MaintenanceRow() {
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const [view, setView] = useState<MaintenanceView | null>(null);
  const [open, setOpen] = useState(false);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('drona_week_facts')
          .select('m_estimate_kcal, m_guess_kcal, m_source, m_data_weeks, m_readings_28, m_whole_days_28, m_last_weigh_in')
          .lte('week_start', currentWeekStart())
          .not('m_estimate_kcal', 'is', null)
          .order('week_start', { ascending: false })
          .limit(1)
          .maybeSingle();
        // A failed read keeps whatever was showing: a blip must not blank it.
        if (!live || error) return;
        setView(maintenanceView(data as MaintenanceFacts | null, localDayISO()));
      } catch {
        // Offline: keep the last row.
      }
    })();
    return () => { live = false; };
  }, [supabase]));

  if (!view) return null;

  // The existing weight log, opened on arrival. The stamp makes each tap a new
  // ask, so a tab that stays mounted still opens it the second time.
  const weighIn = () => {
    haptics.tick();
    router.navigate({ pathname: '/(app)/analytics', params: { logWeight: String(Date.now()) } } as any);
  };

  const counted = view.counters.map((c) => `${c.have} of ${c.need} ${c.label}`).join(', ');

  return (
    <View style={[s.row, { borderTopColor: C.borderSubtle }]}>
      <Pressable
        onPress={() => { haptics.tick(); setOpen(true); }}
        accessibilityRole="button"
        accessibilityLabel={`${view.headline}. ${view.label}.${counted ? ` ${counted} in the last 4 weeks.` : ''}`}
        accessibilityHint="Shows what Drona has learned about the calories you burn"
      >
        <View style={s.topLine}>
          <Text style={[s.kcal, { color: C.foreground }]}>{view.kcal}</Text>
          <Text style={[s.kcalUnit, { color: C.textMuted }]}>kcal maintenance</Text>
          <Text style={[s.state, { color: C.textDim }]}>{view.label.toLowerCase()}</Text>
        </View>
        {view.counters.length > 0 && (
          <View style={s.counters}>
            {view.counters.map((c) => <Counter key={c.key} c={c} />)}
            <Feather name="chevron-right" size={12} color={C.textDim} />
          </View>
        )}
      </Pressable>
      {/* A sibling over the top line, not a child of the row's button: nested
          in it, VoiceOver could not reach it. */}
      <Pressable
        onPress={weighIn}
        hitSlop={8}
        style={({ pressed }) => [s.chip, { borderColor: C.border, opacity: pressed ? 0.6 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel="Log a weigh-in"
      >
        <Feather name="plus" size={11} color={C.accentText} />
        <Text style={[s.chipTxt, { color: C.accentText }]}>Weigh in</Text>
      </Pressable>
      <MaintenanceSheet open={open} view={view} onClose={() => setOpen(false)} />
    </View>
  );
}

/** "4/8 weigh-ins" over a hairline bar: how much of what a read needs is in. */
function Counter({ c }: { c: MaintenanceCounter }) {
  const { C } = useTheme();
  const done = c.have >= c.need;
  return (
    <View style={s.counter}>
      <Text style={s.counterLine} numberOfLines={1}>
        <Text style={[s.counterNum, { color: done ? C.accentText : C.foreground }]}>{`${c.have}/${c.need}`}</Text>
        <Text style={{ color: C.textMuted }}>{` ${c.label}`}</Text>
      </Text>
      <View style={[s.counterTrack, { backgroundColor: C.muted }]}>
        <View style={[s.counterFill, { backgroundColor: C.accentText, width: `${Math.round((c.have / c.need) * 100)}%` }]} />
      </View>
    </View>
  );
}

function MaintenanceSheet({ open, view, onClose }: { open: boolean; view: MaintenanceView; onClose: () => void }) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

  const facts = [
    ...(view.guess ? [{ label: 'Formula guess', value: view.guess }] : []),
    ...view.counters.map((c) => ({ label: c.label[0].toUpperCase() + c.label.slice(1), value: `${c.have}/${c.need}` })),
  ];

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          entering={SlideInDown.duration(320).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(180)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.lg }]}
        >
          <Pressable>
            <View style={[s.handle, { backgroundColor: C.handle }]} />
            <Text style={[s.eyebrow, { color: C.textDim }]}>YOUR MAINTENANCE</Text>
            <View style={s.bigLine}>
              <Text style={[s.big, { color: C.foreground }]}>{view.kcal}</Text>
              <Text style={[s.unit, { color: C.textMuted }]}>kcal a day</Text>
              <View style={[s.pill, { borderColor: C.border }]}>
                <Text style={[s.pillTxt, { color: C.textSecondary }]}>{view.label}</Text>
              </View>
            </View>
            <Text style={[s.detail, { color: C.textSecondary }]}>{view.detail}</Text>

            {view.source !== 'measured' && (
              <View style={s.progressBlock}>
                <View style={[s.track, { backgroundColor: C.muted }]}>
                  <View style={[s.fill, { backgroundColor: C.accentText, width: `${Math.round(view.progress * 100)}%` }]} />
                </View>
                <Text style={[s.caption, { color: C.textDim }]}>
                  {`Learned so far: ${Math.round(view.progress * 100)}%. ${DATA_WEEKS_TO_MEASURE} good weeks make it measured.`}
                </Text>
              </View>
            )}

            <View style={[s.facts, { backgroundColor: C.muted }]}>
              {facts.map((f, i) => (
                <View key={f.label} style={s.factWrap}>
                  {i > 0 && <View style={[s.factDivider, { backgroundColor: C.borderSubtle }]} />}
                  <View style={s.fact}>
                    <Text style={[s.factValue, { color: C.foreground }]}>{f.value}</Text>
                    <Text style={[s.factLabel, { color: C.textDim }]} numberOfLines={2}>{f.label}</Text>
                  </View>
                </View>
              ))}
            </View>
            <Text style={[s.caption, { color: C.textDim }]}>Counted over the last 4 weeks. A full day is one where you logged everything you ate.</Text>

            <View style={s.nextRow}>
              <Feather name="arrow-right" size={12} color={C.accentText} style={{ marginTop: 3 }} />
              <Text style={[s.next, { color: C.foreground }]}>{view.next}</Text>
            </View>

            <Text style={[s.how, { color: C.textMuted }]}>
              It started from a formula using your stats. Every day, your weigh-ins and full days of food move
              it toward what your body really burns. Your calorie goal never changes on its own.
            </Text>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const CHIP_H = 24;

const s = StyleSheet.create({
  // The row: a hairline under the ring and bars, the number, then two counters.
  row: { marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  // Room on the right for the chip, which sits over this line.
  topLine: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: CHIP_H, paddingRight: 84 },
  kcal: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  kcalUnit: { fontSize: FontSize.xs },
  state: { fontSize: FontSize.xs },
  chip: {
    position: 'absolute', right: 0, top: Spacing.sm, height: CHIP_H,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: Radius.full, paddingHorizontal: 9,
  },
  chipTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  counters: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, marginTop: Spacing.sm },
  counter: { flex: 1, gap: 4 },
  counterLine: { fontSize: 11 },
  counterNum: { fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  counterTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  counterFill: { height: 3, borderRadius: 2 },

  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: Spacing.lg },
  eyebrow: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow },
  bigLine: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: Spacing.xs },
  big: { fontSize: 34, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.tight, fontVariant: ['tabular-nums'] },
  unit: { fontSize: FontSize.sm },
  pill: { borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 6, paddingVertical: 1, marginLeft: 2 },
  pillTxt: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  detail: { fontSize: FontSize.sm, lineHeight: 19, marginTop: Spacing.xs },
  progressBlock: { marginTop: Spacing.md },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  caption: { fontSize: FontSize.xs, marginTop: 6 },
  facts: { flexDirection: 'row', borderRadius: Radius.md, paddingVertical: Spacing.md, marginTop: Spacing.lg },
  factWrap: { flex: 1, flexDirection: 'row' },
  factDivider: { width: StyleSheet.hairlineWidth, marginVertical: 2 },
  fact: { flex: 1, alignItems: 'center', paddingHorizontal: Spacing.xs },
  factValue: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  factLabel: { fontSize: 11, textAlign: 'center', marginTop: 2 },
  nextRow: { flexDirection: 'row', gap: 8, marginTop: Spacing.lg },
  next: { flex: 1, fontSize: FontSize.sm, lineHeight: 19, fontWeight: FontWeight.medium },
  how: { fontSize: FontSize.xs, lineHeight: 17, marginTop: Spacing.lg },
});
