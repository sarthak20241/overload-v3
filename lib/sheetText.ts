/**
 * The text model behind components/ui/SheetTextInput: which text the box
 * shows when its owner's value reaches it late through <Portal>.
 *
 * The box shows what the user typed at once. The owner's value comes back
 * later, and is one of:
 *   - an echo: a value typed here that the owner has caught up to. Ignore it.
 *   - stale: the owner rendered before it saw the latest keystroke. Ignore it.
 *   - its own: a reset, a seed, or a filtered value ("12a" kept as "12"). Show it.
 *
 * Stale and filtered can carry the same value, so they are told apart by time.
 * Each keystroke is stamped with the box's commit count. The owner's render can
 * only lag by the commit in which that keystroke landed; a value that arrives
 * after that commit, and does not match anything typed, is the owner's own.
 */

export type SheetText = {
  text: string;
  /** Typed values sent to the owner and not echoed back yet, oldest first. */
  pending: { value: string; commit: number }[];
  /** How many commits the box has had. */
  commit: number;
};

/**
 * How far the owner may fall behind. Past this the oldest keystroke is
 * forgotten, and its late echo would read as the owner's own value and put
 * old text back. 64 keystrokes ahead of the owner does not happen in practice.
 */
export const SHEET_TEXT_MAX_PENDING = 64;

export function sheetTextInit(external: string): SheetText {
  return { text: external, pending: [], commit: 0 };
}

/** The user typed `t`; it goes to the owner now and comes back later. */
export function sheetTextTyped(s: SheetText, t: string): SheetText {
  const pending = [...s.pending, { value: t, commit: s.commit }];
  if (pending.length > SHEET_TEXT_MAX_PENDING) pending.shift();
  return { ...s, text: t, pending };
}

/** The owner rendered, handing down `external`. */
export function sheetTextOwnerRendered(s: SheetText, external: string): SheetText {
  // Match from the newest: if a value was typed twice (typed "a", deleted to
  // "", typed "a"), the echo is the latest one, and everything older goes.
  let i = -1;
  for (let k = s.pending.length - 1; k >= 0; k--) {
    if (s.pending[k].value === external) { i = k; break; }
  }
  if (i >= 0) return { ...s, pending: s.pending.slice(i + 1) };
  // Typed in this very commit: the owner may not have seen it yet.
  if (s.pending.some((p) => p.commit === s.commit)) return s;
  if (s.pending.length === 0 && external === s.text) return s;
  return { ...s, text: external, pending: [] };
}

/** The box committed a render. */
export function sheetTextCommitted(s: SheetText): SheetText {
  return { ...s, commit: s.commit + 1 };
}
