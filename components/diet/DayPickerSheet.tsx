/**
 * DayPickerSheet — a compact month calendar for jumping the diet diary to any
 * past day (MyFitnessPal's date picker). Portal sheet like the other diet sheets
 * (flush on Android edge-to-edge). Future days are disabled — you can't log ahead
 * of today. No external calendar lib; the grid is a plain 7-column layout.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { ymd } from '@/lib/dietData';

interface Props {
  open: boolean;
  date: Date;              // currently-viewed day (selected + initial month)
  onClose: () => void;
  onPick: (date: Date) => void;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function DayPickerSheet({ open, date, onClose, onPick }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  // First-of-month cursor for the displayed grid.
  const [cursor, setCursor] = useState(() => new Date(date.getFullYear(), date.getMonth(), 1));

  useEffect(() => {
    if (open) setCursor(new Date(date.getFullYear(), date.getMonth(), 1));
  }, [open, date]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

  const todayIso = ymd(new Date());
  const selIso = ymd(date);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Leading blanks + each day cell.
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  // Don't page past the current month.
  const canGoNext = year < new Date().getFullYear() || (year === new Date().getFullYear() && month < new Date().getMonth());
  const stepMonth = (dir: -1 | 1) => { haptics.tick(); setCursor(new Date(year, month + dir, 1)); };

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

            {/* Month header */}
            <View style={s.head}>
              <TouchableOpacity onPress={() => stepMonth(-1)} hitSlop={10} style={[s.navBtn, { backgroundColor: C.muted }]}>
                <Feather name="chevron-left" size={18} color={C.foreground} />
              </TouchableOpacity>
              <Text style={[s.month, { color: C.foreground }]}>{MONTHS[month]} {year}</Text>
              <TouchableOpacity onPress={() => canGoNext && stepMonth(1)} disabled={!canGoNext} hitSlop={10} style={[s.navBtn, { backgroundColor: C.muted, opacity: canGoNext ? 1 : 0.35 }]}>
                <Feather name="chevron-right" size={18} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {/* Weekday row */}
            <View style={s.weekRow}>
              {WEEK.map((w, i) => <Text key={i} style={[s.weekTxt, { color: C.textDim }]}>{w}</Text>)}
            </View>

            {/* Day grid */}
            <View style={s.grid}>
              {cells.map((d, i) => {
                if (d == null) return <View key={i} style={s.cell} />;
                const cellDate = new Date(year, month, d);
                const iso = ymd(cellDate);
                const isFuture = iso > todayIso;
                const isSel = iso === selIso;
                const isToday = iso === todayIso;
                return (
                  <Pressable
                    key={i}
                    disabled={isFuture}
                    onPress={() => { haptics.selection(); onPick(cellDate); onClose(); }}
                    style={s.cell}
                  >
                    <View style={[s.dayInner, isSel && { backgroundColor: Colors.primary }]}>
                      <Text style={[
                        s.dayTxt,
                        { color: isFuture ? C.textDim : isSel ? Colors.primaryFg : C.foreground },
                        isToday && !isSel && { color: C.accentText, fontWeight: FontWeight.bold },
                      ]}>{d}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <Pressable onPress={() => { haptics.selection(); onPick(new Date()); onClose(); }} style={s.todayBtn}>
              <Text style={[s.todayTxt, { color: C.accentText }]}>Jump to today</Text>
            </Pressable>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md },
  navBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  month: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.snug },
  weekRow: { flexDirection: 'row', marginBottom: Spacing.xs },
  weekTxt: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: FontWeight.semibold },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 2 },
  dayInner: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  dayTxt: { fontSize: FontSize.base, fontVariant: ['tabular-nums'] },
  todayBtn: { alignSelf: 'center', marginTop: Spacing.md, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg },
  todayTxt: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
});
