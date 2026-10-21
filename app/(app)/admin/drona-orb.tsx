/**
 * Dev preview for Drona's orb (admin-only, deep-link: overload://admin/drona-orb).
 * Every orb state and size, plus the real onboarding build screen and the
 * Today card's "preparing" state, without calling the coach. No data access.
 * One live orb on screen at a time, like the app itself.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { OrbStage } from '@/components/coach/OrbStage';
import { RichBlock } from '@/components/coach/CoachBlocks';
import { parseCoachBlocks } from '@/lib/coachBlocks';
import type { SignalOrbState } from '@/components/coach/SignalOrb';
import { BuildMoment } from '@/components/onboarding/BuildMoment';
import { TodaySuggestionCard, type TodaySuggestion } from '@/components/workout/TodaySuggestionCard';

const STATES: SignalOrbState[] = ['listening', 'thinking', 'searching', 'done'];
const SIZES = [168, 120, 96, 34, 28];
const LABELS: Record<SignalOrbState, string> = {
  listening: 'Ready when you are',
  thinking: 'Building your plan',
  searching: 'Looking up your sets',
  done: 'Done',
};
type Tab = 'orb' | 'build' | 'today' | 'blocks';

// An example reply (not anyone's data) using every drawn block, in the exact
// format the server teaches Drona.
const SAMPLE_REPLY = `Your bench has moved up this month. Here is every top set:

| Date | Exercise | Top set | Reps |
|------|----------|---------|------|
| Sep 1 | Bench Press | 80 kg | 9 |
| Sep 9 | Bench Press | 80 kg | 8 |
| Oct 12 | Flat Bench Press | 75 kg | 8 |
| Oct 16 | Flat Bench Press | 80 kg | 6 |

\`\`\`chart
{"kind":"line","title":"Bench top set","unit":"kg","points":[["Sep 1",80],["Sep 9",80],["Sep 23",77.5],["Oct 12",75],["Oct 16",80]],"goal":85,"goal_label":"Next target"}
\`\`\`

\`\`\`stats
[{"label":"Best set","value":"80 kg x 9","note":"Sep 1"},{"label":"Sessions","value":"5"},{"label":"Avg reps","value":"7.8"}]
\`\`\`

Sets per muscle this week:

\`\`\`chart
{"kind":"bar","title":"Working sets","points":[["Chest",12],["Back",9],["Legs",14],["Shoulders",6],["Arms",8]]}
\`\`\`

**Next step:** stay at 80 kg until all three sets reach 8.

Calories this week against your target:

\`\`\`chart
{"kind":"line","title":"Daily calories","unit":"kcal","series":[{"name":"Eaten","points":[["Mon",2100],["Tue",2450],["Wed",1980],["Thu",2300],["Fri",2600],["Sat",2250]]},{"name":"Target","points":[["Mon",2350],["Tue",2350],["Wed",2350],["Thu",2350],["Fri",2350],["Sat",2350]]}]}
\`\`\`

Where today's calories came from:

\`\`\`chart
{"kind":"donut","title":"Today by macro","unit":"kcal","points":[["Protein",420],["Carbs",688],["Fat",558]]}
\`\`\`

\`\`\`progress
[{"label":"Protein","value":105,"target":115,"unit":"g"},{"label":"Steps","value":6200,"target":8000},{"label":"Sessions this week","value":4,"target":4}]
\`\`\``;

// Streams the sample in like a real reply, to show the placeholders.
function BlocksPreview() {
  const { C } = useTheme();
  const [shown, setShown] = useState(SAMPLE_REPLY.length);
  const streaming = shown < SAMPLE_REPLY.length;
  React.useEffect(() => {
    if (!streaming) return;
    const t = setTimeout(() => setShown((n) => Math.min(SAMPLE_REPLY.length, n + 6)), 16);
    return () => clearTimeout(t);
  }, [shown, streaming]);
  const blocks = parseCoachBlocks(SAMPLE_REPLY.slice(0, shown), streaming);
  const inline = (t: string) => t.replace(/\*\*/g, '');
  return (
    <ScrollView contentContainerStyle={[styles.scroll, { gap: 8 }]}>
      <Pressable
        onPress={() => setShown(0)}
        style={[styles.segBtn, { alignSelf: 'flex-start', backgroundColor: C.card, borderColor: C.border }]}
      >
        <Text style={[styles.segLabel, { color: C.textSecondary }]}>Stream it</Text>
      </Pressable>
      <Text style={{ color: C.textMuted, fontSize: 12 }}>Example reply. Not real data.</Text>
      {blocks.map((b, i) =>
        b.type === 'paragraph' || b.type === 'heading'
          ? <Text key={i} style={{ color: C.foreground, fontSize: 14, lineHeight: 20 }}>{inline(b.text)}</Text>
          : b.type === 'list'
            ? <Text key={i} style={{ color: C.foreground, fontSize: 14 }}>{b.items.map((t) => `• ${inline(t)}`).join('\n')}</Text>
            : <RichBlock key={i} block={b} inline={inline} />,
      )}
    </ScrollView>
  );
}

export default function DronaOrbPreview() {
  const router = useRouter();
  const { C } = useTheme();
  const [tab, setTab] = useState<Tab>('orb');
  const [state, setState] = useState<SignalOrbState>('thinking');
  const [size, setSize] = useState(168);
  const [buildKey, setBuildKey] = useState(0);
  const [ready, setReady] = useState(false);

  const Seg = <T extends string | number>({ items, value, onPick, label }: {
    items: T[]; value: T; onPick: (v: T) => void; label?: (v: T) => string;
  }) => (
    <View style={styles.segRow}>
      {items.map((v) => (
        <Pressable
          key={String(v)}
          onPress={() => onPick(v)}
          accessibilityRole="button"
          accessibilityState={{ selected: value === v }}
          style={[styles.segBtn, { backgroundColor: value === v ? Colors.primary : C.card, borderColor: C.border }]}
        >
          <Text style={[styles.segLabel, { color: value === v ? '#0a0c07' : C.textSecondary }]}>
            {label ? label(v) : String(v)}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: C.background }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={12}>
          <Feather name="arrow-left" size={22} color={C.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: C.foreground }]}>Drona orb preview</Text>
        <View style={{ width: 22 }} />
      </View>
      <View style={{ paddingHorizontal: Spacing.lg }}>
        <Seg<Tab>
          items={['orb', 'build', 'today', 'blocks']}
          value={tab}
          onPick={setTab}
          label={(t) => (t === 'orb' ? 'Orb' : t === 'build' ? 'Onboarding' : t === 'today' ? 'Today' : 'Reply blocks')}
        />
      </View>

      {tab === 'orb' && (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.stage, { backgroundColor: C.card }]}>
            <OrbStage state={state} size={size} label={size >= 96 ? LABELS[state] : undefined} />
          </View>
          <Seg items={STATES} value={state} onPick={setState} />
          <Seg items={SIZES} value={size} onPick={setSize} label={(v) => `${v}`} />
        </ScrollView>
      )}

      {tab === 'build' && (
        <View style={{ flex: 1 }}>
          <View style={[styles.segRow, { paddingHorizontal: Spacing.lg }]}>
            <Pressable onPress={() => setReady(true)} style={[styles.segBtn, { backgroundColor: C.card, borderColor: C.border }]}>
              <Text style={[styles.segLabel, { color: C.textSecondary }]}>Plan ready</Text>
            </Pressable>
            <Pressable
              onPress={() => { setReady(false); setBuildKey((k) => k + 1); }}
              style={[styles.segBtn, { backgroundColor: C.card, borderColor: C.border }]}
            >
              <Text style={[styles.segLabel, { color: C.textSecondary }]}>Replay</Text>
            </Pressable>
          </View>
          <BuildMoment
            key={buildKey}
            lines={['Reading your answers', 'Mapping the road to your goal', 'Picking exercises for you', 'Setting fuel targets', 'Locking your first week']}
            ready={ready}
            onDone={() => {}}
          />
        </View>
      )}

      {tab === 'blocks' && <BlocksPreview />}

      {tab === 'today' && (
        <View style={{ padding: Spacing.lg }}>
          <TodaySuggestionCard suggestion={{ kind: 'preparing' } as TodaySuggestion} onPress={() => {}} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
  },
  title: { fontSize: FontSize.lg, fontWeight: '600' },
  scroll: { padding: Spacing.lg, gap: Spacing.lg },
  stage: { borderRadius: Radius.xl, alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.xxl, minHeight: 280 },
  segRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginVertical: Spacing.sm },
  segBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.full, borderWidth: 1 },
  segLabel: { fontSize: FontSize.sm, fontWeight: '600' },
});
