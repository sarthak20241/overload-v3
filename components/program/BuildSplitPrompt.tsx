/**
 * "Your program is ready. Now let's build week one."
 *
 * Onboarding hands out the PROGRAM (the phase-by-phase road) and stops there.
 * The concrete week of workouts is built afterwards by Drona, from the Goal
 * screen, so it is written against a real user id instead of a guest blob.
 * This is the one nudge that closes that gap.
 *
 * Drawn as a Drona card (components/coach/DronaCardPopup), the same popup as
 * the week's card and the next phase, so everything Drona brings up reads as
 * one family. Later on a built phase 1 files it behind the bell, like the next
 * phase, so the way back is where the card flew.
 *
 * The decision of WHETHER to show is in lib/splitPrompt (pure, tested); this
 * file owns the storage and the words.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DronaCardPopup } from '@/components/coach/DronaCardPopup';
import type { SavedDronaCard } from '@/lib/dronaCard';
import { readPhaseDraft } from '@/lib/phaseDraft';
import { readyInbox } from '@/lib/readyInbox';
import { splitPromptFor, splitPromptSnoozeKey, type SplitPromptAction } from '@/lib/splitPrompt';

/** The words for each ask, in Drona's voice. */
const WORDS: Record<NonNullable<SplitPromptAction>, { kicker: string; title: string; body: string; cta: string }> = {
  review: {
    kicker: 'DRONA BUILT',
    title: 'Your phase 1 is waiting',
    body: 'I built your phase 1 workouts and kept them for you. Look them over, change anything with me, then save.',
    cta: 'Review and save',
  },
  build: {
    kicker: 'DRONA PLANNED',
    title: 'Your program is ready',
    body: 'I have your phases mapped out. Now let me build the actual workouts for phase one, so you know exactly what to do on day one.',
    cta: 'Build phase 1',
  },
  signin: {
    kicker: 'DRONA ASKS',
    title: 'Save your program',
    body: 'I mapped out every phase for you, but without an account it will not be here tomorrow. Sign in and I will keep it, then build your first week.',
    cta: 'Sign in to save it',
  },
};

interface Props {
  /** False while auth or the program query is still settling. */
  ready: boolean;
  onboardingDone: boolean;
  isGuest: boolean;
  hasProgram: boolean;
  /** Routines linked to the current phase; null until loaded. */
  phaseRoutineCount: number | null;
  /** A built, unsaved plan for this phase waits on the device (lib/phaseDraft.ts). */
  hasDraft?: boolean;
  /** The phase being asked about. Its id scopes "Not now"; null for a guest. */
  phaseId: string | null;
  /** Signed in: open the Goal screen on phase 1's build flow. */
  onBuild: () => void;
  /** Guest: send them to sign-in so the program has somewhere to land. */
  onSignIn: () => void;
  /** Fires as the popup appears and goes, so the dashboard can hold any other popup back. */
  onVisibleChange?: (visible: boolean) => void;
}

export function BuildSplitPrompt(props: Props) {
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Session-only. Tapping Build or Sign in hides the ask for as long as this
  // screen lives; nothing is written down, because the real "done" is the
  // phase actually having routines, and the dashboard re-reads that on focus.
  // An abandoned builder gets asked again next launch, which is the point.
  const [answered, setAnswered] = useState(false);
  const snoozeKey = splitPromptSnoozeKey(props.phaseId);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setDismissedAt(null);
    // A different phase is a different question; a Build tap on the old one
    // says nothing about it.
    setAnswered(false);
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(snoozeKey);
        if (!alive) return;
        const n = raw ? parseInt(raw, 10) : NaN;
        setDismissedAt(Number.isFinite(n) ? n : null);
      } catch {
        /* no stored answer reads the same as never asked */
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [snoozeKey]);

  const action: SplitPromptAction = answered
    ? null
    : splitPromptFor({
        ready: props.ready && loaded,
        onboardingDone: props.onboardingDone,
        isGuest: props.isGuest,
        hasProgram: props.hasProgram,
        phaseRoutineCount: props.phaseRoutineCount,
        hasDraft: props.hasDraft,
        dismissedAt,
        nowMs: Date.now(),
      });
  const visible = action != null;
  // Layout effect, not a passive one: the dashboard must know BEFORE paint,
  // or a pending Drona card and this prompt can share one frame.
  const { onVisibleChange } = props;
  useLayoutEffect(() => {
    onVisibleChange?.(visible);
  }, [visible, onVisibleChange]);

  // How many workouts the waiting draft holds: the card's one number.
  const [draftWorkouts, setDraftWorkouts] = useState<number | null>(null);
  const { phaseId, hasDraft } = props;
  useEffect(() => {
    setDraftWorkouts(null);
    if (!phaseId || !hasDraft) return;
    let alive = true;
    void readPhaseDraft(phaseId).then((d) => {
      if (alive) setDraftWorkouts(d?.plan.workouts.length ?? null);
    });
    return () => { alive = false; };
  }, [phaseId, hasDraft]);

  const later = useCallback(() => {
    const now = Date.now();
    setDismissedAt(now);
    AsyncStorage.setItem(snoozeKey, String(now)).catch(() => {});
    // A built phase 1 waits behind the bell until it is saved or dropped
    // (CoachSheetHost clears the item once the draft is gone).
    if (action === 'review' && phaseId) {
      readyInbox.add({
        id: `phase:${phaseId}`,
        title: WORDS.review.title,
        body: WORDS.review.body,
        target: { route: '/goal-plan?build=phase&auto=1' },
        keepUntilDone: true,
      });
    }
  }, [snoozeKey, action, phaseId]);

  const go = useCallback(() => {
    setAnswered(true);
    if (action === 'signin') props.onSignIn();
    else props.onBuild();
  }, [action, props]);

  if (!action) return null;
  const words = WORDS[action];
  const card: SavedDronaCard = {
    id: `split-${action}-${phaseId ?? 'guest'}`,
    week_start: '',
    slot: 'moment',
    kind: 'act',
    topic: 'phase_build',
    title: words.title,
    body: words.body,
    evidence: action === 'review' && draftWorkouts
      ? [{ label: draftWorkouts === 1 ? 'workout' : 'workouts', value: String(draftWorkouts) }]
      : [],
    payload: {},
    status: 'pending',
    deferred_at: null,
    expires_at: null,
    decided_at: null,
    created_at: null,
  };
  return (
    <DronaCardPopup
      // A new ask is a new card: the popup's Later state starts fresh.
      key={card.id}
      card={card}
      kicker={words.kicker}
      primaryLabel={words.cta}
      secondary={null}
      // Only a built phase 1 is filed behind the bell; the others just fade.
      flyToBell={action === 'review'}
      onAct={go}
      onDismiss={() => {}}
      onUndo={() => {}}
      onLater={later}
    />
  );
}
