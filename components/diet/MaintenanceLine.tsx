/**
 * MaintenanceLine: the calories this body burns, as Drona has learned them so
 * far, under the day's ring on the Nutrition screen.
 *
 * Learning is daily, changing is weekly: the estimate's running week is
 * rebuilt every day, so this line moves as weigh-ins and whole food days land,
 * while the calorie target only moves on the weekly check-in card. Showing the
 * learning is what makes it feel alive without a card every day.
 *
 * Reads the newest week row with an estimate (RLS: own rows only), on every
 * focus. Fails soft: no row, no line. The words live in lib/maintenance.ts.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { FontSize, FontWeight, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { localDayISO } from '@/lib/dailySuggestion';
import { currentWeekStart } from '@/lib/dronaCard';
import { maintenanceView, type MaintenanceFacts, type MaintenanceView } from '@/lib/maintenance';

export function MaintenanceLine() {
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const [view, setView] = useState<MaintenanceView | null>(null);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('drona_week_facts')
          .select('m_estimate_kcal, m_source, m_data_weeks, m_readings_28, m_whole_days_28, m_last_weigh_in')
          .lte('week_start', currentWeekStart())
          .not('m_estimate_kcal', 'is', null)
          .order('week_start', { ascending: false })
          .limit(1)
          .maybeSingle();
        // A failed read keeps whatever was showing: a blip must not blank it.
        if (!live || error) return;
        setView(maintenanceView(data as MaintenanceFacts | null, localDayISO()));
      } catch {
        // Offline: keep the last line.
      }
    })();
    return () => { live = false; };
  }, [supabase]));

  if (!view) return null;
  const learning = view.source !== 'measured';

  return (
    <View
      style={s.row}
      accessible
      accessibilityLabel={`${view.headline}. ${view.label}. ${view.detail}`}
    >
      <View style={[s.icon, { backgroundColor: C.primarySubtle }]}>
        <Feather name="activity" size={11} color={C.accentText} />
      </View>
      <View style={s.body}>
        <View style={s.head}>
          <Text style={[s.headline, { color: C.foreground }]}>{view.headline}</Text>
          <Text style={[s.label, { color: C.textDim }]}>{view.label}</Text>
        </View>
        <Text style={[s.detail, { color: C.textMuted }]}>{view.detail}</Text>
        {learning && (
          <View style={[s.track, { backgroundColor: C.muted }]}>
            <View style={[s.fill, { backgroundColor: C.accentText, width: `${Math.round(view.progress * 100)}%` }]} />
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: Spacing.xl, marginTop: Spacing.md },
  icon: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  body: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
  headline: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, fontVariant: ['tabular-nums'] },
  label: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  detail: { fontSize: FontSize.xs, lineHeight: 16, marginTop: 2 },
  track: { height: 3, borderRadius: 2, marginTop: 6, overflow: 'hidden', maxWidth: 160 },
  fill: { height: 3, borderRadius: 2 },
});
