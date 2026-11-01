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
import { openReadyTarget, type ReadyTarget } from '@/lib/readyNotice';

export interface InboxItem {
  /** One per thing: `coach:<session>`, `phase:<phaseId>`, `meal`, `insights`. */
  id: string;
  title: string;
  body: string;
  failed?: boolean;
  target: ReadyTarget;
  at: number;
  /**
   * Opening it does not take it out: it goes when what it points at is done
   * (a phase: when its draft is saved or dropped). Backing out of the screen
   * without saving must not lose the only way back to it.
   */
  keepUntilDone?: boolean;
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

/**
 * A kept coach sheet's item is stale once the sheet is gone (dropped, the app
 * restarted) or showing: the user is looking at the result.
 */
export function isStaleCoachItem(item: InboxItem, sessions: { id: number; visible: boolean }[]): boolean {
  if (!('coachSession' in item.target)) return false;
  const id = item.target.coachSession;
  const s = sessions.find((x) => x.id === id);
  return !s || s.visible;
}

/**
 * Open an item from behind the bell. It leaves the bell as it opens, unless
 * it waits for its work to be done (keepUntilDone).
 */
export function openInboxItem(item: InboxItem, push: (route: string) => void): void {
  if (!item.keepUntilDone) readyInbox.remove(item.id);
  openReadyTarget(item.target, push);
}

export function createReadyInbox(storage: Pick<typeof AsyncStorage, 'getItem' | 'setItem'>) {
  let items: InboxItem[] = [];
  let userId: string | null = null;
  // Whose items are loaded. undefined: nobody's yet.
  let hydratedFor: string | null | undefined;
  // False while the stored list is being read: a save then would overwrite
  // it with only what was added meanwhile.
  let loaded = false;
  // A read of the stored list is in flight.
  let reading = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  // Read the stored list and merge what is in memory on top. A failed read
  // leaves `loaded` false (unread is not empty: never save over it); the next
  // change tries again, so later items are not lost for the whole session.
  const load = async (id: string) => {
    reading = true;
    let readFailed = false;
    const raw = await storage.getItem(keyFor(id)).catch(() => { readFailed = true; return null; });
    reading = false;
    if (userId !== id || readFailed) return; // switched meanwhile, or unread
    // Anything added while the read was in flight stays, on top.
    const fresh = items;
    const stored = parseStored(raw).filter((s) => !fresh.some((f) => f.id === s.id));
    items = [...fresh, ...stored].slice(0, MAX_ITEMS);
    loaded = true;
    // What was added during the read is stored now, with the rest.
    if (fresh.length > 0) save();
    emit();
  };
  const save = () => {
    if (!userId) return;
    if (!loaded) { if (!reading) void load(userId); return; }
    void storage.setItem(keyFor(userId), JSON.stringify(storable(items))).catch(() => {});
  };

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    getSnapshot: () => items,

    /**
     * Load the signed-in user's items. Signed out (null), items live in
     * memory only. Coming from nobody to an account (start-up, while Clerk
     * loads), they are kept and saved under it: a build that ended in that
     * window is this user's news. From one account to another, the last
     * account's items go.
     */
    async hydrate(id: string | null) {
      // Same user again (a root remount): keep what is here, unsaved sheets too.
      if (hydratedFor !== undefined && id === hydratedFor) return;
      const fromNobody = hydratedFor === undefined || hydratedFor === null;
      hydratedFor = id;
      userId = id;
      loaded = false;
      if (!fromNobody || !id) items = [];
      emit();
      if (!id) return;
      await load(id);
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
