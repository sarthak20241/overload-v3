/**
 * Edit a food line before or after it is logged.
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
 *     edits the serving and macros directly.
 * The portion reads as serving SIZE + UNIT, eaten QUANTITY times (100 g x 1.5,
 * 1 slice x 2), with the total spelled out under it. It used to be "Quantity"
 * beside "Amount", and on a gram line both boxes said 15.
 * Macro fields are always editable; touching one stops the auto-derive so the
 * user's numbers are never silently overwritten, and marks the line 'manual'
 * (migration 0084) so the card stops calling it "Drona's estimate".
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, TextInput, ScrollView, Modal, StyleSheet,
  Keyboard, Platform, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { loadFoodForEdit, macroKcal, type ParsedMealItem, type Per100Macros } from '@/lib/dietData';
import { haptics } from '@/lib/haptics';
import { useSupabaseClient } from '@/lib/supabase';
import type { FoodServing, MealType } from '@/lib/foods';
import { isMassUnit, isMeasurementUnit, massToGrams } from '@/lib/units';
import { joinServing, splitServing, sizeForUnitChange } from '@/lib/servingSize';

const MEAL_OPTIONS: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snacks' },
];

interface Props {
  item: ParsedMealItem | null;   // null = closed
  onCancel: () => void;
  onSave: (patch: ParsedMealItem) => void;
  busy?: boolean;
  error?: string | null;
  onDelete?: () => void;
  /** Saved entries scale their logged snapshot, including manual corrections. */
  preserveSnapshot?: boolean;
}

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const numOr = (s: string, fallback: number) => {
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
// Three decimals: a gram amount in kg or lb (130 g = 0.065 kg) must survive.
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** Grams a unit converts to on its own. Only mass and ml/l: a cup of rice is
 *  not 237 g, so every other unit scales from the line's own grams instead. */
function gramsOf(total: number, unit: string): number | null {
  const u = unit.trim().toLowerCase();
  if (isMassUnit(u)) return massToGrams(total, u);
  if (u === 'ml') return total;
  if (u === 'l') return total * 1000;
  return null;
}

/** What the numbers are scaled FROM: the line as it opened, or as a serving
 *  chip or a unit change last left it. Scaling from here, not from the screen,
 *  means clearing a box mid-edit and retyping it never drifts the macros. */
interface Base { total: number; grams: number; kcal: number; protein: number; carb: number; fat: number }

export function ParsedItemEditor({ item, onCancel, onSave, busy = false, error, onDelete, preserveSnapshot = false }: Props) {
  const { C } = useTheme();
  const s = makeStyles(C);
  const supabase = useSupabaseClient();

  const [servings, setServings] = useState<FoodServing[]>([]);
  const [per100, setPer100] = useState<Per100Macros | null>(null);
  const [size, setSize] = useState('1');
  const [unit, setUnit] = useState('');
  const committedUnit = useRef('');
  const [qty, setQty] = useState('1');
  const [grams, setGrams] = useState(0);
  const base = useRef<Base>({ total: 1, grams: 0, kcal: 0, protein: 0, carb: 0, fat: 0 });
  const [kcal, setKcal] = useState('0');
  const [protein, setProtein] = useState('0');
  const [carb, setCarb] = useState('0');
  const [fat, setFat] = useState('0');
  // Once the user types in a macro field we stop auto-deriving macros.
  const [macrosTouched, setMacrosTouched] = useState(false);
  // Which diary section this one line goes to. A full-day message ("eggs for
  // breakfast, dal at lunch") is the only time it differs line to line, and
  // this is where a single line gets re-homed without moving its group.
  const [section, setSection] = useState<MealType>('snack');

  // The sheet lifts itself above the keyboard, as EntryEditSheet does. Without
  // it the number pad covered every field under the meal chips, so the user
  // typed a quantity they could not see.
  const [kbHeight, setKbHeight] = useState(0);
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!item) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [item]);

  // Seed from the item each time the sheet opens, then load the food's real
  // servings + per-100 basis (only for catalog-backed lines).
  useEffect(() => {
    if (!item) return;
    const p = splitServing(item.quantity, item.serving_label, isMeasurementUnit);
    setSize(fmt(p.size));
    setUnit(p.unit);
    committedUnit.current = p.unit;
    setQty(fmt(p.count));
    setGrams(item.grams);
    base.current = {
      total: p.size * p.count, grams: item.grams,
      kcal: item.kcal, protein: item.protein_g, carb: item.carb_g, fat: item.fat_g,
    };
    setKcal(String(r0(item.kcal)));
    setProtein(String(r1(item.protein_g)));
    setCarb(String(r1(item.carb_g)));
    setFat(String(r1(item.fat_g)));
    setMacrosTouched(false);
    setSection(item.meal_type);
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

  const sizeNum = useMemo(() => numOr(size, 0), [size]);
  const qtyNum = useMemo(() => numOr(qty, 0), [qty]);

  // The same advisory cross-check as Quick Add. A label may differ from 4/4/9;
  // the user's calories remain authoritative, even when the numbers disagree.
  const anyMacro = [protein, carb, fat].some((v) => v.trim().length > 0);
  const fromMacros = macroKcal({
    protein: numOr(protein, 0), carb: numOr(carb, 0), fat: numOr(fat, 0),
  });
  const kcalNum = numOr(kcal, 0);
  const mismatch = anyMacro && kcalNum > 0
    && Math.abs(fromMacros - kcalNum) > Math.max(50, kcalNum * 0.2);

  function deriveMacros(g: number, basis: Per100Macros | null) {
    if (!basis) return;
    const f = g / 100;
    setKcal(String(r0(basis.kcal * f)));
    setProtein(String(r1(basis.protein_g * f)));
    setCarb(String(r1(basis.carb_g * f)));
    setFat(String(r1(basis.fat_g * f)));
  }

  /** Size or quantity moved: grams and (unless the user owns them) macros
   *  follow. Before this, estimate lines had no serving rows to recompute
   *  from, and "1 samosa" edited to 3 saved as 3 carrying one samosa's macros. */
  function recompute(nextSize: string, nextQty: string, u = unit) {
    const total = numOr(nextSize, 0) * numOr(nextQty, 0);
    if (!(total > 0)) return;              // a box mid-edit; wait for a number
    const b = base.current;
    const g = gramsOf(total, u) ?? (b.total > 0 ? b.grams * (total / b.total) : b.grams);
    setGrams(g);
    if (macrosTouched) return;
    if (!preserveSnapshot && per100 && g > 0) { deriveMacros(g, per100); return; }
    const ratio = b.grams > 0 && g > 0 ? g / b.grams : (b.total > 0 ? total / b.total : 1);
    setKcal(String(r0(b.kcal * ratio)));
    setProtein(String(r1(b.protein * ratio)));
    setCarb(String(r1(b.carb * ratio)));
    setFat(String(r1(b.fat * ratio)));
  }

  function onSizeChange(next: string) { setSize(next); recompute(next, qty); }
  function onQtyChange(next: string) { setQty(next); recompute(size, next); }

  /** Convert only the completed label. Transient text ("glass" -> "g" -> "")
   * must not change the serving size while the user is deleting or typing. */
  function commitUnit(next = unit): number {
    const nextSize = sizeForUnitChange(sizeNum, qtyNum, grams,
      committedUnit.current, next, u => gramsOf(1, u));
    if (next !== committedUnit.current) {
      committedUnit.current = next;
      if (nextSize !== sizeNum) setSize(fmt(nextSize));
      if (nextSize * qtyNum > 0) base.current = {
        total: nextSize * qtyNum, grams,
        kcal: numOr(kcal, 0), protein: numOr(protein, 0), carb: numOr(carb, 0), fat: numOr(fat, 0),
      };
    }
    return nextSize;
  }

  /** Pick a catalog serving: it sets size + unit and its real grams. */
  function applyServing(sv: FoodServing) {
    const p = splitServing(1, sv.label, isMeasurementUnit);
    setSize(fmt(p.size));
    setUnit(p.unit);
    committedUnit.current = p.unit;
    const count = qtyNum > 0 ? qtyNum : 1;
    if (!(qtyNum > 0)) setQty('1');
    const g = sv.grams * count;
    const ratio = grams > 0 ? g / grams : 1;
    const next = {
      kcal: numOr(kcal, 0), protein: numOr(protein, 0), carb: numOr(carb, 0), fat: numOr(fat, 0),
    };
    if (!macrosTouched) {
      if (preserveSnapshot) {
        next.kcal = r0(next.kcal * ratio);
        next.protein = r1(next.protein * ratio);
        next.carb = r1(next.carb * ratio);
        next.fat = r1(next.fat * ratio);
      } else if (per100) {
        next.kcal = r0(per100.kcal * g / 100);
        next.protein = r1(per100.protein_g * g / 100);
        next.carb = r1(per100.carb_g * g / 100);
        next.fat = r1(per100.fat_g * g / 100);
      }
      setKcal(String(next.kcal)); setProtein(String(next.protein));
      setCarb(String(next.carb)); setFat(String(next.fat));
    }
    setGrams(g);
    base.current = { total: p.size * count, grams: g, ...next };
  }

  const servingOn = (sv: FoodServing) => {
    const p = splitServing(1, sv.label, isMeasurementUnit);
    return p.size === sizeNum && p.unit.toLowerCase() === unit.trim().toLowerCase();
  };

  // "Total 150 g", or "Total 2 slice, about 40 g" when the unit is not grams.
  const totalLine = useMemo(() => {
    const total = sizeNum * qtyNum;
    const u = unit.trim();
    if (!(total > 0) || !u) return '';
    // Mass and ml/l already say their grams; only other units get "about".
    const exact = gramsOf(1, u) !== null;
    const about = !exact && grams > 0 ? `, about ${r0(grams)} g` : '';
    return `Total ${fmt(total)} ${u}${about}`;
  }, [sizeNum, qtyNum, unit, grams]);

  const touch = (setter: (v: string) => void) => (v: string) => {
    setMacrosTouched(true);
    setter(v);
  };

  // An empty or zero box has no amount to save. Save used to fall back to 1
  // and keep the grams of the last real number, so the two disagreed.
  const canSave = !busy && sizeNum > 0 && qtyNum > 0 && unit.trim().length > 0;

  const close = () => { if (!busy) { Keyboard.dismiss(); onCancel(); } };

  function save() {
    if (!item || !canSave) return;
    const finalSize = commitUnit();
    const stored = joinServing(
      { size: finalSize, unit: unit.trim() || 'serving', count: qtyNum },
      item, isMeasurementUnit,
    );
    const changed =
      macrosTouched ||
      stored.serving_label !== item.serving_label ||
      stored.quantity !== item.quantity ||
      Math.abs(grams - item.grams) > 0.5;
    onSave({
      ...item,
      meal_type: section,
      quantity: stored.quantity,
      serving_label: stored.serving_label,
      grams: changed ? r1(grams) : item.grams,
      kcal: changed ? numOr(kcal, 0) : item.kcal,
      protein_g: changed ? numOr(protein, 0) : item.protein_g,
      carb_g: changed ? numOr(carb, 0) : item.carb_g,
      fat_g: changed ? numOr(fat, 0) : item.fat_g,
      // A corrected line carries the user's numbers, not the parser's.
      source: changed ? 'manual' : item.source,
      confidence: changed ? 'high' : item.confidence,
      assumption: changed ? null : item.assumption,
      // And it stops being ours to vouch for. `verified` is a claim that two
      // INDEPENDENT sources agreed on this line's numbers; the moment the user
      // edits them it is a claim about numbers nobody checked. It rode through
      // on the spread above while source, confidence and assumption were all
      // being reset around it - the same stale-field shape that put a Breakfast
      // line into Snacks on the correction path.
      //
      // Cleared on any `changed`, including a pure rescale where the per-100
      // basis really is still the verified one. That slightly under-claims, and
      // it is the right direction: this file already calls a rescale 'manual',
      // so a line marked as the user's own must not also carry our badge.
      verified: changed ? false : item.verified,
    });
  }

  return (
    <Modal visible={!!item} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close} accessibilityLabel="Close editor" />
      <View
        style={[
          s.sheet,
          kbHeight > 0 && {
            marginBottom: kbHeight, paddingBottom: Spacing.md,
            maxHeight: winH - kbHeight - insets.top - Spacing.md,
          },
        ]}
      >
        <ScrollView pointerEvents={busy ? 'none' : 'auto'} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={s.title} numberOfLines={1}>{item?.food_name ?? ''}</Text>

          <Text style={s.eyebrow}>Meal</Text>
          <View style={s.chipWrap}>
            {MEAL_OPTIONS.map((o) => {
              const on = o.value === section;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => setSection(o.value)}
                  hitSlop={4}
                  style={[s.chip, on ? s.chipOn : s.chipOff]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Log to ${o.label}`}
                >
                  <Text style={[s.chipTxt, { color: on ? C.background : C.textSecondary }]}>
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {servings.length > 0 && (
            <>
              <Text style={s.eyebrow}>Pick a serving</Text>
              <View style={s.chipWrap}>
                {servings.map((sv) => {
                  const on = servingOn(sv);
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

          {/* One row: [size | unit] x [quantity]. Size and unit share a box
              because together they are ONE serving ("100 g", "1 slice"). */}
          <View style={s.portionRow}>
            <View style={s.servingCol}>
              <Text style={s.eyebrow}>Serving</Text>
              <View style={s.servingBox}>
                <TextInput
                  value={size} onChangeText={onSizeChange} keyboardType="decimal-pad"
                  style={[s.inlineInput, s.sizeInput]} placeholderTextColor={C.textDim}
                  accessibilityLabel="Serving size"
                />
                <View style={s.servingDivider} />
                <TextInput
                  value={unit} onChangeText={setUnit} onBlur={() => { commitUnit(); }} placeholder="g, slice"
                  autoCapitalize="none" autoCorrect={false}
                  style={[s.inlineInput, s.unitInput]} placeholderTextColor={C.textDim}
                  accessibilityLabel="Serving unit"
                />
              </View>
            </View>
            <Text style={s.times}>×</Text>
            <View style={s.qtyCol}>
              <Text style={s.eyebrow}>Quantity</Text>
              <TextInput
                value={qty} onChangeText={onQtyChange} keyboardType="decimal-pad"
                style={s.input} placeholderTextColor={C.textDim} accessibilityLabel="Number of servings"
              />
            </View>
          </View>
          {!!totalLine && <Text style={s.totalTxt} numberOfLines={1}>{totalLine}</Text>}

          <Text style={[s.eyebrow, { marginTop: Spacing.sm }]}>
            {!preserveSnapshot && !macrosTouched && per100 ? 'Macros, auto from serving' : 'Macros'}
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

        </ScrollView>

        {anyMacro && (
          <View style={s.macroSumRow}>
            <Text selectable accessibilityLiveRegion="polite" style={s.macroSum}>
              {`Those macros come to ${r1(fromMacros)} cal${mismatch ? ` — you entered ${r0(kcalNum)}. Yours is what gets logged.` : '.'}`}
            </Text>
            {kcalNum <= 0 && fromMacros > 0 && (
              <Pressable
                onPress={() => { setMacrosTouched(true); setKcal(String(r0(fromMacros))); haptics.tick(); }}
                disabled={busy} hitSlop={10} accessibilityRole="button" accessibilityLabel="Use calories from macros"
              >
                <Text style={s.macroSumUse}>Use it</Text>
              </Pressable>
            )}
          </View>
        )}

        {error ? <Text accessibilityRole="alert" style={[s.macroSum, { flex: undefined, color: C.dangerText, marginTop: Spacing.sm }]}>{error}</Text> : null}
        <View style={s.actions}>
          {onDelete && <Pressable onPress={onDelete} disabled={busy} hitSlop={8} style={{ marginRight: 'auto' }} accessibilityRole="button" accessibilityLabel="Delete food">
            <Text style={[s.cancelTxt, { color: C.dangerText }]}>Delete</Text>
          </Pressable>}
          <Pressable onPress={close} style={s.cancel} hitSlop={8}>
            <Text style={s.cancelTxt}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={save} disabled={!canSave} hitSlop={8}
            style={[s.saveBtn, !canSave && { opacity: 0.4 }]}
            accessibilityRole="button" accessibilityState={{ disabled: !canSave }}
          >
            <Text style={s.saveTxt}>{busy ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
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
    portionRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm },
    servingCol: { flex: 2 },
    qtyCol: { flex: 1 },
    servingBox: {
      flexDirection: 'row', alignItems: 'center',
      borderWidth: 1, borderColor: C.border, borderRadius: Radius.md,
    },
    inlineInput: {
      paddingHorizontal: Spacing.md, paddingVertical: 9,
      color: C.foreground, fontSize: FontSize.base, fontVariant: ['tabular-nums'],
    },
    sizeInput: { flex: 2 },
    unitInput: { flex: 3 },
    servingDivider: { width: 1, alignSelf: 'stretch', backgroundColor: C.border },
    times: { fontSize: FontSize.base, color: C.textMuted, paddingBottom: 10 },
    totalTxt: {
      fontSize: FontSize.sm, color: C.textSecondary, fontVariant: ['tabular-nums'],
      marginTop: 6, marginBottom: Spacing.sm,
    },
    macroLbl: { fontSize: FontSize.sm, color: C.textSecondary, marginBottom: 6 },
    input: {
      borderWidth: 1, borderColor: C.border, borderRadius: Radius.md,
      paddingHorizontal: Spacing.md, paddingVertical: 9,
      color: C.foreground, fontSize: FontSize.base, fontVariant: ['tabular-nums'],
    },
    macroSumRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.sm },
    macroSum: { flex: 1, fontSize: FontSize.sm, color: C.textMuted, lineHeight: 18, fontVariant: ['tabular-nums'] },
    macroSumUse: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: C.accentText },
    actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: Spacing.md, marginTop: Spacing.md },
    cancel: { paddingVertical: 8, paddingHorizontal: 12 },
    cancelTxt: { fontSize: FontSize.base, color: C.textSecondary, fontWeight: FontWeight.medium },
    saveBtn: { backgroundColor: C.accentText, borderRadius: Radius.md, paddingVertical: 11, paddingHorizontal: Spacing.xl },
    saveTxt: { fontSize: FontSize.base, color: C.background, fontWeight: FontWeight.semibold },
  });
}
