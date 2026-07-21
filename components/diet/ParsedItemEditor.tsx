/**
 * Edit one line of a parsed meal BEFORE it is logged.
 *
 * The parser is good but not psychic: it may read "a samosa" as the 100 g
 * regular when you ate the 65 g medium, or land on a near-miss food. Rather
 * than force a discard-and-retype, this sheet fixes the line in place.
 *
 * Two modes, decided by whether the line resolved to a real food row:
 *   - CATALOG line (food_id set): pick from that food's REAL servings and the
 *     macros recompute from its per-100 basis — the same math the parser used,
 *     so a corrected line stays as trustworthy as a parsed one.
 *   - ESTIMATE/web line (food_id null): no serving list exists, so the user
 *     edits the amount and macros directly.
 * Macro fields are always editable; touching one stops the auto-derive so the
 * user's numbers are never silently overwritten, and marks the line 'manual'
 * (migration 0084) so the card stops calling it "Drona's estimate".
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, Modal, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { loadFoodForEdit, type ParsedMealItem, type Per100Macros } from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';
import type { FoodServing } from '@/lib/foods';

interface Props {
  item: ParsedMealItem | null;   // null = closed
  onCancel: () => void;
  onSave: (patch: ParsedMealItem) => void;
}

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const numOr = (s: string, fallback: number) => {
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function ParsedItemEditor({ item, onCancel, onSave }: Props) {
  const { C } = useTheme();
  const s = makeStyles(C);
  const supabase = useSupabaseClient();

  const [servings, setServings] = useState<FoodServing[]>([]);
  const [per100, setPer100] = useState<Per100Macros | null>(null);
  const [label, setLabel] = useState('');
  const [qty, setQty] = useState('1');
  const [grams, setGrams] = useState('0');
  const [kcal, setKcal] = useState('0');
  const [protein, setProtein] = useState('0');
  const [carb, setCarb] = useState('0');
  const [fat, setFat] = useState('0');
  // Once the user types in a macro field we stop auto-deriving macros.
  const [macrosTouched, setMacrosTouched] = useState(false);

  // Seed from the item each time the sheet opens, then load the food's real
  // servings + per-100 basis (only for catalog-backed lines).
  useEffect(() => {
    if (!item) return;
    setLabel(item.serving_label);
    setQty(String(item.quantity));
    setGrams(String(r1(item.grams)));
    setKcal(String(r0(item.kcal)));
    setProtein(String(r1(item.protein_g)));
    setCarb(String(r1(item.carb_g)));
    setFat(String(r1(item.fat_g)));
    setMacrosTouched(false);
    setServings([]);
    setPer100(null);
    let alive = true;
    void loadFoodForEdit(supabase, item.food_id).then((res) => {
      if (!alive || !res) return;
      setServings(res.servings);
      setPer100(res.per100);
    });
    return () => { alive = false; };
  }, [item, supabase]);

  const qtyNum = useMemo(() => numOr(qty, 1), [qty]);
  const gramsNum = useMemo(() => numOr(grams, 0), [grams]);

  function deriveMacros(g: number, basis: Per100Macros | null) {
    if (!basis) return;
    const f = g / 100;
    setKcal(String(r0(basis.kcal * f)));
    setProtein(String(r1(basis.protein_g * f)));
    setCarb(String(r1(basis.carb_g * f)));
    setFat(String(r1(basis.fat_g * f)));
  }

  /** Pick a serving: grams follow from serving × quantity, macros follow the
   *  per-100 basis unless the user has taken the macros over. */
  function applyServing(sv: FoodServing) {
    setLabel(sv.label);
    const g = sv.grams * qtyNum;
    setGrams(String(r1(g)));
    if (!macrosTouched) deriveMacros(g, per100);
  }

  function onQtyChange(next: string) {
    const prevQty = qtyNum;
    setQty(next);
    const nextQty = numOr(next, 1);
    const sv = servings.find((x) => x.label === label);
    if (sv) {
      const g = sv.grams * nextQty;
      setGrams(String(r1(g)));
      if (!macrosTouched) deriveMacros(g, per100);
      return;
    }
    // No serving rows behind this line (estimate and web items have no catalog
    // food to load them from), so scale what is already on screen instead of
    // doing nothing. Without this the field accepted input and moved only the
    // displayed count: "1 samosa" edited to 3 saved as "3 x samosa" carrying
    // one samosa's grams and macros.
    if (!(prevQty > 0) || !(nextQty > 0)) return;
    const ratio = nextQty / prevQty;
    setGrams(String(r1(gramsNum * ratio)));
    if (macrosTouched) return;
    setKcal(String(r0(numOr(kcal, 0) * ratio)));
    setProtein(String(r1(numOr(protein, 0) * ratio)));
    setCarb(String(r1(numOr(carb, 0) * ratio)));
    setFat(String(r1(numOr(fat, 0) * ratio)));
  }

  function onGramsChange(next: string) {
    setGrams(next);
    if (!macrosTouched) deriveMacros(numOr(next, 0), per100);
  }

  const touch = (setter: (v: string) => void) => (v: string) => {
    setMacrosTouched(true);
    setter(v);
  };

  function save() {
    if (!item) return;
    const changed =
      macrosTouched ||
      label !== item.serving_label ||
      qtyNum !== item.quantity ||
      Math.abs(gramsNum - item.grams) > 0.5;
    onSave({
      ...item,
      quantity: qtyNum || 1,
      serving_label: label || item.serving_label,
      grams: gramsNum,
      kcal: numOr(kcal, 0),
      protein_g: numOr(protein, 0),
      carb_g: numOr(carb, 0),
      fat_g: numOr(fat, 0),
      // A corrected line carries the user's numbers, not the parser's.
      source: changed ? 'manual' : item.source,
      confidence: changed ? 'high' : item.confidence,
      assumption: changed ? null : item.assumption,
    });
  }

  return (
    <Modal visible={!!item} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={s.backdrop} onPress={onCancel} accessibilityLabel="Close editor" />
      <View style={s.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={s.title} numberOfLines={1}>{item?.food_name ?? ''}</Text>

          {servings.length > 0 && (
            <>
              <Text style={s.eyebrow}>Serving</Text>
              <View style={s.chipWrap}>
                {servings.map((sv) => {
                  const on = sv.label === label;
                  return (
                    <Pressable
                      key={sv.label}
                      onPress={() => applyServing(sv)}
                      hitSlop={4}
                      style={[s.chip, on ? s.chipOn : s.chipOff]}
                      accessibilityLabel={`Serving ${sv.label}, ${r0(sv.grams)} grams`}
                    >
                      <Text style={[s.chipTxt, { color: on ? C.background : C.textSecondary }]}>
                        {sv.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          <View style={s.row}>
            <View style={s.field}>
              <Text style={s.eyebrow}>Quantity</Text>
              <TextInput
                value={qty} onChangeText={onQtyChange} keyboardType="decimal-pad"
                style={s.input} placeholderTextColor={C.textDim} accessibilityLabel="Quantity"
              />
            </View>
            <View style={s.field}>
              <Text style={s.eyebrow}>Amount</Text>
              <TextInput
                value={grams} onChangeText={onGramsChange} keyboardType="decimal-pad"
                style={s.input} placeholderTextColor={C.textDim} accessibilityLabel="Amount in grams or ml"
              />
            </View>
          </View>

          <Text style={[s.eyebrow, { marginTop: Spacing.sm }]}>
            {!macrosTouched && per100 ? 'Macros, auto from serving' : 'Macros'}
          </Text>
          <View style={s.row}>
            <View style={s.field}>
              <Text style={s.macroLbl}>Calories</Text>
              <TextInput value={kcal} onChangeText={touch(setKcal)} keyboardType="decimal-pad" style={s.input} accessibilityLabel="Calories" />
            </View>
            <View style={s.field}>
              <Text style={[s.macroLbl, { color: C.macro.protein }]}>Protein g</Text>
              <TextInput value={protein} onChangeText={touch(setProtein)} keyboardType="decimal-pad" style={s.input} accessibilityLabel="Protein grams" />
            </View>
          </View>
          <View style={s.row}>
            <View style={s.field}>
              <Text style={[s.macroLbl, { color: C.macro.carbs }]}>Carbs g</Text>
              <TextInput value={carb} onChangeText={touch(setCarb)} keyboardType="decimal-pad" style={s.input} accessibilityLabel="Carb grams" />
            </View>
            <View style={s.field}>
              <Text style={[s.macroLbl, { color: C.macro.fat }]}>Fat g</Text>
              <TextInput value={fat} onChangeText={touch(setFat)} keyboardType="decimal-pad" style={s.input} accessibilityLabel="Fat grams" />
            </View>
          </View>

          <View style={s.actions}>
            <Pressable onPress={onCancel} style={s.cancel} hitSlop={8}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </Pressable>
            <Pressable onPress={save} style={s.saveBtn} hitSlop={8}>
              <Text style={s.saveTxt}>Save</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
    sheet: {
      backgroundColor: C.card, borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg,
      borderTopWidth: 1, borderColor: C.borderSubtle,
      padding: Spacing.lg, paddingBottom: Spacing.xl, maxHeight: '80%',
    },
    title: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, color: C.foreground, marginBottom: Spacing.md },
    eyebrow: {
      fontSize: 10, color: C.textMuted, fontWeight: FontWeight.medium,
      letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', marginBottom: 6,
    },
    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: Spacing.md },
    chip: { paddingHorizontal: Spacing.md, paddingVertical: 7, borderRadius: Radius.md, borderWidth: 1 },
    chipOn: { backgroundColor: C.accentText, borderColor: C.accentText },
    chipOff: { backgroundColor: 'transparent', borderColor: C.border },
    chipTxt: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
    row: { flexDirection: 'row', gap: Spacing.md },
    field: { flex: 1, marginBottom: Spacing.sm },
    macroLbl: { fontSize: FontSize.sm, color: C.textSecondary, marginBottom: 6 },
    input: {
      borderWidth: 1, borderColor: C.border, borderRadius: Radius.md,
      paddingHorizontal: Spacing.md, paddingVertical: 9,
      color: C.foreground, fontSize: FontSize.base, fontVariant: ['tabular-nums'],
    },
    actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: Spacing.md, marginTop: Spacing.md },
    cancel: { paddingVertical: 8, paddingHorizontal: 12 },
    cancelTxt: { fontSize: FontSize.base, color: C.textSecondary, fontWeight: FontWeight.medium },
    saveBtn: { backgroundColor: C.accentText, borderRadius: Radius.md, paddingVertical: 11, paddingHorizontal: Spacing.xl },
    saveTxt: { fontSize: FontSize.base, color: C.background, fontWeight: FontWeight.semibold },
  });
}
