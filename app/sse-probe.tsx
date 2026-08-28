// THROWAWAY. Phase 4 device check, no keyboard required.
//
// M1 proved the transport (expo/fetch hands SSE chunks over as they arrive).
// What this proves now is the whole M3 chain on a real device:
//   parse_meal SSE -> parseMealStreaming -> StreamedItem rows
//   -> ParsedMealCard state 'streaming' -> SettlingRow shimmer
//   -> final review card.
//
// The nutrition screen's own input cannot be driven by the simulator's
// synthetic keyboard (it drops characters), so the same call is fired from a
// single button here with a fixed phrase.
//
// Delete once Phase 4 is signed off.
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ParsedMealCard, type StreamingRow } from '@/components/diet/ParsedMealCard';
import { parseMealStreaming, type ParsedMeal, type StreamedItem } from '@/lib/dietData';
import { supabase } from '@/lib/supabase';

// Branded on purpose: OFF is a PACKAGED-food database, so a plain "egg" or
// "banana" usually returns nothing and never exercises the backfill path that
// dominates resolve time. Named products do.
const PHRASE = '2 oreo biscuits and 1 amul cheese slice';

export default function SseProbe() {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<StreamingRow[] | null>(null);
  const [meal, setMeal] = useState<ParsedMeal | null>(null);

  const run = useCallback(async () => {
    setLines([]);
    setRows(null);
    setMeal(null);
    setRunning(true);
    const t0 = Date.now();
    const log = (s: string) => setLines((p) => [...p, s]);
    try {
      const res = await parseMealStreaming(
        supabase,
        { text: PHRASE, mealHint: 'breakfast', turns: [] },
        (items: StreamedItem[]) => {
          setRows(items);
          log(`+${Date.now() - t0}ms rows=${items.length} ${items.map((i) => `${i.name} ${i.est_kcal ?? '~'}kcal ${i.est_protein_g ?? '~'}P ${i.est_carb_g ?? '~'}C ${i.est_fat_g ?? '~'}F`).join(' | ')}`);
        },
      );
      log(`+${Date.now() - t0}ms FINAL kind=${res.kind}`);
      if (res.kind === 'parsed') {
        setMeal(res.meal);
        log(res.meal.items.map((i) => `${i.food_name} ${i.kcal}kcal [${i.source}] ${i.confidence}`).join('\n'));
      } else {
        log(JSON.stringify(res).slice(0, 300));
      }
    } catch (e) {
      log(`ERROR ${String(e).slice(0, 200)}`);
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#000', paddingTop: 60, paddingHorizontal: 12 }}>
      <Pressable
        onPress={run}
        disabled={running}
        style={{ backgroundColor: running ? '#333' : '#c8ff00', padding: 14, borderRadius: 10 }}
      >
        <Text style={{ textAlign: 'center', fontWeight: '700', color: running ? '#888' : '#000' }}>
          {/* v3 marker: three Metros share this simulator, and one stale-bundle
              round already produced a false "region pin does not work". The
              label is the proof of which bundle is live. */}
          {running ? 'streaming…' : `RUN v3 "${PHRASE}"`}
        </Text>
      </Pressable>

      <View style={{ marginTop: 14 }}>
        <ParsedMealCard
          state={meal ? 'review' : running ? (rows ? 'streaming' : 'analysing') : 'analysing'}
          streamingRows={rows}
          rawText={PHRASE}
          meal={meal}
          mealType="breakfast"
        />
      </View>

      <ScrollView style={{ marginTop: 14 }}>
        {lines.map((l, i) => (
          <Text key={i} style={{ color: '#0f0', fontFamily: 'Menlo', fontSize: 11, marginBottom: 3 }}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
