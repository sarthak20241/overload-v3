/**
 * InsightsStrip — the "Coach noticed" section on the dashboard.
 *
 * A horizontal, snap-scrolling rail of InsightCards. Horizontal (not a vertical
 * stack) keeps the already-dense dashboard short and lets a peeking next card
 * invite exploration. Renders nothing when there's nothing to say — no empty
 * shell — so quiet weeks and brand-new users see a clean dashboard.
 *
 * Dismissal persists in AsyncStorage keyed by the insight's id. Because ids
 * carry a week stamp (see lib/insights), a dismissed plateau re-surfaces next
 * week if it's still true, but stays gone for the rest of this one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Spacing, FontSize, FontWeight, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import type { Insight } from '@/lib/insights';
import { InsightCard } from './InsightCard';

const DISMISS_KEY = 'insights:dismissed:v1';
const GAP = 12;

function useDismissedInsights() {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(DISMISS_KEY)
      .then(raw => {
        if (!alive) return;
        if (raw) {
          try { setIds(new Set(JSON.parse(raw) as string[])); } catch { /* ignore corrupt */ }
        }
        setLoaded(true);
      })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  const dismiss = useCallback((id: string) => {
    setIds(prev => {
      const next = new Set(prev);
      next.add(id);
      // FIFO cap so the list can't grow without bound across many weeks.
      const arr = Array.from(next).slice(-100);
      AsyncStorage.setItem(DISMISS_KEY, JSON.stringify(arr)).catch(() => {});
      return new Set(arr);
    });
  }, []);

  return { dismissedIds: ids, loaded, dismiss };
}

export function InsightsStrip({
  insights,
  onAsk,
}: {
  insights: Insight[];
  onAsk: (insight: Insight) => void;
}) {
  const { C } = useTheme();
  const { width: winW } = useWindowDimensions();
  const { dismissedIds, loaded, dismiss } = useDismissedInsights();

  const visible = useMemo(
    () => insights.filter(i => !dismissedIds.has(i.id)),
    [insights, dismissedIds],
  );

  // Wait for the dismissed set to load before painting — avoids a flash of a
  // card the user already cleared. Render nothing when there's nothing to show.
  if (!loaded || visible.length === 0) return null;

  // With 2+ cards, ~80% width leaves the next one peeking ("swipeable"). With a
  // single insight there's nothing to peek, so it fills the width instead.
  const single = visible.length === 1;
  const cardWidth = single ? winW - Spacing.xl * 2 : Math.min(300, Math.round(winW * 0.8));

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Feather name="zap" size={14} color={C.accentText} />
        <Text style={[styles.headerText, { color: C.accentText }]}>Coach noticed</Text>
        {visible.length > 1 && (
          <View style={[styles.countPill, { backgroundColor: C.primaryMuted }]}>
            <Text style={[styles.countText, { color: C.accentText }]}>{visible.length}</Text>
          </View>
        )}
      </View>

      {single ? (
        <View style={styles.singleWrap}>
          <InsightCard
            insight={visible[0]}
            width={cardWidth}
            index={0}
            onAsk={onAsk}
            onDismiss={dismiss}
          />
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={cardWidth + GAP}
          snapToAlignment="start"
          contentContainerStyle={styles.scrollContent}
        >
          {visible.map((insight, i) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              width={cardWidth}
              index={i}
              onAsk={onAsk}
              onDismiss={dismiss}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: Spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.xl,
    // sm (not md): the header hugs its cards so the first card's title line
    // clears the tab bar when the strip is the last thing above the fold.
    marginBottom: Spacing.sm,
  },
  headerText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  countPill: {
    minWidth: 18,
    height: 18,
    borderRadius: Radius.full,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    fontSize: 10,
    fontWeight: FontWeight.bold,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    gap: GAP,
  },
  singleWrap: {
    paddingHorizontal: Spacing.xl,
  },
});
