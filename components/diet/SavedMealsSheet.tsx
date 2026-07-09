/**
 * SavedMealsSheet — the user's saved meals, one tap to log.
 *
 * Opened from the nutrition header. Each row logs into the current-time meal
 * section (the user can move it afterwards via the entry sheet). A MEAL logs
 * its whole bundle; a RECIPE logs one serving. This is the retention payoff of
 * P3: track the same custom thing daily without re-typing it. Portal sheet.
 */
import { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, TouchableOpacity, ScrollView, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { listSavedMeals, logSavedMeal, deleteSavedMeal, type SavedMeal } from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';
import type { MealType } from '@/lib/foods';

interface Props {
  open: boolean;
  defaultMeal: MealType;      // current-time section to log into
  mealLabel: string;          // e.g. "Lunch", for the button label
  onClose: () => void;
  onLogged: () => void;       // reload the day view
}

const r0 = (n: number) => Math.round(n);

export function SavedMealsSheet({ open, defaultMeal, mealLabel, onClose, onLogged }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const supabase = useSupabaseClient();

  const [meals, setMeals] = useState<SavedMeal[] | null>(null); // null = loading
  const [flash, setFlash] = useState<string | null>(null);      // id just logged
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) { setMeals([]); return; }
    setMeals(await listSavedMeals(supabase));
  }, [supabase]);

  useEffect(() => { if (open) { setMeals(null); setFlash(null); void load(); } }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

  const onLog = async (m: SavedMeal) => {
    if (!supabase || busyId) return;
    setBusyId(m.id);
    haptics.success();
    const { error } = await logSavedMeal(supabase, m, defaultMeal, 1);
    setBusyId(null);
    if (error) { haptics.warning(); return; }
    onLogged();
    setFlash(m.id);
    setTimeout(() => setFlash((f) => (f === m.id ? null : f)), 1600);
  };

  const onDelete = async (m: SavedMeal) => {
    if (!supabase || busyId) return;
    setBusyId(m.id);
    haptics.warning();
    const { error } = await deleteSavedMeal(supabase, m.id);
    setBusyId(null);
    if (error) { haptics.warning(); return; } // don't reload; the row would just reappear
    void load();
  };

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          entering={SlideInDown.duration(320).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(180)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
        >
          <Pressable style={{ flexShrink: 1 }}>
            <View style={[s.handle, { backgroundColor: C.handle }]} />
            <View style={s.header}>
              <View style={{ flex: 1 }}>
                <Text style={[s.title, { color: C.foreground }]}>Saved</Text>
                <Text style={[s.subtitle, { color: C.mutedFg }]}>Tap to log into {mealLabel}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityLabel="Close">
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {meals === null ? (
              <Text style={[s.empty, { color: C.textDim }]}>Loading...</Text>
            ) : meals.length === 0 ? (
              <View style={s.emptyWrap}>
                <Feather name="bookmark" size={22} color={C.textMuted} />
                <Text style={[s.emptyTitle, { color: C.foreground }]}>No saved meals yet</Text>
                <Text style={[s.empty, { color: C.textDim }]}>Log a meal, then tap Save on the card to keep it here for next time.</Text>
              </View>
            ) : (
              <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} showsVerticalScrollIndicator={false}>
                {meals.map((m) => {
                  const logged = flash === m.id;
                  return (
                    <View key={m.id} style={[s.row, { borderColor: C.borderSubtle }]}>
                      <View style={{ flex: 1 }}>
                        <View style={s.nameRow}>
                          <Text style={[s.name, { color: C.foreground }]} numberOfLines={1}>{m.name}</Text>
                          <Text style={[s.kind, { color: C.textMuted, borderColor: C.border }]}>
                            {`${m.items.length} item${m.items.length === 1 ? '' : 's'}`}
                          </Text>
                        </View>
                        <Text style={[s.macros, { color: C.textMuted }]}>
                          {r0(m.kcal)} kcal · {r0(m.protein_g)} g P
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => onDelete(m)} hitSlop={8} style={s.trash} accessibilityLabel="Delete saved meal">
                        <Feather name="trash-2" size={15} color={C.textMuted} />
                      </TouchableOpacity>
                      <Pressable
                        onPress={() => onLog(m)}
                        disabled={!!busyId}
                        style={[s.logBtn, { backgroundColor: logged ? C.macro.protein : Colors.primary }]}
                      >
                        <Feather name={logged ? 'check' : 'plus'} size={15} color={Colors.primaryFg} />
                        <Text style={s.logTxt}>{logged ? 'Added' : 'Log'}</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, maxHeight: '82%' },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  emptyWrap: { alignItems: 'center', gap: 8, paddingVertical: Spacing.xxl },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, marginTop: 4 },
  empty: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 19, paddingHorizontal: Spacing.xl },

  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  kind: { fontSize: 10, fontWeight: FontWeight.medium, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden' },
  macros: { fontSize: FontSize.sm, marginTop: 3, fontVariant: ['tabular-nums'] },

  trash: { padding: 6 },
  logBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 12 },
  logTxt: { fontSize: FontSize.sm, color: Colors.primaryFg, fontWeight: FontWeight.bold },
});
