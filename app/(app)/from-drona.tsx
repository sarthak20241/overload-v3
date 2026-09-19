/**
 * From Drona — the cards the user pushed to Later, and what Drona has done.
 *
 * Two piles, one list (rules in lib/dronaInbox):
 *   Waiting  pending and inside its week. The card renders with its buttons
 *            live, exactly as the popup offered them, minus Later.
 *   Done     answered or expired, newest first, one line each: what it was and
 *            what happened. A swap that landed keeps Undo for seven days.
 *
 * This is also the plan history the owner asked for (2026-09-17): the change
 * diary read through the cards that caused it. Hidden sibling TAB, reached
 * from Profile and from the Goal screen; the chevron returns to whichever one
 * opened it (the `from` param), because router.back() on a hidden tab pops
 * tab history and lands on the dashboard.
 */
import { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { useToast } from '@/components/ui/Toast';
import { track } from '@/lib/analytics';
import { DronaCardView } from '@/components/coach/DronaCardView';
import { ACTION_ROUTES } from '@/lib/dronaRules';
import { bucketOf, canUndo } from '@/lib/dronaInbox';
import {
  movesFor, readCardHistory, setCardStatus, type SavedDronaCard,
} from '@/lib/dronaCard';

export default function FromDronaScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const toast = useToast();
  const [cards, setCards] = useState<SavedDronaCard[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    if (!user?.id) return;
    let live = true;
    readCardHistory(supabase, user.id).then((rows) => {
      if (!live) return;
      if (rows === undefined) setFailed(true);
      else { setFailed(false); setCards(rows); }
    });
    return () => { live = false; };
  }, [user?.id, supabase]);
  useFocusEffect(load);

  const back = useCallback(() => {
    router.replace(from === 'goal' ? '/goal-plan' : '/(app)/profile');
  }, [router, from]);

  const now = Date.now();
  const { waiting, done } = useMemo(() => {
    const w: SavedDronaCard[] = [];
    const d: SavedDronaCard[] = [];
    for (const c of cards ?? []) (bucketOf(c, now) === 'waiting' ? w : d).push(c);
    return { waiting: w, done: d };
  }, [cards, now]);

  // The same three answers the popup offered. Each one updates the list in
  // place so the card moves piles without a reload.
  const patch = (id: string, changes: Partial<SavedDronaCard>) =>
    setCards((prev) => prev?.map((c) => (c.id === id ? { ...c, ...changes } : c)) ?? prev);

  const act = (card: SavedDronaCard) => {
    const action = card.payload.action;
    track('drona_card_acted', { kind: card.kind, topic: card.topic, action: action ?? null, from: 'inbox' });
    const moves = movesFor(action);
    if (moves && action !== 'undo_swap') {
      // Optimistic: the row moves to Done now, and comes back if the server
      // said no (it leaves the card pending in that case).
      const before = { status: card.status, decided_at: card.decided_at };
      patch(card.id, { status: 'applied', decided_at: new Date().toISOString() });
      void moves.apply(supabase, card.id).then((result) => {
        if (result === 'ok') {
          toast.success(action === 'apply_targets'
            ? `${card.payload.to_kcal} kcal is your target now.`
            : `${card.payload.to_name ?? 'The swap'} is in the plan.`);
        } else {
          patch(card.id, before);
          toast.info(result === 'moved_on'
            ? 'That has changed since. Nothing was touched.'
            : 'Could not do that right now. Try again.');
        }
      });
      return;
    }
    patch(card.id, { status: 'applied', decided_at: new Date().toISOString() });
    void setCardStatus(supabase, card.id, 'applied');
    if (action === 'start_session') { router.replace('/(app)'); return; }
    const route = action ? ACTION_ROUTES[action] : undefined;
    if (route) router.push(route as any);
  };

  const dismiss = (card: SavedDronaCard) => {
    track('drona_card_dismissed', { kind: card.kind, topic: card.topic, from: 'inbox' });
    patch(card.id, { status: 'dismissed', decided_at: new Date().toISOString() });
    void setCardStatus(supabase, card.id, 'dismissed');
  };

  const undo = (card: SavedDronaCard) => {
    track('drona_card_undone', { kind: card.kind, topic: card.topic, from: 'inbox' });
    const moves = movesFor(card.payload.action);
    if (!moves) return;
    const before = { status: card.status, decided_at: card.decided_at };
    patch(card.id, { status: 'undone', decided_at: new Date().toISOString() });
    void moves.undo(supabase, card.id).then((result) => {
      if (result === 'ok') {
        toast.info(card.payload.action === 'apply_targets'
          ? `Back to ${card.payload.from_kcal} kcal.`
          : `${card.payload.from_name ?? 'The old exercise'} is back in the plan.`);
      } else if (result === 'moved_on') {
        // The server closed the card as dismissed: nothing was left to put back.
        patch(card.id, { status: 'dismissed' });
        toast.info('That has changed since. Nothing was touched.');
      } else {
        patch(card.id, before);
        toast.info(result === 'too_late' ? 'That one is past its Undo window.' : 'Could not do that right now. Try again.');
      }
    });
  };

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: C.background }]} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity
          onPress={back}
          style={[s.backBtn, { backgroundColor: C.muted, borderColor: C.border }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={18} color={C.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: C.foreground }]}>From Drona</Text>
          <Text style={[s.subtitle, { color: C.mutedFg }]}>
            {waiting.length > 0 ? `${waiting.length} waiting for you` : 'Nothing waiting'}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {failed && (
          <Text style={[s.empty, { color: C.mutedFg }]}>Could not load this right now. Pull back in a moment.</Text>
        )}
        {cards === null && !failed && (
          <Text style={[s.empty, { color: C.mutedFg }]}>Reading your cards...</Text>
        )}

        {cards !== null && (<>
        <Text style={[s.label, { color: C.textMuted }]}>WAITING</Text>
        {waiting.length === 0 ? (
          <Text style={[s.empty, { color: C.mutedFg }]}>
            Cards you push to Later wait here until their week ends.
          </Text>
        ) : (
          waiting.map((card) => (
            <View key={card.id} style={{ marginBottom: Spacing.md }}>
              <DronaCardView
                card={card}
                onAct={() => act(card)}
                onDismiss={() => dismiss(card)}
                onUndo={() => undo(card)}
              />
            </View>
          ))
        )}

        <Text style={[s.label, { color: C.textMuted, marginTop: Spacing.lg }]}>DONE</Text>
        {done.length === 0 ? (
          <Text style={[s.empty, { color: C.mutedFg }]}>Nothing yet. What Drona changes shows up here.</Text>
        ) : (
          <View style={[s.doneCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            {done.map((card, i) => (
              <View
                key={card.id}
                style={[s.doneRow, i < done.length - 1 && { borderBottomWidth: 1, borderBottomColor: C.borderSubtle }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[s.doneTitle, { color: C.foreground }]} numberOfLines={2}>{card.title}</Text>
                  <Text style={[s.doneMeta, { color: C.textDim }]}>
                    {outcomeFor(card, now)}{whenFor(card)}
                  </Text>
                </View>
                {canUndo(card, now) && (
                  <TouchableOpacity
                    onPress={() => undo(card)}
                    style={[s.undo, { borderColor: C.borderSubtle }]}
                    accessibilityRole="button"
                    accessibilityLabel="Undo"
                  >
                    <Text style={[s.undoText, { color: C.foreground }]}>Undo</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </View>
        )}
        </>)}
      </ScrollView>
    </SafeAreaView>
  );
}

/** One plain phrase for what became of a card. Coach voice, not a status enum. */
function outcomeFor(card: SavedDronaCard, nowMs: number): string {
  if (card.status === 'pending') return 'Expired before you decided';
  const action = card.payload.action;
  const swap = action === 'apply_swap' || action === 'undo_swap';
  const targets = action === 'apply_targets';
  switch (card.status) {
    case 'applied':
      if (targets) return `Target set to ${card.payload.to_kcal} kcal`;
      return swap ? `${card.payload.to_name ?? 'The swap'} went into the plan` : 'You took it up';
    case 'undone':
      if (targets) return `Back to ${card.payload.from_kcal} kcal`;
      return `${card.payload.from_name ?? 'The old exercise'} went back in`;
    case 'dismissed':
      return swap || targets ? 'You kept the plan' : 'You passed';
    case 'expired':
      return 'Expired';
    default:
      return card.status.charAt(0).toUpperCase() + card.status.slice(1);
  }
}

function whenFor(card: SavedDronaCard): string {
  const iso = card.decided_at ?? card.created_at;
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return ` · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.md,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  subtitle: { fontSize: FontSize.xs, marginTop: 2 },
  scroll: { paddingHorizontal: Spacing.xl, paddingBottom: 120 },
  label: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: 1, marginBottom: Spacing.sm },
  empty: { fontSize: FontSize.sm, lineHeight: 19, marginBottom: Spacing.sm },
  doneCard: { borderRadius: Radius.lg, borderWidth: 1, overflow: 'hidden' },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingVertical: 12 },
  doneTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  doneMeta: { fontSize: FontSize.xs, marginTop: 2 },
  undo: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: Radius.md, borderWidth: 1 },
  undoText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
});
