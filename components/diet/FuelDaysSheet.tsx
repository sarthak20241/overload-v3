/**
 * FuelDaysSheet: pick the weekdays that get more food, and how much more.
 *
 * A Sunday long run or a Saturday heavy leg day burns far more than a desk
 * day. Each picked day gets extra calories on top of the daily goal (as carbs,
 * see lib/fuelDays), with an optional reason in the user's words so the day
 * reads as "Long run" wherever it shows. Opened from Goal & Plan and from the
 * nutrition screen. Portal sheet, matching NutritionGoalSheet.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, TouchableOpacity, StyleSheet, BackHandler, Keyboard, Platform, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { Portal } from '@/components/ui/Portal';
import { useSheetSlide } from '@/hooks/useSheetSlide';
import { haptics } from '@/lib/haptics';
import { saveFuelDays } from '@/lib/dietData';
import { loadActiveProgram } from '@/lib/programData';
import { useSupabaseClient } from '@/lib/supabase';
import { useClerkUser } from '@/hooks/useClerkUser';
import {
  DAY_NAMES, FUEL_DEFAULT, FUEL_MAX, FUEL_MIN, FUEL_STEP, WEEK_ORDER,
  normalizeFuelDays, weekKcal, type FuelDay,
} from '@/lib/fuelDays';

interface Props {
  open: boolean;
  initial: FuelDay[];
  /** The ordinary day's calories, so the sheet can show what a fuel day becomes. */
  baseKcal: number;
  /** Where it was opened from, for analytics. */
  source: 'goal_plan' | 'nutrition';
  /**
   * The program phase running now; its plan is saved too, so a later "Adjust
   * with Drona" does not read stale days back. Goal & Plan passes it (null =
   * no phase running). Left undefined (the nutrition screen), the sheet looks
   * the current phase up itself at save time.
   */
  phaseId?: string | null;
  onClose: () => void;
  onSaved: (saved: FuelDay[]) => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** "Saturday and Sunday", "Tuesday, Thursday and Sunday". */
function joinDays(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function FuelDaysSheet({ open, initial, baseKcal, source, phaseId, onClose, onSaved }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();

  // Keyed by weekday so toggling a day off and on again keeps what was typed.
  const [days, setDays] = useState<Record<number, FuelDay>>({});
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const { mounted, slideStyle } = useSheetSlide(open);
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (!open) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [open]);

  // Seed on the closed -> open edge only, like NutritionGoalSheet: a focus
  // refetch must not overwrite a half-typed label.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const seed = normalizeFuelDays(initial);
      setDays(Object.fromEntries(seed.map((d) => [d.dow, d])));
      setPicked(seed.map((d) => d.dow));
      setBusy(false);
      setFailed(false);
      track('fuel_days_opened', { source, count: seed.length });
    }
    wasOpen.current = open;
  }, [open, initial, source]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!mounted) return <Portal>{null}</Portal>;

  const toggle = (dow: number) => {
    haptics.selection();
    if (picked.includes(dow)) {
      setPicked(picked.filter((d) => d !== dow));
      return;
    }
    if (!days[dow]) setDays({ ...days, [dow]: { dow, kcal: FUEL_DEFAULT } });
    setPicked([...picked, dow]);
  };
  const step = (dow: number, dir: 1 | -1) => {
    const cur = days[dow]?.kcal ?? FUEL_DEFAULT;
    const next = Math.min(FUEL_MAX, Math.max(FUEL_MIN, cur + dir * FUEL_STEP));
    if (next === cur) return;
    haptics.selection();
    setDays({ ...days, [dow]: { ...days[dow], dow, kcal: next } });
  };
  const setLabel = (dow: number, label: string) => {
    setDays({ ...days, [dow]: { ...days[dow], dow, kcal: days[dow]?.kcal ?? FUEL_DEFAULT, label } });
  };

  const chosen = normalizeFuelDays(WEEK_ORDER.filter((d) => picked.includes(d)).map((d) => days[d]));
  const base = Math.round(baseKcal);
  const perDay = base > 0 ? Math.round(weekKcal(base, chosen) / 7) : null;

  // One sentence the user can check against their week.
  const summary = chosen.length === 0
    ? 'Every day gets the same goal. Pick the days you train hardest and they get more.'
    : (() => {
        const amounts = new Set(chosen.map((d) => d.kcal));
        const names = joinDays(chosen.map((d) => DAY_NAMES[d.dow]));
        const lift = amounts.size === 1 && base > 0
          ? `${names} ${chosen.length === 1 ? 'goes' : 'go'} up to ${fmt(base + chosen[0].kcal)}.`
          : `${names} get more.`;
        return `${lift} The rest stay at ${fmt(base)}. The extra comes as carbs, the fuel for long and heavy work.`;
      })();

  const onSave = async () => {
    const clerkId = user?.id;
    if (!supabase || !clerkId || busy) { onClose(); return; }
    setBusy(true);
    setFailed(false);
    haptics.selection();
    // Find the phase running today when the caller did not say. A failed
    // lookup fails the save: writing only the live days is exactly how the
    // plan and the live days drifted apart.
    let targetPhase = phaseId;
    if (targetPhase === undefined) {
      try {
        const program = await loadActiveProgram(supabase, clerkId);
        targetPhase = program && program.currentPhaseSeq != null
          ? program.phases[program.currentPhaseSeq]?.id ?? null
          : null;
      } catch {
        setBusy(false);
        haptics.warning();
        setFailed(true);
        return;
      }
    }
    const { error } = await saveFuelDays(supabase, clerkId, chosen, targetPhase);
    setBusy(false);
    if (error) { haptics.warning(); setFailed(true); return; }
    track('fuel_days_saved', {
      source,
      count: chosen.length,
      extra_kcal_week: chosen.reduce((s, d) => s + d.kcal, 0),
      labelled: chosen.filter((d) => d.label).length,
    });
    onSaved(chosen);
  };

  return (
    <Portal>
      <View style={s.backdrop} pointerEvents={open ? 'auto' : 'none'}>
        {open && (
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
          </Animated.View>
        )}
        <Animated.View
          style={[s.sheet, slideStyle, {
            backgroundColor: C.elevated,
            paddingBottom: kbHeight > 0 ? Spacing.md : insets.bottom + Spacing.md,
            marginBottom: kbHeight,
            maxHeight: (winH - kbHeight) * 0.9,
          }]}
        >
          <View style={[s.handle, { backgroundColor: C.handle }]} />

          <View style={s.header}>
            <View style={{ flex: 1 }}>
              <Text style={[s.title, { color: C.foreground }]}>Fuel days</Text>
              <Text style={[s.subtitle, { color: C.mutedFg }]}>Eat more on the days you work hardest</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityLabel="Close">
              <Feather name="x" size={15} color={C.foreground} />
            </TouchableOpacity>
          </View>

          {/* The week, Monday first. A picked day wears the accent. */}
          <View style={s.week}>
            {WEEK_ORDER.map((dow) => {
              const on = picked.includes(dow);
              return (
                <Pressable
                  key={dow}
                  onPress={() => toggle(dow)}
                  style={[
                    s.dayPill,
                    on
                      ? { backgroundColor: Colors.primary, borderColor: Colors.primary }
                      : { backgroundColor: 'transparent', borderColor: C.border },
                  ]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${DAY_NAMES[dow]} fuel day`}
                >
                  <Text style={[s.dayPillTxt, { color: on ? Colors.primaryFg : C.mutedFg }]}>
                    {DAY_NAMES[dow].slice(0, 1)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
            {WEEK_ORDER.filter((d) => picked.includes(d)).map((dow) => {
              const d = days[dow] ?? { dow, kcal: FUEL_DEFAULT };
              return (
                <Animated.View key={dow} entering={FadeInDown.duration(180)} style={[s.row, { borderColor: C.borderSubtle }]}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={[s.dayName, { color: C.foreground }]}>{DAY_NAMES[dow]}</Text>
                    <TextInput
                      // Uncontrolled on purpose: a controlled input inside the
                      // Portal can drop keystrokes while the sheet re-renders.
                      defaultValue={d.label ?? ''}
                      onChangeText={(t) => setLabel(dow, t)}
                      placeholder="What's on? Long run, leg day..."
                      placeholderTextColor={C.textMuted}
                      autoCorrect={false}
                      autoCapitalize="sentences"
                      maxLength={24}
                      returnKeyType="done"
                      style={[s.labelInput, { color: C.foreground }]}
                      accessibilityLabel={`What ${DAY_NAMES[dow]} is for`}
                    />
                  </View>
                  <View style={s.stepper}>
                    <TouchableOpacity
                      onPress={() => step(dow, -1)}
                      disabled={d.kcal <= FUEL_MIN}
                      style={[s.stepBtn, { backgroundColor: C.muted, opacity: d.kcal <= FUEL_MIN ? 0.4 : 1 }]}
                      accessibilityLabel={`Less on ${DAY_NAMES[dow]}`}
                    >
                      <Feather name="minus" size={14} color={C.foreground} />
                    </TouchableOpacity>
                    <Text style={[s.amount, { color: C.accentText }]}>+{d.kcal}</Text>
                    <TouchableOpacity
                      onPress={() => step(dow, 1)}
                      disabled={d.kcal >= FUEL_MAX}
                      style={[s.stepBtn, { backgroundColor: C.muted, opacity: d.kcal >= FUEL_MAX ? 0.4 : 1 }]}
                      accessibilityLabel={`More on ${DAY_NAMES[dow]}`}
                    >
                      <Feather name="plus" size={14} color={C.foreground} />
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              );
            })}

            <View style={[s.summary, { borderColor: C.borderSubtle }]}>
              <Text style={[s.summaryTxt, { color: C.mutedFg }]}>{summary}</Text>
              {chosen.length > 0 && perDay != null && (
                <Text style={[s.summaryWeek, { color: C.textMuted }]}>
                  {`${fmt(weekKcal(base, chosen))} kcal across the week, ${fmt(perDay)} a day on average.`}
                </Text>
              )}
              {failed && (
                <Text style={[s.summaryTxt, { color: C.dangerText, marginTop: 6 }]}>
                  That did not save. Check your connection and try again.
                </Text>
              )}
            </View>
          </ScrollView>

          <Pressable onPress={onSave} disabled={busy} style={[s.saveBtn, { opacity: busy ? 0.5 : 1 }]}>
            <Text style={s.saveTxt}>{busy ? 'Saving...' : 'Save fuel days'}</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  week: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.md },
  dayPill: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dayPillTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },

  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  dayName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  labelInput: { fontSize: FontSize.sm, paddingVertical: 2, paddingHorizontal: 0 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  stepBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  amount: { minWidth: 44, textAlign: 'center', fontSize: FontSize.base, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'] },

  summary: { paddingTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  summaryTxt: { fontSize: FontSize.sm, lineHeight: 19 },
  summaryWeek: { fontSize: FontSize.xs, marginTop: 6, fontVariant: ['tabular-nums'] },

  saveBtn: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, marginTop: Spacing.lg },
  saveTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold },
});
