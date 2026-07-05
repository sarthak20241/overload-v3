/**
 * Compact start date/time editor for the Save Workout sheet (Phase B.5).
 *
 * Pure JS — no native datetime-picker dependency (so it works in the current dev
 * client without a rebuild). Lets the user backdate a workout: step the day
 * (never into the future) and nudge the time. Collapsed by default to a single
 * readable line; expands to the steppers on tap.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(d: Date) {
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeLabel(d: Date) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function StartTimeEditor({ value, onChange }: { value: Date; onChange: (d: Date) => void }) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);

  // Clamp so the start never lands in the future (a workout can't start later than now).
  const commit = (d: Date) => {
    const now = new Date();
    onChange(d.getTime() > now.getTime() ? now : d);
  };
  const shiftDay = (delta: number) => {
    const d = new Date(value); d.setDate(d.getDate() + delta);
    if (delta > 0 && d.getTime() > Date.now()) return; // no future days
    haptics.tick(); commit(d);
  };
  const shiftMinutes = (delta: number) => {
    haptics.tick(); commit(new Date(value.getTime() + delta * 60_000));
  };
  const canGoNextDay = (() => { const d = new Date(value); d.setDate(d.getDate() + 1); return d.getTime() <= Date.now(); })();

  return (
    <View>
      <TouchableOpacity
        onPress={() => { haptics.tick(); setOpen((o) => !o); }}
        activeOpacity={0.7}
        style={[s.row, { backgroundColor: C.muted, borderColor: C.border }]}
      >
        <View style={[s.icon, { backgroundColor: C.elevated }]}>
          <Feather name="calendar" size={15} color={C.mutedFg} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.value, { color: C.foreground }]}>{dayLabel(value)} · {timeLabel(value)}</Text>
        </View>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={18} color={C.textMuted} />
      </TouchableOpacity>

      {open && (
        <View style={[s.editor, { borderColor: C.border, backgroundColor: C.muted }]}>
          <Stepper label="Day" display={dayLabel(value)} C={C}
            onDec={() => shiftDay(-1)} onInc={() => shiftDay(1)} incDisabled={!canGoNextDay} />
          <View style={[s.divider, { backgroundColor: C.borderSubtle }]} />
          <Stepper label="Time" display={timeLabel(value)} C={C}
            onDec={() => shiftMinutes(-5)} onInc={() => shiftMinutes(5)} />
        </View>
      )}
    </View>
  );
}

function Stepper({ label, display, onDec, onInc, incDisabled, C }: {
  label: string; display: string; onDec: () => void; onInc: () => void; incDisabled?: boolean; C: any;
}) {
  return (
    <View style={s.stepperRow}>
      <Text style={[s.stepperLabel, { color: C.textMuted }]}>{label}</Text>
      <View style={s.stepperControls}>
        <TouchableOpacity onPress={onDec} style={[s.stepBtn, { backgroundColor: C.elevated }]} hitSlop={6}>
          <Feather name="minus" size={16} color={C.foreground} />
        </TouchableOpacity>
        <Text style={[s.stepperValue, { color: C.foreground }]}>{display}</Text>
        <TouchableOpacity onPress={incDisabled ? undefined : onInc} disabled={incDisabled} style={[s.stepBtn, { backgroundColor: C.elevated, opacity: incDisabled ? 0.4 : 1 }]} hitSlop={6}>
          <Feather name="plus" size={16} color={C.foreground} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: Radius.lg, borderWidth: 1 },
  icon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  editor: { marginTop: 8, borderRadius: Radius.lg, borderWidth: 1, paddingHorizontal: 12 },
  divider: { height: StyleSheet.hairlineWidth },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  stepperLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textTransform: 'uppercase', letterSpacing: 1 },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: { width: 34, height: 34, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  stepperValue: { fontSize: FontSize.base, fontWeight: FontWeight.bold, minWidth: 96, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
