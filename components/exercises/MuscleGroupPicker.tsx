/**
 * Muscle group picker for the create / edit custom exercise forms.
 *
 * Progressive disclosure. The grid shows only the twelve familiar picks
 * (ten classic groups + Cardio + Other), so a casual user taps "Back" and is
 * done in one tap, exactly like before finer heads existed. Picking a group
 * that HAS finer heads (see MUSCLE_GROUP_REFINEMENTS) reveals one extra row
 * underneath with just that family's heads: Back offers Lats / Upper Back /
 * Lower Back / Traps, Shoulders offers the three delt heads, and so on. The
 * row is optional; ignoring it keeps the plain group. The form never shows
 * all ~22 values at once.
 *
 * Both forms — the exercises screen's edit sheet and the routine picker's
 * custom form — render this, so the vocabulary can never drift between them.
 */
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors, Radius, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import {
  ALL_MUSCLE_GROUPS,
  CUSTOM_MUSCLE_GROUPS,
  MUSCLE_GROUP_REFINEMENTS,
  muscleParentOf,
} from '@/lib/exercises';

interface Props {
  value: string;
  onChange: (group: string) => void;
}

/** Which primary's refine row should be open for this value. */
function familyOf(value: string): string {
  return muscleParentOf(value) ?? value;
}

export function MuscleGroupPicker({ value, onChange }: Props) {
  const { C } = useTheme();

  // The open family survives head-hopping (Triceps -> Forearms keeps the
  // Triceps row open even though Forearms also lives under Biceps).
  const [family, setFamily] = useState(() => familyOf(value));

  // The edit sheet swaps `value` without remounting us (Portal keeps the
  // sheet mounted through its slide-out), so re-derive the family whenever
  // the value stops belonging to the currently open one.
  useEffect(() => {
    setFamily((f) => (value === f || (MUSCLE_GROUP_REFINEMENTS[f] ?? []).includes(value) ? f : familyOf(value)));
  }, [value]);

  // A custom exercise saved with wording we don't offer (older builds, or a
  // coach-created row) keeps its tag on an extra chip instead of losing it.
  const primaries: string[] = ALL_MUSCLE_GROUPS.includes(value)
    ? [...CUSTOM_MUSCLE_GROUPS]
    : [...CUSTOM_MUSCLE_GROUPS, value];

  const heads = MUSCLE_GROUP_REFINEMENTS[family] ?? [];
  const headSelected = heads.includes(value);

  return (
    <View style={styles.wrap}>
      <View style={styles.chipRow}>
        {primaries.map((mg) => {
          const active = value === mg;
          // The parent stays visibly "on" while one of its heads is picked.
          const familyActive = !active && family === mg && headSelected;
          return (
            <TouchableOpacity
              key={mg}
              onPress={() => { setFamily(mg); onChange(mg); }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.chip, {
                backgroundColor: active ? Colors.primary : C.muted,
                borderColor: active || familyActive ? Colors.primary : C.border,
              }]}
            >
              <Text style={[styles.chipText, {
                color: active ? Colors.primaryFg : familyActive ? C.foreground : C.textMuted,
              }]}>
                {mg}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {heads.length > 0 && (
        <View style={[styles.refine, { borderLeftColor: Colors.primary }]}>
          <Text style={[styles.refineLabel, { color: C.textDim }]}>
            DIAL IT IN (OPTIONAL)
          </Text>
          <View style={styles.chipRow}>
            {heads.map((mg) => {
              const active = value === mg;
              // Stored values carry the parent for disambiguation elsewhere
              // ("Triceps Long Head" in the Analytics legend), but inside the
              // parent's own row the prefix is noise: show just "Long Head".
              const label = mg.startsWith(`${family} `) ? mg.slice(family.length + 1) : mg;
              return (
                <TouchableOpacity
                  key={mg}
                  onPress={() => onChange(active ? family : mg)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.chip, {
                    backgroundColor: active ? Colors.primary : C.muted,
                    borderColor: active ? Colors.primary : C.border,
                  }]}
                >
                  <Text style={[styles.chipText, { color: active ? Colors.primaryFg : C.textMuted }]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.full, borderWidth: 1 },
  chipText: { fontSize: 11, fontWeight: FontWeight.semibold },
  refine: { borderLeftWidth: 2, paddingLeft: 12, gap: 6 },
  refineLabel: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1.5 },
});
