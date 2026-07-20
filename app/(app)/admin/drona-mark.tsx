/**
 * Dev preview for DronaMark (admin-only, deep-link: overload://admin/drona-mark).
 * Lets us eyeball every state and size on device before swapping the mark
 * into the coach surfaces. No data access; purely visual.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { DronaMark, type DronaMarkState } from '@/components/coach/DronaMark';

const STATES: DronaMarkState[] = ['idle', 'thinking', 'answer', 'rest'];

export default function DronaMarkPreview() {
  const router = useRouter();
  const { C } = useTheme();
  const [state, setState] = useState<DronaMarkState>('idle');
  // Remount key so re-tapping "answer" replays the one-shot.
  const [replay, setReplay] = useState(0);

  const select = (s: DronaMarkState) => {
    setState(s);
    if (s === 'answer') setReplay((n) => n + 1);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: C.background }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={12}
        >
          <Feather name="arrow-left" size={22} color={C.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: C.foreground }]}>DronaMark preview</Text>
        <View style={{ width: 22 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.stage, { backgroundColor: C.card }]}>
          <DronaMark key={`main-${replay}`} size={96} state={state} />
        </View>

        <View style={styles.segRow}>
          {STATES.map((s) => (
            <Pressable
              key={s}
              onPress={() => select(s)}
              accessibilityRole="button"
              accessibilityState={{ selected: state === s }}
              style={[
                styles.segBtn,
                {
                  backgroundColor: state === s ? Colors.primary : C.card,
                  borderColor: C.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.segLabel,
                  { color: state === s ? '#0a0c07' : C.textSecondary },
                ]}
              >
                {s}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.caption, { color: C.textSecondary }]}>
          Sizes (idle): 72 / 40 / 24
        </Text>
        <View style={[styles.sizeRow, { backgroundColor: C.card }]}>
          <DronaMark size={72} state="idle" />
          <DronaMark size={40} state="idle" />
          <DronaMark size={24} state="idle" />
        </View>

        <Text style={[styles.caption, { color: C.textSecondary }]}>
          Avatar tile context
        </Text>
        <View style={[styles.sizeRow, { backgroundColor: C.card }]}>
          <View style={styles.tile}>
            <DronaMark size={26} state="idle" />
          </View>
          <View style={styles.tile}>
            <DronaMark size={26} state="rest" />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  title: { fontSize: FontSize.lg, fontWeight: '600' },
  scroll: { padding: Spacing.lg, gap: Spacing.md },
  stage: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.xl,
  },
  segRow: { flexDirection: 'row', gap: Spacing.sm },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segLabel: { fontSize: FontSize.sm, fontWeight: '600', textTransform: 'capitalize' },
  caption: { fontSize: FontSize.sm, marginTop: Spacing.sm },
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
  },
  tile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1c2016',
    borderWidth: 1,
    borderColor: 'rgba(200,255,0,0.25)',
  },
});
