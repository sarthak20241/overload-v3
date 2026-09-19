/**
 * PastChatsList — the "Past chats" view inside the coach sheet.
 *
 * Reads the summaries the conversation store already keeps
 * (lib/coachConversations: bounded, newest first, only chats the user typed
 * in). Tap a row to reopen it; the trash control asks before deleting. The
 * one on screen is marked so the list explains itself.
 */
import { useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import { haptics } from '@/lib/haptics';
import type { CoachConversationSummary } from '@/lib/coachConversations';

/** "Today", "Yesterday", a weekday inside the week, else a short date. */
export function whenLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = d.getFullYear() === n.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function PastChatsList({
  conversations,
  activeId,
  onOpen,
  onDelete,
}: {
  conversations: CoachConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { C } = useTheme();
  const [pendingDelete, setPendingDelete] = useState<CoachConversationSummary | null>(null);

  return (
    <>
      <FlatList
        data={conversations}
        keyExtractor={(c) => c.id}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={s.empty}>
            <Feather name="message-circle" size={24} color={C.textMuted} />
            <Text style={[s.emptyTitle, { color: C.foreground }]}>Nothing here yet</Text>
            <Text style={[s.emptySub, { color: C.textSecondary }]}>
              Every chat with Coach Drona lands here once you send a message.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const current = item.id === activeId;
          return (
            <Pressable
              onPress={() => { haptics.tick(); onOpen(item.id); }}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}. ${whenLabel(item.updatedAt)}${current ? '. Open now' : ''}`}
              style={({ pressed }) => [
                s.row,
                {
                  backgroundColor: pressed ? C.muted : C.card,
                  borderColor: current ? C.primaryBorder : C.borderSubtle,
                },
              ]}
            >
              <View style={s.rowBody}>
                <Text numberOfLines={2} style={[s.rowTitle, { color: C.foreground }]}>{item.title}</Text>
                <Text style={[s.rowMeta, { color: C.textMuted }]}>
                  {whenLabel(item.updatedAt)}
                  {current ? '  ·  Open now' : ''}
                </Text>
              </View>
              <Pressable
                onPress={() => { haptics.warning(); setPendingDelete(item); }}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Delete this chat"
                style={({ pressed }) => [s.trash, { backgroundColor: pressed ? C.muted : 'transparent' }]}
              >
                <Feather name="trash-2" size={14} color={C.textMuted} />
              </Pressable>
            </Pressable>
          );
        }}
      />
      <ThemedAlert
        visible={!!pendingDelete}
        icon="trash-2"
        iconColor={C.dangerText}
        title="Delete this chat?"
        message="Coach Drona keeps what he learned about you. Only these messages go."
        buttons={[
          { text: 'Keep it', onPress: () => setPendingDelete(null) },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              const target = pendingDelete;
              setPendingDelete(null);
              if (target) onDelete(target.id);
            },
          },
        ]}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}

const s = StyleSheet.create({
  list: { padding: Spacing.xl, paddingBottom: 24, gap: Spacing.sm, flexGrow: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    borderWidth: 1, borderRadius: Radius.lg, padding: Spacing.md,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, lineHeight: 20 },
  rowMeta: { fontSize: FontSize.xs, marginTop: 3 },
  trash: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: Spacing.xl, paddingVertical: 40 },
  emptyTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, marginTop: 6 },
  emptySub: { fontSize: FontSize.sm, textAlign: 'center', lineHeight: 18 },
});
