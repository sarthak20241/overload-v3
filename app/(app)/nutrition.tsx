/**
 * Nutrition day view — the diet "diary" + journal in one screen.
 *
 * Structure = MyFitnessPal meal sections (Breakfast / Lunch / Dinner / Snacks),
 * each with its entries + subtotal, under a co-equal calories + protein summary
 * (MacroRing). Logging = the inline "Tell Drona what you ate" input at the bottom
 * (Journable model): you type/speak plain words, the entry resolves in place, and
 * tapping an entry shows Drona's read. Calm/mature system: Inter (system fallback
 * for now), tabular figures, Colors.macro register, lime reserved for the action.
 *
 * v1 renders with sample data so the layout is verifiable on-device; the Supabase
 * day-load + the NL parse (Drona edge fn) wire in next.
 */
import React, { useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import {
  Colors, Spacing, Radius, FontSize, FontWeight, LetterSpacing,
} from '@/constants/theme';
import { MacroRing } from '@/components/ui/MacroRing';

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
interface Entry { raw?: string; name: string; serving: string; kcal: number; protein: number; carb: number; fat: number; analysing?: boolean }
interface MealDef { type: MealType; label: string; icon: keyof typeof Feather.glyphMap }

const MEALS: MealDef[] = [
  { type: 'breakfast', label: 'Breakfast', icon: 'sunrise' },
  { type: 'lunch', label: 'Lunch', icon: 'sun' },
  { type: 'dinner', label: 'Dinner', icon: 'sunset' },
  { type: 'snack', label: 'Snacks', icon: 'coffee' },
];

// Sample data (v1). Replaced by today's meal_entries from Supabase next.
const TARGETS = { kcal: 2000, protein: 125, carb: 250, fat: 56 };
const SAMPLE: Record<MealType, Entry[]> = {
  breakfast: [
    { raw: 'bowl of oats', name: 'Oats', serving: '1 bowl · 40 g', kcal: 152, protein: 5, carb: 27, fat: 3 },
    { raw: '1 scoop whey', name: 'Whey Protein', serving: '1 scoop · 32 g', kcal: 120, protein: 24, carb: 3, fat: 1 },
  ],
  lunch: [
    { raw: 'masoor dal 0.5 katori', name: 'Masoor Dal', serving: '0.5 katori · 75 g', kcal: 87, protein: 6, carb: 15, fat: 0 },
    { raw: '2 medium roti', name: 'Roti', serving: '2 medium', kcal: 220, protein: 6, carb: 46, fat: 2 },
    { name: '1 boiled egg and a banana', serving: '', kcal: 0, protein: 0, carb: 0, fat: 0, analysing: true },
  ],
  dinner: [],
  snack: [],
};

const round = (n: number) => Math.round(n);

export default function NutritionScreen() {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<TextInput>(null);

  const eaten = MEALS.reduce(
    (acc, m) => {
      for (const e of SAMPLE[m.type]) {
        if (e.analysing) continue;
        acc.kcal += e.kcal; acc.protein += e.protein; acc.carb += e.carb; acc.fat += e.fat;
      }
      return acc;
    },
    { kcal: 0, protein: 0, carb: 0, fat: 0 },
  );
  const remaining = Math.max(TARGETS.kcal - eaten.kcal, 0);

  const s = makeStyles(C);

  return (
    <View style={[s.root, { backgroundColor: C.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + Spacing.sm, paddingBottom: 150 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={s.header}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
            <Feather name="chevron-left" size={22} color={C.foreground} />
          </Pressable>
          <Text style={s.title}>Today</Text>
          <View style={s.streak}>
            <Feather name="zap" size={12} color={Colors.macro.protein} />
            <Text style={s.streakTxt}>3</Text>
          </View>
        </View>

        {/* Summary */}
        <View style={s.summary}>
          <View style={s.rings}>
            <MacroRing value={eaten.kcal} target={TARGETS.kcal} color={C.foreground} label="Calories" size={78} thickness={6} />
            <MacroRing value={eaten.protein} target={TARGETS.protein} color={Colors.macro.protein} label="Protein" unit="g" size={78} thickness={6} />
            <View style={s.bars}>
              <MacroBar label="Carbs" value={eaten.carb} target={TARGETS.carb} color={Colors.macro.carbs} C={C} />
              <MacroBar label="Fat" value={eaten.fat} target={TARGETS.fat} color={Colors.macro.fat} C={C} />
              <View style={s.remaining}>
                <Text style={s.remainNum}>{remaining.toLocaleString()}</Text>
                <Text style={s.remainLbl}>kcal left</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Drona line */}
        <View style={s.drona}>
          <View style={s.avatar}><Feather name="zap" size={11} color={C.accentText} /></View>
          <Text style={s.dronaTxt}>Good start. Get one more protein hit in at lunch and you're on pace.</Text>
        </View>

        {/* Meal sections */}
        {MEALS.map((m) => {
          const entries = SAMPLE[m.type];
          const sub = entries.reduce((a, e) => (e.analysing ? a : { kcal: a.kcal + e.kcal, protein: a.protein + e.protein }), { kcal: 0, protein: 0 });
          return (
            <View key={m.type} style={s.section}>
              <View style={s.sectionHead}>
                <Feather name={m.icon} size={13} color={C.textDim} />
                <Text style={s.sectionLabel}>{m.label}</Text>
                <View style={{ flex: 1 }} />
                {entries.length > 0 && (
                  <Text style={s.sectionSub}>{round(sub.protein)}g P · {round(sub.kcal)}</Text>
                )}
              </View>

              {entries.map((e, i) => (
                <Pressable key={i} style={s.entry} onPress={() => {}}>
                  {e.raw ? <Text style={s.raw}>{e.raw}</Text> : null}
                  {e.analysing ? (
                    <View style={s.analysing}>
                      <Text style={s.entryName}>{e.name}</Text>
                      <Text style={s.analysingTxt}>  Drona's reading it<Text style={{ color: Colors.macro.protein }}>…</Text></Text>
                    </View>
                  ) : (
                    <>
                      <Text style={s.entryName}>{e.name} <Text style={s.serving}>· {e.serving}</Text></Text>
                      <View style={s.macros}>
                        <Text style={[s.macroNum, { color: C.foreground }]}>{round(e.kcal)}</Text>
                        <Text style={[s.macroNum, { color: Colors.macro.protein }]}>{round(e.protein)}g P</Text>
                        <Text style={[s.macroNum, { color: Colors.macro.carbs }]}>{round(e.carb)} C</Text>
                        <Text style={[s.macroNum, { color: Colors.macro.fat }]}>{round(e.fat)} F</Text>
                      </View>
                    </>
                  )}
                </Pressable>
              ))}

              <Pressable style={s.add} hitSlop={8} onPress={() => inputRef.current?.focus()}>
                <Feather name="plus" size={14} color={C.accentText} />
                <Text style={s.addTxt}>Add to {m.label.toLowerCase()}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {/* Inline "tell Drona" logging input */}
      <View style={[s.inputWrap, { paddingBottom: insets.bottom + 12 }]}>
        <View style={s.input}>
          <TextInput
            ref={inputRef}
            value={draft}
            onChangeText={setDraft}
            placeholder="Tell Drona what you ate"
            placeholderTextColor={C.textDim}
            style={s.inputText}
          />
          <Feather name="camera" size={16} color={C.textSecondary} style={{ marginHorizontal: 4 }} />
          <Feather name="mic" size={16} color={C.textSecondary} />
        </View>
      </View>
    </View>
  );
}

function MacroBar({ label, value, target, color, C }: { label: string; value: number; target: number; color: string; C: ReturnType<typeof useTheme>['C'] }) {
  const pct = target > 0 ? Math.min(value / target, 1) : 0;
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 10, color: C.textMuted }}>{label}</Text>
        <Text style={{ fontSize: 10, color: C.textMuted, fontVariant: ['tabular-nums'] }}>{round(value)} / {target}</Text>
      </View>
      <View style={{ height: 4, backgroundColor: C.muted, borderRadius: 2 }}>
        <View style={{ width: `${pct * 100}%`, height: 4, backgroundColor: color, borderRadius: 2 }} />
      </View>
    </View>
  );
}

function makeStyles(C: ReturnType<typeof useTheme>['C']) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.xl, height: 44 },
    back: { width: 32, height: 32, justifyContent: 'center', marginLeft: -8 },
    title: { fontSize: FontSize.xl, fontWeight: FontWeight.black, letterSpacing: LetterSpacing.tight, color: C.foreground },
    streak: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto' },
    streakTxt: { fontSize: FontSize.sm, color: C.textSecondary, fontVariant: ['tabular-nums'], fontWeight: FontWeight.semibold },

    summary: { marginHorizontal: Spacing.xl, marginTop: Spacing.sm, backgroundColor: C.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: C.borderSubtle, padding: Spacing.lg },
    rings: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
    bars: { flex: 1, gap: Spacing.sm, paddingLeft: Spacing.xs },
    remaining: { flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 2 },
    remainNum: { fontSize: FontSize.lg, fontWeight: FontWeight.black, color: C.foreground, fontVariant: ['tabular-nums'], letterSpacing: LetterSpacing.tight },
    remainLbl: { fontSize: 10, color: C.textMuted },

    drona: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: Spacing.xl, marginTop: Spacing.md },
    avatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.primarySubtle, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    dronaTxt: { flex: 1, fontSize: FontSize.sm, lineHeight: 18, color: C.textSecondary },

    section: { marginTop: Spacing.xl, paddingHorizontal: Spacing.xl },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.xs },
    sectionLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, textTransform: 'uppercase', color: C.textDim },
    sectionSub: { fontSize: 11, color: C.textMuted, fontVariant: ['tabular-nums'] },

    entry: { backgroundColor: C.card, borderRadius: Radius.md, borderWidth: 1, borderColor: C.borderSubtle, padding: Spacing.md, marginTop: Spacing.sm },
    raw: { fontSize: 10, color: C.textDim, marginBottom: 1 },
    entryName: { fontSize: FontSize.base, fontWeight: FontWeight.medium, color: C.foreground },
    serving: { fontSize: FontSize.sm, color: C.textMuted, fontWeight: FontWeight.regular },
    macros: { flexDirection: 'row', gap: Spacing.md, marginTop: 6 },
    macroNum: { fontSize: 11, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
    analysing: { flexDirection: 'row', alignItems: 'center' },
    analysingTxt: { fontSize: FontSize.sm, color: C.textSecondary },

    add: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: Spacing.sm, paddingLeft: 2 },
    addTxt: { fontSize: FontSize.sm, color: C.accentText, fontWeight: FontWeight.medium },

    inputWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, backgroundColor: C.background },
    input: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, paddingVertical: 10 },
    inputText: { flex: 1, fontSize: FontSize.base, color: C.foreground, padding: 0 },
  });
}
