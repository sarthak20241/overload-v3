/**
 * MaintenanceRow: the calories this body burns, as Drona has learned them so
 * far, as one quiet row at the foot of the macros card ("Maintenance about
 * 2,290 kcal · Learning ›"). A tap opens MaintenanceSheet with the details.
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
import { useFocusEffect } from 'expo-router';
import { FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { useSupabaseClient } from '@/lib/supabase';
import { localDayISO } from '@/lib/dailySuggestion';
import { currentWeekStart } from '@/lib/dronaCard';
import {
  DATA_WEEKS_TO_MEASURE, WEIGH_INS_FOR_A_READ, WHOLE_DAYS_FOR_A_READ,
  maintenanceView, type MaintenanceFacts, type MaintenanceView,
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

  return (
    <>
      <Pressable
        onPress={() => { haptics.tick(); setOpen(true); }}
        hitSlop={6}
        style={[s.row, { borderTopColor: C.borderSubtle }]}
        accessibilityRole="button"
        accessibilityLabel={`${view.headline}. ${view.label}.`}
        accessibilityHint="Shows what Drona has learned about the calories you burn"
      >
        <Text style={[s.rowLabel, { color: C.textMuted }]}>Maintenance</Text>
        <Text style={[s.rowValue, { color: C.foreground }]}>{`about ${view.kcal} kcal`}</Text>
        <Text style={[s.rowState, { color: C.textDim }]}>{view.label}</Text>
        <View style={s.grow} />
        <Feather name="chevron-right" size={12} color={C.textDim} />
      </Pressable>
      <MaintenanceSheet open={open} view={view} onClose={() => setOpen(false)} />
    </>
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
    { label: 'Weigh-ins', value: `${view.readings} of ${WEIGH_INS_FOR_A_READ}` },
    { label: 'Whole food days', value: `${view.wholeDays} of ${WHOLE_DAYS_FOR_A_READ}` },
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
            <Text style={[s.caption, { color: C.textDim }]}>Weigh-ins and whole food days count over the last 4 weeks.</Text>

            <View style={s.nextRow}>
              <Feather name="arrow-right" size={12} color={C.accentText} style={{ marginTop: 3 }} />
              <Text style={[s.next, { color: C.foreground }]}>{view.next}</Text>
            </View>

            <Text style={[s.how, { color: C.textMuted }]}>
              It started from a formula using your stats. Every day, your weigh-ins and whole days of food move
              it toward what your body really burns. Your calorie goal never changes on its own.
            </Text>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  // The row: a hairline under the ring and bars, then one line of text.
  row: {
    flexDirection: 'row', alignItems: 'baseline', gap: 6,
    marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: FontSize.xs },
  rowValue: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  rowState: { fontSize: FontSize.xs },
  grow: { flex: 1 },

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
