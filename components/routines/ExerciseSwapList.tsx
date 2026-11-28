/**
 * The swap list for one exercise, shown inside the session preview sheet in
 * place of the exercise list (a sub-screen with a back arrow, so no second
 * sheet sits on the first).
 *
 * Ranked by lib/exerciseSwaps: the exact muscle the plan chose first. Each
 * tier shows its best few rows; "Show more" opens the rest of that tier.
 */
import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { rankSwaps, type SwapExercise, type SwapOption, type SwapTier } from '@/lib/exerciseSwaps';
import { COMMON_EXERCISE_NAMES, type SwapCatalogRow } from '@/hooks/useSwapCatalog';

const TIER_LABEL: Record<SwapTier, string> = {
  exact: 'Best match',
  muscle: 'Same muscle',
  movement: 'Similar move',
  group: 'Same area',
};

/** How many rows a tier shows before "Show more". */
const TIER_PREVIEW = 5;

const PATTERN_LABEL: Record<string, string> = {
  horizontal_press: 'press', vertical_press: 'overhead press', dip: 'dip', fly: 'fly',
  vertical_pull: 'pulldown', horizontal_pull: 'row', pullover: 'pullover', shrug: 'shrug',
  upright_row: 'upright row', reverse_fly: 'reverse fly', raise: 'raise', curl: 'curl',
  elbow_extension: 'extension', wrist: 'wrist work', hold: 'hold', carry: 'carry',
  squat: 'squat', lunge: 'lunge', hinge: 'hinge', hip_thrust: 'hip thrust',
  back_extension: 'back extension', leg_extension: 'leg extension', leg_curl: 'leg curl',
  hip_abduction: 'abduction', hip_adduction: 'adduction', hip_kickback: 'kickback',
  calf_raise: 'calf raise', crunch: 'crunch', leg_raise: 'leg raise', rotation: 'rotation',
  plank: 'plank', rollout: 'rollout', neck: 'neck work', olympic: 'olympic lift',
  jump: 'jump', throw: 'throw', cardio: 'cardio', mobility: 'mobility',
};

/** "Upper Chest · press": what the exercise is picked for. */
function describe(e: SwapExercise): string {
  const muscle = (e.target_muscle || e.muscle_group || '').trim();
  const move = PATTERN_LABEL[(e.swap_pattern ?? '').trim()] ?? '';
  return [muscle, move].filter(Boolean).join(' · ');
}

interface Props {
  /** The exercise in the slot now, with its tags where known. */
  from: SwapExercise;
  /** The slot's planned exercise, when another one is in it now: offered at the top to go back. */
  original?: SwapExercise | null;
  exercises: SwapCatalogRow[];
  doneIds: ReadonlySet<string>;
  /** The session's other exercises: never offered twice. */
  excludeIds: ReadonlySet<string>;
  onPick: (row: SwapCatalogRow, tier: SwapTier) => void;
  onRestore?: () => void;
  onBack: () => void;
  /** How long the swap lasts, under the title. Today: this session only. */
  scopeNote?: string;
  /** The back arrow's spoken name. */
  backLabel?: string;
  /** What to say when nothing is close. */
  emptyNote?: string;
}

export function ExerciseSwapList({
  from, original, exercises, doneIds, excludeIds, onPick, onRestore, onBack,
  scopeNote = 'For this session only.', backLabel = 'Back to the session',
  emptyNote = 'No close match for this one. Keep it, or change the routine in the Routines tab.',
}: Props) {
  const { C } = useTheme();
  const [open, setOpen] = useState<Partial<Record<SwapTier, boolean>>>({});

  const tiers = useMemo(() => {
    const ranked = rankSwaps({ from, exercises, doneIds, excludeIds, commonNames: COMMON_EXERCISE_NAMES });
    const by = new Map<SwapTier, SwapOption<SwapCatalogRow>[]>();
    for (const o of ranked) {
      if (original && o.exercise.id === original.id) continue; // offered as "Back to" above
      (by.get(o.tier) ?? by.set(o.tier, []).get(o.tier)!).push(o);
    }
    return (['exact', 'muscle', 'movement', 'group'] as SwapTier[])
      .map((tier) => ({ tier, options: by.get(tier) ?? [] }))
      .filter((t) => t.options.length > 0);
  }, [from, original, exercises, doneIds, excludeIds]);

  const label = describe(from);

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={[s.backBtn, { backgroundColor: C.closeBtn }]} hitSlop={8} accessibilityLabel={backLabel}>
          <Feather name="chevron-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: C.foreground }]} numberOfLines={1}>Swap {from.name}</Text>
          <Text style={[s.subtitle, { color: C.mutedFg }]} numberOfLines={1}>
            {label ? `${label}. ${scopeNote}` : scopeNote}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flexShrink: 1, flexGrow: 1 }}
        contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md }}
        showsVerticalScrollIndicator
      >
        {original && onRestore ? (
          <TouchableOpacity
            onPress={onRestore}
            style={[s.restoreRow, { borderColor: C.border, backgroundColor: C.muted }]}
            activeOpacity={0.8}
          >
            <Feather name="rotate-ccw" size={13} color={C.accentText} />
            <Text style={[s.restoreText, { color: C.foreground }]} numberOfLines={1}>
              Back to {original.name}
            </Text>
          </TouchableOpacity>
        ) : null}

        {tiers.length === 0 ? (
          <Text style={[s.empty, { color: C.mutedFg }]}>
            {emptyNote}
          </Text>
        ) : null}

        {tiers.map(({ tier, options }) => {
          const shown = open[tier] ? options : options.slice(0, TIER_PREVIEW);
          const more = options.length - shown.length;
          return (
            <View key={tier} style={s.tier}>
              <Text style={[s.tierLabel, { color: C.textMuted }]}>{TIER_LABEL[tier].toUpperCase()}</Text>
              {shown.map((o) => (
                <TouchableOpacity
                  key={o.exercise.id}
                  onPress={() => onPick(o.exercise, tier)}
                  style={[s.row, { borderBottomColor: C.borderSubtle }]}
                  activeOpacity={0.7}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[s.rowName, { color: C.foreground }]} numberOfLines={1}>{o.exercise.name}</Text>
                    <Text style={[s.rowMeta, { color: C.textMuted }]} numberOfLines={1}>
                      {[describe(o.exercise), o.exercise.category && o.exercise.category !== 'Other' && o.exercise.category !== 'Custom' ? o.exercise.category : '']
                        .filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  {o.done ? (
                    <View style={[s.doneChip, { backgroundColor: C.primaryMuted }]}>
                      <Text style={[s.doneChipText, { color: C.accentText }]}>Done before</Text>
                    </View>
                  ) : null}
                  <Feather name="shuffle" size={13} color={C.textMuted} />
                </TouchableOpacity>
              ))}
              {more > 0 ? (
                <TouchableOpacity onPress={() => setOpen((p) => ({ ...p, [tier]: true }))} style={s.moreBtn} hitSlop={6}>
                  <Text style={[s.moreText, { color: C.accentText }]}>Show {more} more</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.md,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  restoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderRadius: Radius.lg,
    borderWidth: 1,
    marginBottom: Spacing.sm,
  },
  restoreText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  empty: {
    fontSize: FontSize.sm,
    lineHeight: 19,
    paddingVertical: Spacing.lg,
  },
  tier: {
    marginTop: Spacing.sm,
  },
  tierLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: 1,
  },
  rowName: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  rowMeta: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  doneChip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  doneChipText: {
    fontSize: 10,
    fontWeight: FontWeight.semibold,
  },
  moreBtn: {
    paddingVertical: 10,
  },
  moreText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
