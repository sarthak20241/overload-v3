/**
 * Rules for building a program phase's workouts, kept pure so `deno test`
 * reaches them (no imports). Storage lives in lib/phaseDraft.ts, the request
 * in lib/phaseBuild.ts, the words in the components.
 *
 * Two jobs:
 *
 * 1. The DRAFT. A built phase plan is held on the device until the user taps
 *    Save. Before this, a plan lived only in the coach sheet's state, so
 *    closing the sheet, going back, or hitting the paywall on Refine threw it
 *    away (3 of 5 free phase-1 builds were lost that way, 2026-10-31). A draft
 *    survives all of that and is shown again the next time the phase is opened.
 *
 * 2. The NEXT PHASE. When the running phase is close to its end and the next
 *    one has no workouts, Pro builds it in the background (as a draft the user
 *    still saves) and free users are told it is coming, with the upgrade.
 *    Phase 1 is not handled here: lib/splitPrompt.ts owns that ask.
 */

/** A draft older than this is dropped: the user's training has moved on. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How many days before a phase ends the next one gets built or announced. */
export const NEXT_PHASE_LEAD_DAYS = 5;

/** A failed background build waits this long before it is tried again. */
export const AUTO_BUILD_RETRY_MS = 12 * 60 * 60 * 1000;

/** Background builds per phase, ever. Each one is a paid model call. */
export const AUTO_BUILD_MAX_TRIES = 2;

/** How long "Not now" on the next-phase card holds it back. */
export const NEXT_PHASE_SNOOZE_MS = 2 * 24 * 60 * 60 * 1000;

export interface DraftPlanShape {
  name: string;
  workouts: unknown[];
}

export interface StoredDraft<P extends DraftPlanShape = DraftPlanShape> {
  plan: P;
  builtAt: number;
  /** 'build' = the user's own build; 'auto' = built in the background. */
  source: 'build' | 'auto';
}

/**
 * Read a stored draft back. Anything malformed, empty or stale is null, so a
 * draft written by an older app version can never put a broken card on screen.
 */
export function parseStoredDraft<P extends DraftPlanShape>(raw: string | null, nowMs: number): StoredDraft<P> | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const d = v as { plan?: unknown; builtAt?: unknown; source?: unknown };
  const plan = d.plan as P | undefined;
  if (!plan || typeof plan !== 'object' || typeof plan.name !== 'string') return null;
  if (!Array.isArray(plan.workouts) || plan.workouts.length === 0) return null;
  if (typeof d.builtAt !== 'number' || !Number.isFinite(d.builtAt)) return null;
  // A clock moved backwards reads as fresh, not as expired forever.
  const age = nowMs - d.builtAt;
  if (age > DRAFT_MAX_AGE_MS) return null;
  return { plan, builtAt: d.builtAt, source: d.source === 'auto' ? 'auto' : 'build' };
}

export function phaseDraftKey(phaseId: string): string {
  return `overload:phase_draft::${phaseId}`;
}

export function autoBuildKey(phaseId: string): string {
  return `overload:phase_autobuild::${phaseId}`;
}

export function nextPhaseSnoozeKey(phaseId: string): string {
  return `overload:next_phase_snooze::${phaseId}`;
}

/** What the background builder remembers per phase. */
export interface AutoBuildRecord {
  tries: number;
  lastAt: number;
}

export function parseAutoBuildRecord(raw: string | null): AutoBuildRecord {
  if (!raw) return { tries: 0, lastAt: 0 };
  try {
    const v = JSON.parse(raw) as Partial<AutoBuildRecord>;
    const tries = typeof v.tries === 'number' && v.tries >= 0 ? Math.floor(v.tries) : 0;
    const lastAt = typeof v.lastAt === 'number' && Number.isFinite(v.lastAt) ? v.lastAt : 0;
    return { tries, lastAt };
  } catch {
    return { tries: 0, lastAt: 0 };
  }
}

/** May a background build run for this phase now? */
export function mayAutoBuild(rec: AutoBuildRecord, nowMs: number): boolean {
  if (rec.tries >= AUTO_BUILD_MAX_TRIES) return false;
  if (rec.tries === 0) return true;
  const since = nowMs - rec.lastAt;
  return since < 0 || since >= AUTO_BUILD_RETRY_MS;
}

export interface PhaseLite {
  id: string;
  seq: number;
  name: string;
  start_offset_weeks: number;
  duration_weeks: number;
  routineCount: number;
}

export interface NextPhaseState {
  /** False while the program or access is still loading. */
  ready: boolean;
  /** Paid or trialing: background builds are allowed. */
  isPro: boolean;
  phases: PhaseLite[];
  /** Seq of the phase running today, or null (not started / ended). */
  currentPhaseSeq: number | null;
  /** Whole days since the program's start date (0 on day one). */
  daysIntoProgram: number;
  /** Phase ids with a draft waiting on the device. */
  draftPhaseIds: ReadonlySet<string>;
}

export type NextPhaseAction =
  | { kind: 'review' | 'auto_build' | 'upsell'; phase: PhaseLite; startsInDays: number; running: boolean }
  | null;

/**
 * Which phase after the first needs its workouts, and what to do about it.
 *
 * The target is either the running phase (seq > 0) when it has no workouts,
 * which happens when a phase began before anyone built it, or the next phase
 * once the running one has NEXT_PHASE_LEAD_DAYS or fewer days left.
 * `running` says the target is the phase in progress (it has begun without
 * workouts); `startsInDays` is then 0.
 */
export function nextPhaseActionFor(s: NextPhaseState): NextPhaseAction {
  if (!s.ready || s.currentPhaseSeq == null) return null;
  const phases = [...s.phases].sort((a, b) => a.seq - b.seq);
  const cur = phases.find((p) => p.seq === s.currentPhaseSeq);
  if (!cur) return null;

  let target: PhaseLite | null = null;
  let startsInDays = 0;
  let running = false;
  if (cur.seq > 0 && cur.routineCount === 0) {
    target = cur;
    running = true;
  } else {
    const next = phases.find((p) => p.seq > cur.seq);
    if (!next || next.routineCount > 0) return null;
    const endDay = (cur.start_offset_weeks + cur.duration_weeks) * 7;
    const daysLeft = endDay - s.daysIntoProgram;
    if (daysLeft > NEXT_PHASE_LEAD_DAYS) return null;
    target = next;
    startsInDays = Math.max(0, daysLeft);
  }

  const kind = s.draftPhaseIds.has(target.id) ? 'review' : s.isPro ? 'auto_build' : 'upsell';
  return { kind, phase: target, startsInDays, running };
}

/** "is under way" / "starts today" / "starts tomorrow" / "starts in 3 days". */
export function startsInText(days: number, running = false): string {
  if (running) return 'is under way';
  if (days <= 0) return 'starts today';
  if (days === 1) return 'starts tomorrow';
  return `starts in ${days} days`;
}
