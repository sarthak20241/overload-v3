/**
 * Where the dashboard's bell is on screen, so a card put off with Later can
 * fly into it (components/coach/DronaCardPopup), and the bell can bump when it
 * lands. The bell registers itself; with no bell mounted, nothing flies.
 */
export type BellPoint = { x: number; y: number };
type Measure = () => Promise<BellPoint | null>;

let measure: Measure | null = null;
const bumpListeners = new Set<() => void>();

export function registerBell(m: Measure): () => void {
  measure = m;
  return () => { if (measure === m) measure = null; };
}

/** The bell's centre in window coordinates, or null when there is no bell. */
export function bellPoint(): Promise<BellPoint | null> {
  return measure ? measure().catch(() => null) : Promise.resolve(null);
}

/** Something just landed in the bell. */
export function bumpBell(): void {
  bumpListeners.forEach((l) => l());
}

export function onBellBump(l: () => void): () => void {
  bumpListeners.add(l);
  return () => { bumpListeners.delete(l); };
}
