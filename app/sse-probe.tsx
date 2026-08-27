// THROWAWAY. Phase 4 M1 risk probe, client half.
//
// The server half is proven: a Supabase edge function streams, and event gaps
// survive the CDN (measured 0.40s gaps, warm first byte 0.46-0.86s). What is
// NOT proven is whether expo/fetch on a real device hands chunks over as they
// arrive, or quietly buffers the whole body and resolves once. The entire
// progressive-card design rests on the answer, so it gets measured before
// anything is built on it.
//
// Delete once the real SSE transport lands.
import { fetch as expoFetch } from 'expo/fetch';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

const URL = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/sse-probe`;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export default function SseProbe() {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setLines([]);
    setRunning(true);
    const t0 = Date.now();
    const log = (s: string) => setLines((p) => [...p, s]);
    try {
      const res = await expoFetch(URL, { headers: { Authorization: `Bearer ${ANON}` } });
      log(`status ${res.status} @ ${Date.now() - t0}ms`);
      const body = res.body;
      if (!body) { log('NO BODY STREAM — buffered'); return; }
      const reader = body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let last = Date.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!data) continue;
          const now = Date.now();
          log(`+${String(now - t0).padStart(5)}ms  (gap ${String(now - last).padStart(4)}ms)  ${data.slice(5).trim()}`);
          last = now;
        }
      }
      log(`DONE @ ${Date.now() - t0}ms`);
    } catch (e) {
      log(`ERROR ${String(e).slice(0, 120)}`);
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
          {running ? 'streaming…' : 'RUN SSE PROBE'}
        </Text>
      </Pressable>
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
