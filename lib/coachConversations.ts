/**
 * Local persistence for Coach Drona chat conversations.
 *
 * The coach chat used to live only in ChatScreen's useState, so closing the
 * sheet (or tapping back to the menu) unmounted the component and threw the
 * whole conversation away. This store moves conversations to module scope,
 * keyed per Clerk user id and backed by AsyncStorage, so they survive the
 * `{visible && (...)}` unmount and an app restart.
 *
 * The discipline mirrors hooks/useCoachAccess.ts (module-scope cache keyed by
 * userId, reset on sign-out) and lib/localCache.ts (per-user AsyncStorage with
 * an in-memory layer). Guests persist locally too, under the 'guest' key.
 *
 * Phase 0 is local-only. The conversation `id` is minted with newClientId() so
 * it lines up with the server row when cloud sync (Phase 1) lands.
 *
 * NOTE: the in-workout coach chat (live / review) is intentionally NOT persisted
 * here — its session recap is rebuilt on every open, so the caller passes
 * `enabled: false` to useCoachConversation and bypasses this store entirely.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { newClientId } from '@/lib/syncQueue';

export interface CoachCitation {
  n: number;
  id: string;
  title: string;
  authors: string[];
  year?: number;
  url?: string;
}

export interface CoachChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: CoachCitation[];
  // Transient UI state while the assistant placeholder waits on first token.
  // Never persisted (stripped on save).
  thinkingPhase?: string;
}

export interface CoachConversation {
  id: string;
  /** First-user-message snippet; '' until the user sends their first turn. */
  title: string;
  mode: 'chat';
  messages: CoachChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface UserStore {
  activeId: string | null;
  conversations: Record<string, CoachConversation>;
}

const SCHEMA = 1 as const;
const TITLE_MAX = 60;
// Keep the on-disk store bounded. Phase 0 has no history list, so old
// conversations would otherwise accumulate forever.
const MAX_CONVERSATIONS = 50;
const PERSIST_DEBOUNCE_MS = 600;

const KEY = (storeKey: string) => `coach_convos_v1::${storeKey}`;

// userId is the Clerk id, or null for guests. Guests get their own slot.
function storeKeyFor(userId: string | null): string {
  return userId ?? 'guest';
}

// --- per-user store (AsyncStorage-backed, in-memory cache) ---
const _mem: Record<string, UserStore> = {};
const _hydrated: Record<string, boolean> = {};
const _lastSavedCount: Record<string, number> = {};
const _persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function emptyStore(): UserStore {
  return { activeId: null, conversations: {} };
}

function getStore(storeKey: string): UserStore {
  return (_mem[storeKey] ??= emptyStore());
}

function newConversation(): CoachConversation {
  const now = Date.now();
  return {
    id: newClientId(),
    title: '',
    mode: 'chat',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

// Strip transient fields and the empty streaming placeholder before persisting.
// A mid-stream app kill then restores up to the last real turn, never a blank
// assistant bubble.
function sanitize(messages: CoachChatMessage[]): CoachChatMessage[] {
  return messages
    .filter((m) => !(m.role === 'assistant' && m.content.trim() === ''))
    .map(({ thinkingPhase, ...rest }) => rest);
}

function evictOldest(store: UserStore): void {
  const ids = Object.keys(store.conversations);
  if (ids.length <= MAX_CONVERSATIONS) return;
  const sorted = ids
    .map((id) => store.conversations[id])
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const convo of sorted.slice(MAX_CONVERSATIONS)) {
    if (convo.id === store.activeId) continue; // never evict the active one
    delete store.conversations[convo.id];
  }
}

function persistNow(storeKey: string): void {
  const timer = _persistTimers[storeKey];
  if (timer) {
    clearTimeout(timer);
    delete _persistTimers[storeKey];
  }
  const payload = { schema: SCHEMA, store: _mem[storeKey] ?? emptyStore() };
  AsyncStorage.setItem(KEY(storeKey), JSON.stringify(payload)).catch(() => {});
}

function schedulePersist(storeKey: string): void {
  if (_persistTimers[storeKey]) return;
  _persistTimers[storeKey] = setTimeout(() => {
    delete _persistTimers[storeKey];
    persistNow(storeKey);
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Load a user's conversations from disk into memory. Idempotent; only the first
 * call per user hits disk. Call (and await) before relying on getActiveMessages
 * for a cold start.
 */
export async function hydrateCoachConversations(userId: string | null): Promise<void> {
  const storeKey = storeKeyFor(userId);
  if (_hydrated[storeKey]) return;
  try {
    const raw = await AsyncStorage.getItem(KEY(storeKey));
    if (raw) {
      const parsed = JSON.parse(raw) as { schema?: number; store?: UserStore };
      // Don't clobber anything written in memory before hydration finished.
      if (parsed?.schema === SCHEMA && parsed.store && !_mem[storeKey]) {
        _mem[storeKey] = parsed.store;
      }
    }
  } catch {
    // corrupt / missing → leave unset, start fresh
  } finally {
    _hydrated[storeKey] = true;
    _mem[storeKey] ??= emptyStore();
  }
}

export function isCoachStoreHydrated(userId: string | null): boolean {
  return !!_hydrated[storeKeyFor(userId)];
}

/** Messages of the active conversation, or null if there isn't one yet. */
export function getActiveMessages(userId: string | null): CoachChatMessage[] | null {
  const store = _mem[storeKeyFor(userId)];
  if (!store || !store.activeId) return null;
  return store.conversations[store.activeId]?.messages ?? null;
}

/**
 * Write the full message array into the active conversation, creating one if
 * needed. Sets the title from the first user message. Persists immediately when
 * a message is added/removed (count change), otherwise debounces (streaming
 * text growth coalesces into one disk write).
 */
export function saveActiveMessages(userId: string | null, messages: CoachChatMessage[]): void {
  const storeKey = storeKeyFor(userId);
  const store = getStore(storeKey);

  let id = store.activeId;
  if (!id || !store.conversations[id]) {
    const convo = newConversation();
    id = convo.id;
    store.activeId = id;
    store.conversations[id] = convo;
  }
  const convo = store.conversations[id];

  const clean = sanitize(messages);
  convo.messages = clean;
  convo.updatedAt = Date.now();
  if (!convo.title) {
    const firstUser = clean.find((m) => m.role === 'user');
    if (firstUser) convo.title = snippet(firstUser.content);
  }
  evictOldest(store);

  const prevCount = _lastSavedCount[storeKey] ?? -1;
  _lastSavedCount[storeKey] = clean.length;
  if (clean.length !== prevCount) persistNow(storeKey);
  else schedulePersist(storeKey);
}

/**
 * Start a fresh conversation and make it active. The previous one stays in the
 * store (it's already saved) so a future history list can show it.
 */
export function startNewConversation(userId: string | null): CoachConversation {
  const storeKey = storeKeyFor(userId);
  const store = getStore(storeKey);
  const convo = newConversation();
  store.activeId = convo.id;
  store.conversations[convo.id] = convo;
  _lastSavedCount[storeKey] = 0;
  persistNow(storeKey);
  return convo;
}

/**
 * Return the active conversation id, creating an empty active conversation if
 * none exists yet. Used at send time so the edge function can mirror the turn
 * into the right server-side conversation row (Phase 1).
 */
export function ensureActiveConversationId(userId: string | null): string {
  const storeKey = storeKeyFor(userId);
  const store = getStore(storeKey);
  if (!store.activeId || !store.conversations[store.activeId]) {
    const convo = newConversation();
    store.activeId = convo.id;
    store.conversations[convo.id] = convo;
    schedulePersist(storeKey);
  }
  return store.activeId;
}

/** Drop a user's conversations from memory + disk (sign-out / account switch). */
export async function clearCoachConversations(userId: string | null): Promise<void> {
  const storeKey = storeKeyFor(userId);
  delete _mem[storeKey];
  delete _hydrated[storeKey];
  delete _lastSavedCount[storeKey];
  const timer = _persistTimers[storeKey];
  if (timer) {
    clearTimeout(timer);
    delete _persistTimers[storeKey];
  }
  try {
    await AsyncStorage.removeItem(KEY(storeKey));
  } catch {
    // ignore
  }
}
