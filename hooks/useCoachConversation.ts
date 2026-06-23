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
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  CoachChatMessage,
  getActiveMessages,
  hydrateCoachConversations,
  isCoachStoreHydrated,
  saveActiveMessages,
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
  }, [enabled, userId]);

  return { messages, setMessages, markStarted, startNewChat };
}
