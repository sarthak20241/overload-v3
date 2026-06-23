import { ReactNode, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Switch,
  TouchableOpacity,
  StyleSheet,
  BackHandler,
  Platform,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { usePreferences } from '@/hooks/usePreferences';
import { Portal } from '@/components/ui/Portal';
import { haptics } from '@/lib/haptics';

// Workout settings live here. This is the home for "complexity on tap" — the
// table stays clean by default, and anything a power user wants to switch on
// lives behind this sheet. Phase 0 ships the foundation + the keep-awake toggle;
// Phase A adds the inline-timer row, Phase B adds the intensity (RPE/RIR) rows,
// and the backlog toggles (plate calculator, music, PR alerts, …) each become a
// single <ToggleRow> here. The Portal pattern matches ExercisePickerSheet so the
// sheet renders flush to the bottom on Android edge-to-edge.

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function WorkoutSettingsSheet({ visible, onClose }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { prefs, setPreference } = usePreferences();

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  return (
    <Portal>
      {visible && (
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
      <Animated.View
        entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
        exiting={SlideOutDown.duration(200)}
        style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md }]}
      >
        {/* Stop backdrop taps inside the sheet from closing it. */}
        <Pressable style={{ flexShrink: 1 }}>
          <View style={[s.handle, { backgroundColor: C.handle }]} />

          <View style={s.header}>
            <View style={{ flex: 1 }}>
              <Text style={[s.title, { color: C.foreground }]}>Workout settings</Text>
              <Text style={[s.subtitle, { color: C.mutedFg }]}>Tune how logging works for you</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
              <Feather name="x" size={15} color={C.foreground} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flexGrow: 0 }} showsVerticalScrollIndicator={false}>
            <SectionLabel color={C.textMuted}>During workout</SectionLabel>

            <ToggleRow
              icon={<Feather name="sun" size={15} color={C.foreground} />}
              tint={C.muted}
              title="Keep screen awake"
              subtitle="Stops your phone sleeping between sets."
              value={prefs.keepAwake}
              onValueChange={(v) => setPreference('keepAwake', v)}
            />

            {/* Phase A adds: "Stopwatch for timed exercises" → inlineTimerForDuration */}
            {/* Phase B adds: "Track intensity (RPE / RIR)" → intensityTrackingEnabled + intensityScale */}
          </ScrollView>
        </Pressable>
      </Animated.View>
      </Pressable>
      )}
    </Portal>
  );
}

function SectionLabel({ children, color }: { children: ReactNode; color: string }) {
  return <Text style={[s.sectionLabel, { color }]}>{children}</Text>;
}

interface ToggleRowProps {
  icon: ReactNode;
  tint: string;
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}

function ToggleRow({ icon, tint, title, subtitle, value, onValueChange }: ToggleRowProps) {
  const { C } = useTheme();
  return (
    <View style={[s.row, { borderColor: C.borderSubtle }]}>
      <View style={[s.rowIcon, { backgroundColor: tint }]}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={[s.rowTitle, { color: C.foreground }]}>{title}</Text>
        {subtitle ? <Text style={[s.rowSub, { color: C.textMuted }]}>{subtitle}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={(v) => { haptics.selection(); onValueChange(v); }}
        trackColor={{ true: Colors.primary, false: C.border }}
        thumbColor={Platform.OS === 'android' ? (value ? Colors.primaryFg : '#f4f4f5') : undefined}
        ios_backgroundColor={C.border}
      />
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
    maxHeight: '90%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: Spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  subtitle: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.sm, marginTop: 1 },
});
