/**
 * useCoachConversation — owns the coach chat message list and persists it.
 *
 * Wraps the module-scope store in lib/coachConversations.ts so ChatScreen's
 * conversation survives the modal's `{visible && (...)}` unmount and an app
 * restart. When `enabled` is false (the in-workout live/review chat, which is
 * intentionally ephemeral and re-seeded on every open), the hook degrades to a
 * plain useState seeded with the starter and never touches disk.
 *
 * Load race handling: the initial render seeds from whatever is already in the
 * in-memory store (instant on a re-open), then an effect hydrates from disk and
 * adopts the stored active conversation IF the user hasn't started typing yet.
 * Write-through is gated on `hydrated` so the lone starter can never clobber
 * stored history during that window.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  CoachChatMessage,
  CoachConversationSummary,
  deleteConversation as deleteStoredConversation,
  getActiveConversationId,
  getActiveMessages,
  hydrateCoachConversations,
  isCoachStoreHydrated,
  listConversations,
  saveActiveMessages,
  setActiveConversation,
  startNewConversation,
} from '@/lib/coachConversations';

export interface UseCoachConversationReturn {
  messages: CoachChatMessage[];
  setMessages: Dispatch<SetStateAction<CoachChatMessage[]>>;
  /** Call when the user sends their first turn, so a late disk hydrate can't
   *  overwrite the in-progress conversation with a stale stored one. */
  markStarted: () => void;
  /** Reset to a fresh conversation (the "New chat" action). */
  startNewChat: () => void;
  /** Past chats, newest first. Empty when persistence is disabled. */
  conversations: CoachConversationSummary[];
  /** Id of the conversation on screen, null before its first send. */
  activeId: string | null;
  /** Switch the screen to a stored conversation. */
  openConversation: (id: string) => void;
  /** Delete a stored conversation. Deleting the active one resets to the starter. */
  deleteConversation: (id: string) => void;
  /**
   * Write a message list into the open conversation right now, outside React.
   * Stop calls this so a reply cut short is saved to the chat it belongs to
   * even when a switch (new chat, open a past one) follows in the same tap:
   * the switch replaces state in the same batch, so the cut-short text would
   * never reach the write-through effect.
   */
  persistMessages: (list: CoachChatMessage[]) => void;
}

export function useCoachConversation(opts: {
  userId: string | null;
  enabled: boolean;
  makeStarter: () => CoachChatMessage;
}): UseCoachConversationReturn {
  const { userId, enabled, makeStarter } = opts;
  // Keep makeStarter in a ref so it doesn't need to be a stable callback at the
  // call site and never re-triggers effects.
  const makeStarterRef = useRef(makeStarter);
  makeStarterRef.current = makeStarter;

  const [messages, setMessages] = useState<CoachChatMessage[]>(() => {
    if (enabled) {
      const stored = getActiveMessages(userId);
      if (stored && stored.length) return stored;
    }
    return [makeStarter()];
  });
  const [hydrated, setHydrated] = useState<boolean>(
    () => !enabled || isCoachStoreHydrated(userId),
  );
  const startedRef = useRef(false);
  // Bumped by open / delete / new so the derived `conversations` list and
  // `activeId` re-read the module store, which React can't see change.
  const [storeVersion, setStoreVersion] = useState(0);

  // Hydrate from disk, then adopt the stored active conversation unless the user
  // has already started typing into the fresh starter.
  useEffect(() => {
    if (!enabled) {
      setHydrated(true);
      return;
    }
    let cancelled = false;
    (async () => {
      await hydrateCoachConversations(userId);
      if (cancelled) return;
      if (!startedRef.current) {
        const stored = getActiveMessages(userId);
        if (stored && stored.length) setMessages(stored);
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, enabled]);

  // Write-through, only after hydration so we never persist the lone starter
  // over stored history during the load race.
  useEffect(() => {
    if (!enabled || !hydrated) return;
    saveActiveMessages(userId, messages);
  }, [messages, enabled, hydrated, userId]);

  const markStarted = useCallback(() => {
    startedRef.current = true;
  }, []);

  const startNewChat = useCallback(() => {
    if (enabled) startNewConversation(userId);
    startedRef.current = false;
    setMessages([makeStarterRef.current()]);
    setStoreVersion((v) => v + 1);
  }, [enabled, userId]);

  const openConversation = useCallback((id: string) => {
    if (!enabled) return;
    const stored = setActiveConversation(userId, id);
    if (!stored) return;
    // Same lock as markStarted: a late hydrate must not replace what the user
    // just chose to look at.
    startedRef.current = true;
    setMessages(stored.length ? stored : [makeStarterRef.current()]);
    setStoreVersion((v) => v + 1);
  }, [enabled, userId]);

  const deleteConversation = useCallback((id: string) => {
    if (!enabled) return;
    const wasActive = getActiveConversationId(userId) === id;
    deleteStoredConversation(userId, id);
    if (wasActive) {
      startedRef.current = false;
      setMessages([makeStarterRef.current()]);
    }
    setStoreVersion((v) => v + 1);
  }, [enabled, userId]);

  const persistMessages = useCallback((list: CoachChatMessage[]) => {
    // Same gate as the write-through: before hydration this would clobber the
    // stored conversation with whatever is on screen.
    if (!enabled || !hydrated) return;
    saveActiveMessages(userId, list);
  }, [enabled, hydrated, userId]);

  // `messages` is a dependency on purpose: the active conversation's title and
  // position come from what was last saved, and the write-through above runs
  // on every messages change.
  const conversations = useMemo(
    () => (enabled && hydrated ? listConversations(userId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, hydrated, userId, messages, storeVersion],
  );
  const activeId = enabled ? getActiveConversationId(userId) : null;

  return {
    messages, setMessages, markStarted, startNewChat,
    conversations, activeId, openConversation, deleteConversation, persistMessages,
  };
}
