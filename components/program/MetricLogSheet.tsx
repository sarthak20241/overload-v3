/**
 * Log today's value for a custom phase metric ("You log it" on the Goal
 * screen). One number, in the metric's own unit, with steppers, and an
 * optional note. Portal-based (never RN <Modal>, per the project's Android
 * edge-to-edge rule), sliding like SaveMealSheet; no layout animation on the
 * sheet itself, so the keyboard lift is not pinned. The parent owns the save
 * (logMetricValue) and passes `saving`.
 */
import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, TouchableOpacity, StyleSheet, BackHandler, Keyboard, Platform,
  useWindowDimensions,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { useSheetSlide } from '@/hooks/useSheetSlide';
import { haptics } from '@/lib/haptics';
import { formatMetricValue, metricLabel, type PhaseMetricRow } from '@/lib/phaseMetrics';
import { OrbLoader } from '@/components/ui/OrbLoader';

interface Props {
  visible: boolean;
  metric: PhaseMetricRow | null;
  saving: boolean;
  onSave: (value: number, note: string) => void;
  onClose: () => void;
}

/** The stepper's step from the target's size: 1 past 20, else 0.5. */
const stepFor = (target: number) => (Math.abs(target) >= 20 ? 1 : 0.5);

export function MetricLogSheet({ visible, metric, saving, onSave, onClose }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const { mounted, slideStyle } = useSheetSlide(visible);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (!visible) { setKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [visible]);

  // Prefill with the latest value each time the sheet opens.
  useEffect(() => {
    if (visible && metric) {
      const v = metric.current_value ?? metric.start_value ?? null;
      setText(v == null ? '' : formatMetricValue('custom', v));
      setNote('');
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose]);

  if (!mounted || !metric) return null;

  const value = Number(text.replace(',', '.'));
  // Zero or more, and nothing absurd: the same bounds the table holds.
  const valid = text.trim().length > 0 && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
  const step = stepFor(metric.target_value);
  const bump = (delta: number) => {
    haptics.tick();
    const base = valid ? value : (metric.current_value ?? metric.start_value ?? 0);
    setText(formatMetricValue('custom', Math.max(0, base + delta)));
  };
  const label = metricLabel(metric);

  return (
    <Portal>
      <View style={s.backdrop} pointerEvents={visible ? 'auto' : 'none'}>
        {visible && (
          <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={saving ? undefined : onClose} />
          </Animated.View>
        )}
        <Animated.View
          style={[s.sheet, slideStyle, {
            backgroundColor: C.elevated,
            paddingBottom: kbHeight > 0 ? Spacing.md : insets.bottom + Spacing.md,
            marginBottom: kbHeight,
            maxHeight: (winH - kbHeight) * 0.9,
          }]}
        >
          <Pressable style={{ flexShrink: 1 }}>
            <View style={[s.handle, { backgroundColor: C.handle }]} />
            <View style={s.header}>
              <View style={{ flex: 1 }}>
                <Text style={[s.title, { color: C.foreground }]}>Log {label.toLowerCase()}</Text>
                <Text style={[s.subtitle, { color: C.mutedFg }]}>
                  Today's number. Target {formatMetricValue('custom', metric.target_value)}{metric.unit ? ` ${metric.unit}` : ''}.
                </Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            <View style={s.valueRow}>
              <TouchableOpacity onPress={() => bump(-step)} disabled={saving} style={[s.stepBtn, { borderColor: C.border }]} activeOpacity={0.7} accessibilityLabel={`${step} less`}>
                <Feather name="minus" size={20} color={C.foreground} />
              </TouchableOpacity>
              <View style={s.readout}>
                <TextInput
                  style={[s.input, { color: C.foreground }]}
                  value={text}
                  onChangeText={setText}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={C.textDim}
                  maxLength={8}
                  selectTextOnFocus
                  autoFocus
                  accessibilityLabel={`${label} value`}
                />
                <Text style={[s.unit, { color: C.textMuted }]}>{metric.unit || label}</Text>
              </View>
              <TouchableOpacity onPress={() => bump(step)} disabled={saving} style={[s.stepBtn, { borderColor: C.border }]} activeOpacity={0.7} accessibilityLabel={`${step} more`}>
                <Feather name="plus" size={20} color={C.foreground} />
              </TouchableOpacity>
            </View>

            <TextInput
              style={[s.note, { color: C.foreground, backgroundColor: C.muted }]}
              value={note}
              onChangeText={setNote}
              placeholder="A note, if it helps (optional)"
              placeholderTextColor={C.textDim}
              maxLength={120}
              returnKeyType="done"
              accessibilityLabel="Note"
            />

            <TouchableOpacity
              onPress={() => { if (valid) { haptics.selection(); onSave(value, note); } }}
              disabled={saving || !valid}
              style={[s.saveBtn, { backgroundColor: Colors.primary, opacity: saving || !valid ? 0.6 : 1 }]}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Save today's value"
            >
              {saving ? <OrbLoader color={Colors.primaryFg} /> : <Text style={s.saveText}>Log it</Text>}
            </TouchableOpacity>
          </Pressable>
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  valueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.lg },
  stepBtn: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  readout: { alignItems: 'center', flex: 1 },
  input: { fontSize: 40, fontWeight: FontWeight.black, fontVariant: ['tabular-nums'], textAlign: 'center', minWidth: 120, padding: 0 },
  unit: { fontSize: FontSize.sm, marginTop: 2, textTransform: 'uppercase', letterSpacing: 1 },
  note: { borderRadius: Radius.sm, paddingVertical: 10, paddingHorizontal: 12, fontSize: FontSize.base, marginBottom: Spacing.lg },
  saveBtn: { height: 52, borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primaryFg },
});
