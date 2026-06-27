/**
 * Set-type metadata + the colored letter badge (Phase B).
 *
 * SET_TYPE_META is the single source of truth — the logger, the SetTypeSheet, and
 * history all read it. 'normal' renders the plain set number (no badge); every
 * other type renders a compact tinted letter tile (W/D/F/N/L/R).
 */
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Radius, FontWeight, colorWithAlpha } from '@/constants/theme';
import type { SetType } from '@/lib/types';

export interface SetTypeMeta {
  label: string;
  letter: string;
  /** Badge color; empty for 'normal' (renders the number instead). */
  color: string;
  tier: 'common' | 'more';
  /** One-line, coach-voiced explainer (no em dashes). */
  explainer: string;
}

export const SET_TYPE_META: Record<SetType, SetTypeMeta> = {
  normal:   { label: 'Normal',     letter: '',  color: '',                  tier: 'common', explainer: 'Your standard working set. Bring it.' },
  warmup:   { label: 'Warm up',    letter: 'W', color: Colors.paused,       tier: 'common', explainer: 'Priming reps that prep the lift, so they stay out of your volume and PRs.' },
  dropset:  { label: 'Drop set',   letter: 'D', color: Colors.stat.volume,  tier: 'common', explainer: 'Strip the weight and keep going right after you hit failure.' },
  failure:  { label: 'To failure', letter: 'F', color: Colors.danger,       tier: 'common', explainer: 'You pushed until the rep would not move. Nothing left in the tank.' },
  negative: { label: 'Negative',   letter: 'N', color: Colors.warning,      tier: 'more',   explainer: 'Slow the lowering phase and fight the weight all the way down.' },
  left:     { label: 'Left side',  letter: 'L', color: Colors.success,      tier: 'more',   explainer: 'Logged for your left side when you train one limb at a time.' },
  right:    { label: 'Right side', letter: 'R', color: Colors.stat.muscles, tier: 'more',   explainer: 'Logged for your right side when you train one limb at a time.' },
};

/** Stored value list, in display order (common tier first). */
export const SET_TYPE_ORDER: SetType[] = ['normal', 'warmup', 'dropset', 'failure', 'negative', 'left', 'right'];

export function setTypeOf(value: string | null | undefined): SetType {
  return value && value in SET_TYPE_META ? (value as SetType) : 'normal';
}

/**
 * Whether a set occupies a working-set NUMBER. Warm-ups (prep) and drop sets
 * (a continuation of the set before them) don't take a number; everything else
 * does — a failure/negative/left/right set still counts as a working set, it
 * just shows its letter instead of the number.
 */
export function countsAsWorkingSet(value: string | null | undefined): boolean {
  const t = setTypeOf(value);
  return t !== 'warmup' && t !== 'dropset';
}

/**
 * Renders the set's marker: the plain number for 'normal', else a tinted letter
 * tile. `numColor` styles the number (the caller controls done vs active tint).
 */
export function SetTypeBadge({
  type,
  num,
  size = 22,
  numColor,
}: {
  type: SetType;
  /** Working-set number to show for a 'normal' set (already 1-based). */
  num?: number;
  size?: number;
  numColor?: string;
}) {
  const meta = SET_TYPE_META[type] ?? SET_TYPE_META.normal;
  // Normal: the plain working-set number.
  if (!meta.letter) {
    return <Text style={[s.num, numColor ? { color: numColor } : null]}>{num ?? ''}</Text>;
  }
  // Warm-up / drop don't take a number (num is null): just the colored letter tile.
  if (num == null) {
    return (
      <View style={[s.badge, { width: size, height: size, backgroundColor: colorWithAlpha(meta.color, 0.18) }]}>
        <Text style={[s.letter, { color: meta.color }]}>{meta.letter}</Text>
      </View>
    );
  }
  // Counting typed set (failure / negative / left / right): the working number
  // with its colored type letter as a small tag, so you see both.
  return (
    <View style={s.numTag}>
      <Text style={[s.num, numColor ? { color: numColor } : null]}>{num}</Text>
      <Text style={[s.tag, { color: meta.color }]}>{meta.letter}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  num: { fontSize: 13, fontWeight: FontWeight.bold, fontVariant: ['tabular-nums'], textAlign: 'center' },
  badge: { borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  letter: { fontSize: 11, fontWeight: FontWeight.black },
  // number + small colored type letter (counting typed sets)
  numTag: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' },
  tag: { fontSize: 9, fontWeight: FontWeight.black, marginLeft: 1, marginTop: -1 },
});
