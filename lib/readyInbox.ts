/**
 * What waits behind the bell on the dashboard (components/ui/InboxBell).
 *
 * Drona's server cards wait on From Drona already (lib/dronaInbox). This holds
 * the device's own news, the things lib/readyNotice announces:
 * - a coach sheet that finished out of sight (lib/coachSessions),
 * - a phase built in the background, waiting to be reviewed,
 * - a meal parsed, or a training read, on a tab the user had left.
 *
 * An item stays until it is opened, or until what it points at is gone (the
 * sheet was opened another way, the phase was saved). Kept per user on the
 * device. A kept coach sheet dies with the app, so its item is never stored.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReadyTarget } from '@/lib/readyNotice';

export interface InboxItem {
  /** One per thing: `coach:<session>`, `phase:<phaseId>`, `meal`, `insights`. */
  id: string;
  title: string;
  body: string;
  failed?: boolean;
  target: ReadyTarget;
  at: number;
}

const MAX_ITEMS = 20;
const keyFor = (userId: string) => `ready_inbox_v1:${userId}`;

/** What survives a restart: not a kept coach sheet, which does not. */
export function storable(items: InboxItem[]): InboxItem[] {
  return items.filter((i) => !('coachSession' in i.target));
}

/** Parse what was stored. Anything malformed is dropped, not thrown. */
export function parseStored(raw: string | null): InboxItem[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((i): i is InboxItem =>
      i && typeof i.id === 'string' && typeof i.title === 'string' && typeof i.body === 'string'
      && typeof i.at === 'number' && i.target && typeof i.target === 'object');
  } catch {
    return [];
  }
}

export function createReadyInbox(storage: Pick<typeof AsyncStorage, 'getItem' | 'setItem'>) {
  let items: InboxItem[] = [];
  let userId: string | null = null;
  // Whose items are loaded. undefined: nobody's yet.
  let hydratedFor: string | null | undefined;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const save = () => {
    if (userId) void storage.setItem(keyFor(userId), JSON.stringify(storable(items))).catch(() => {});
  };

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    getSnapshot: () => items,

    /** Load the signed-in user's items (null: signed out, nothing shown). */
    async hydrate(id: string | null) {
      // Same user again (a root remount): keep what is here, unsaved sheets too.
      if (hydratedFor !== undefined && id === hydratedFor) return;
      hydratedFor = id;
      userId = id;
      items = [];
      emit();
      if (!id) return;
      const raw = await storage.getItem(keyFor(id)).catch(() => null);
      if (userId !== id) return; // switched again meanwhile
      // Anything added while the read was in flight stays, on top.
      const fresh = items;
      const stored = parseStored(raw).filter((s) => !fresh.some((f) => f.id === s.id));
      items = [...fresh, ...stored].slice(0, MAX_ITEMS);
      emit();
    },

    /** Add, or move to the top with new words. Newest first. */
    add(item: Omit<InboxItem, 'at'> & { at?: number }) {
      const next: InboxItem = { ...item, at: item.at ?? Date.now() };
      items = [next, ...items.filter((i) => i.id !== item.id)].slice(0, MAX_ITEMS);
      save();
      emit();
    },

    remove(id: string) {
      if (!items.some((i) => i.id === id)) return;
      items = items.filter((i) => i.id !== id);
      save();
      emit();
    },

    removeWhere(pred: (i: InboxItem) => boolean) {
      const next = items.filter((i) => !pred(i));
      if (next.length === items.length) return;
      items = next;
      save();
      emit();
    },
  };
}

export const readyInbox = createReadyInbox(AsyncStorage);
