/**
 * SaveMealSheet — turn a parsed meal into a reusable saved meal (a named bundle
 * of foods you re-log whole in one tap).
 *
 * Opened from the parse review card ("Save"). AI-native: the items come straight
 * from what Drona already parsed, so there's no ingredient-by-ingredient form.
 * Portal sheet, matching the other diet sheets.
 */
import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { createSavedMeal, type ParsedMealItem } from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';

interface Props {
  open: boolean;
  items: ParsedMealItem[];
  onClose: () => void;
  onSaved: () => void;
}

const r0 = (n: number) => Math.round(n);

export function SaveMealSheet({ open, items, onClose, onSaved }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const supabase = useSupabaseClient();

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      // Prefill a sensible name so saving needs no typing: a single item uses
      // its own name; a bundle defaults to "My meal".
      setName(items.length === 1 ? items[0].food_name : 'My meal');
      setBusy(false);
    }
  }, [open, items]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return <Portal>{null}</Portal>;

  const total = items.reduce(
    (a, it) => ({ kcal: a.kcal + it.kcal, p: a.p + it.protein_g }),
    { kcal: 0, p: 0 },
  );

  const onSave = async () => {
    const trimmed = name.trim();
    if (!supabase || busy) { onClose(); return; }
    if (!trimmed) { haptics.warning(); return; } // don't persist a blank-named meal
    setBusy(true);
    haptics.selection();
    const { error } = await createSavedMeal(supabase, {
      name: trimmed,
      kind: 'meal',
      servings: 1,
      serving_label: null,
      items,
    });
    setBusy(false);
    if (error) { haptics.warning(); return; }
    onSaved();
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
                <Text style={[s.title, { color: C.foreground }]}>Save for next time</Text>
                <Text style={[s.subtitle, { color: C.mutedFg }]}>Re-log it in one tap later</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityLabel="Close">
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {/* Name */}
            <View style={[s.field, { borderColor: C.borderSubtle }]}>
              <Text style={[s.fieldLabel, { color: C.textSecondary }]}>Name</Text>
              <TextInput
                style={[s.nameInput, { color: C.foreground, backgroundColor: C.muted }]}
                value={name}
                onChangeText={setName}
                placeholder="My meal"
                placeholderTextColor={C.textDim}
                maxLength={60}
                returnKeyType="done"
                accessibilityLabel="Name"
              />
            </View>

            <Text style={[s.summary, { color: C.textMuted }]}>
              {`${r0(total.kcal)} kcal · ${r0(total.p)} g protein · ${items.length} item${items.length === 1 ? '' : 's'}`}
            </Text>

            <Pressable onPress={onSave} disabled={busy} style={[s.saveBtn, { opacity: busy ? 0.5 : 1 }]}>
              <Feather name="bookmark" size={15} color={Colors.primaryFg} />
              <Text style={s.saveTxt}>{busy ? 'Saving...' : 'Save meal'}</Text>
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
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  field: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  fieldLabel: { fontSize: FontSize.base, fontWeight: FontWeight.medium, width: 56 },
  nameInput: { flex: 1, borderRadius: Radius.sm, paddingVertical: 9, paddingHorizontal: 12, fontSize: FontSize.base, fontWeight: FontWeight.medium },

  summary: { fontSize: FontSize.sm, marginTop: Spacing.md, fontVariant: ['tabular-nums'] },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 14, marginTop: Spacing.lg },
  saveTxt: { fontSize: FontSize.base, color: Colors.primaryFg, fontWeight: FontWeight.bold },
});
