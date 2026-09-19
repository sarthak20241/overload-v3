/**
 * Which pile a Drona card sits in on the From Drona screen, and whether its
 * Undo is still live. Pure: no imports, so Deno can test it (dronaInbox.test.ts).
 *
 *   waiting  pending and not past its expiry: the buttons still work
 *   done     answered, or pending but expired (last week's numbers)
 *
 * A card the user pushed to Later expires at the end of ITS week (the server
 * sets expires_at in the user's zone, migration 0127). One that was never
 * answered and never deferred has no expiry and simply waits.
 */

export interface InboxCard {
  id: string;
  kind: string;
  status: string;
  payload: { action?: string };
  deferred_at?: string | null;
  expires_at?: string | null;
  decided_at?: string | null;
  created_at?: string | null;
}

export type Bucket = 'waiting' | 'done';

/** How long an applied swap can be put back. */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function isExpired(card: InboxCard, nowMs: number): boolean {
  const at = ms(card.expires_at);
  return at != null && at <= nowMs;
}

export function bucketOf(card: InboxCard, nowMs: number): Bucket {
  if (card.status !== 'pending') return 'done';
  return isExpired(card, nowMs) ? 'done' : 'waiting';
}

export function waitingCount(cards: InboxCard[], nowMs: number): number {
  return cards.filter((c) => bucketOf(c, nowMs) === 'waiting').length;
}

/**
 * A swap that landed can be put back for seven days. Two shapes land:
 *   act    the user tapped "Make it the plan": status applied, at decided_at
 *   notice Drona applied it itself and the card is still pending: the swap
 *          happened when the card was written, at created_at
 * A dismissed card was already undone, or never applied, so nothing to put back.
 */
export function canUndo(card: InboxCard, nowMs: number): boolean {
  const action = card.payload?.action;
  let at: number | null = null;
  if ((action === 'apply_swap' || action === 'apply_targets') && card.status === 'applied') at = ms(card.decided_at);
  else if (action === 'undo_swap' && card.status === 'pending') at = ms(card.created_at);
  return at != null && nowMs - at <= UNDO_WINDOW_MS;
}
