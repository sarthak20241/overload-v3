/**
 * RPE / RIR picker (Phase B). Tapping the intensity cell in the logger opens
 * this — a slider with a LIVE meaning, so logging a value tells you what it
 * implies (e.g. RIR 2 = "2 reps left in the tank").
 *
 * Values are stored as raw RPE (1-10, 0.5 grid); the display flips to RIR
 * (10 - rpe) when the user's scale is RIR. onChange fires live as the slider
 * moves; Done dismisses, Clear unsets.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, TouchableOpacity, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';
import { RpeSlider } from '@/components/workout/RpeSlider';

interface Props {
  visible: boolean;
  scale: 'rpe' | 'rir';
  value: number | null;
  onChange: (rpe: number | null) => void;
  onClose: () => void;
}

/** What a given RPE actually means, in plain terms (RIR = reps in reserve + feel). */
function meaning(rpe: number | null): { title: string; sub: string } {
  if (rpe == null) return { title: 'How hard was that set?', sub: 'Slide to log effort' };
  const rir = Math.round((10 - rpe) * 2) / 2;
  const reps = rir === 0 ? 'Nothing left in the tank' : `${rir} rep${rir === 1 ? '' : 's'} in reserve`;
  const feel =
    rpe >= 10 ? 'All-out — true failure'
    : rpe >= 9 ? 'Very hard — a grind'
    : rpe >= 8 ? 'Hard — the growth zone'
    : rpe >= 7 ? 'Solid, still in control'
    : rpe >= 6 ? 'Comfortable'
    : 'Easy — warm-up pace';
  return { title: reps, sub: feel };
}

export function RpePickerSheet({ visible, scale, value, onChange, onClose }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose]);

  const label = scale === 'rir' ? 'RIR' : 'RPE';
  const shown = value == null ? '—' : String(scale === 'rir' ? 10 - value : value);
  const m = meaning(value);

  return (
    <Portal>
      {visible && (
        <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
          <Animated.View
            entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
          >
            <Pressable>
              <View style={[s.handle, { backgroundColor: C.handle }]} />
              <View style={s.header}>
                <Text style={[s.title, { color: C.foreground }]}>{label}</Text>
                <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={15} color={C.foreground} />
                </TouchableOpacity>
              </View>

              {/* Big live value + what it means */}
              <View style={s.readout}>
                <View style={s.valueRow}>
                  <Text style={[s.scaleTag, { color: C.textMuted }]}>{label}</Text>
                  <Text style={[s.value, { color: value == null ? C.textMuted : Colors.primary }]}>{shown}</Text>
                </View>
                <Text style={[s.meaningTitle, { color: C.foreground }]}>{m.title}</Text>
                <Text style={[s.meaningSub, { color: C.textMuted }]}>{m.sub}</Text>
              </View>

              <RpeSlider value={value} onChange={(rpe) => onChange(rpe)} />
              <View style={s.anchors}>
                <Text style={[s.anchor, { color: C.textMuted }]}>{scale === 'rir' ? 'Easy (9)' : 'Easy (1)'}</Text>
                <Text style={[s.anchor, { color: C.textMuted }]}>{scale === 'rir' ? 'Failure (0)' : 'Max (10)'}</Text>
              </View>

              <View style={s.footer}>
                {value != null && (
                  <TouchableOpacity onPress={() => { haptics.selection(); onChange(null); }} style={[s.clearBtn, { borderColor: C.border }]} activeOpacity={0.7}>
                    <Feather name="x-circle" size={15} color={C.textMuted} />
                    <Text style={[s.clearText, { color: C.textMuted }]}>Clear</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => { haptics.selection(); onClose(); }} style={[s.doneBtn, { backgroundColor: Colors.primary }]} activeOpacity={0.85}>
                  <Text style={s.doneText}>Done</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Animated.View>
        </Pressable>
      )}
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  readout: { alignItems: 'center', paddingVertical: Spacing.lg },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  scaleTag: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, textTransform: 'uppercase', letterSpacing: 1 },
  value: { fontSize: 52, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'], lineHeight: 56 },
  meaningTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, marginTop: 6 },
  meaningSub: { fontSize: FontSize.sm, marginTop: 2 },
  anchors: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2, marginBottom: Spacing.lg },
  anchor: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  footer: { flexDirection: 'row', gap: 10 },
  clearBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 48, paddingHorizontal: 18, borderRadius: Radius.xl, borderWidth: 1 },
  clearText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  doneBtn: { flex: 1, height: 48, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center' },
  doneText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },
});
