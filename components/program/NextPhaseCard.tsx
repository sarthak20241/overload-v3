/**
 * The next phase, before it starts (rules in lib/phaseBuildRules.ts).
 *
 * - Pro: in the last NEXT_PHASE_LEAD_DAYS of a phase, the next one is built in
 *   the background as a DRAFT (lib/phaseBuild.ts requestPhasePlan). Nothing is
 *   saved: the card then says it is ready and opens the draft to review, talk
 *   through with Drona, and save.
 * - Free: the card says the phase is coming and that Pro builds it.
 * - A draft already waiting (built here, or by the user and never saved) is
 *   offered for review to everyone.
 *
 * Inline on the dashboard while there is something to do or wait on (building,
 * a failed build, the Pro upsell). Once the phase is READY it leaves the
 * dashboard (owner's call, 2026-10-31): it pops up once like a Drona card,
 * and then waits behind the bell (lib/readyInbox) until it is saved. Later
 * flies the card into the bell, so the user sees where it went.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
import { DronaMark } from '@/components/coach/DronaMark';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { daysBetweenISO, todayLocalISO, type ActiveProgram } from '@/lib/programData';
import { onPhaseDraftChange, phasesWithDrafts, readPhaseDraft } from '@/lib/phaseDraft';
import { readyInbox } from '@/lib/readyInbox';
import { DronaCardPopup } from '@/components/coach/DronaCardPopup';
import type { SavedDronaCard } from '@/lib/dronaCard';
import { requestPhasePlan } from '@/lib/phaseBuild';
import {
  autoBuildKey,
  mayAutoBuild,
  nextPhaseActionFor,
  nextPhaseSnoozeKey,
  NEXT_PHASE_SNOOZE_MS,
  parseAutoBuildRecord,
  startsInText,
} from '@/lib/phaseBuildRules';

interface Props {
  /** Spacing around the card; nothing is drawn (or spaced) when it hides. */
  containerStyle?: StyleProp<ViewStyle>;
  program: ActiveProgram | null;
  isPro: boolean;
  /** False while access is still loading: no build may start on a guess. */
  accessKnown: boolean;
  getToken: ((opts?: { skipCache?: boolean }) => Promise<string | null>) | null;
  /** Open the phase's draft (or its build) on the Goal screen. */
  onReview: (seq: number) => void;
  onUpgrade: () => void;
  /** False while something else holds the screen: the ready popup waits. */
  popupAllowed: boolean;
}

// The ready popup shows once per phase; after that the phase waits in the bell.
const readyPoppedKey = (phaseId: string) => `phase_ready_popped_v1:${phaseId}`;

export function NextPhaseCard({ containerStyle, program, isPro, accessKnown, getToken, onReview, onUpgrade, popupAllowed }: Props) {
  const { C } = useTheme();
  const [draftIds, setDraftIds] = useState<Set<string> | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildFailed, setBuildFailed] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(null);

  const unbuiltIds = program ? program.phases.filter((p) => p.routines.length === 0).map((p) => p.id).join(',') : '';
  const refreshDrafts = useCallback(() => {
    if (!unbuiltIds) { setDraftIds(new Set()); return; }
    phasesWithDrafts(unbuiltIds.split(',')).then(setDraftIds);
  }, [unbuiltIds]);
  useEffect(() => { refreshDrafts(); }, [refreshDrafts]);
  useEffect(() => onPhaseDraftChange(() => refreshDrafts()), [refreshDrafts]);

  const action = program && draftIds && accessKnown
    ? nextPhaseActionFor({
        ready: true,
        isPro,
        phases: program.phases.map((p) => ({
          id: p.id,
          seq: p.seq,
          name: p.name,
          start_offset_weeks: p.start_offset_weeks,
          duration_weeks: p.duration_weeks,
          routineCount: p.routines.length,
        })),
        currentPhaseSeq: program.currentPhaseSeq,
        daysIntoProgram: daysBetweenISO(program.start_date, todayLocalISO()),
        draftPhaseIds: draftIds,
      })
    : null;
  const targetId = action?.phase.id ?? null;

  useEffect(() => {
    if (!targetId) { setSnoozedUntil(null); return; }
    let alive = true;
    AsyncStorage.getItem(nextPhaseSnoozeKey(targetId))
      .then((raw) => { if (alive) setSnoozedUntil(raw ? parseInt(raw, 10) + NEXT_PHASE_SNOOZE_MS : null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [targetId]);

  // The background build: once per phase, within the retry budget. The try is
  // written down BEFORE the call, so a crash mid-build still counts it.
  const buildingFor = useRef<string | null>(null);
  useEffect(() => {
    if (action?.kind !== 'auto_build' || !getToken || !program) return;
    const phase = program.phases.find((p) => p.id === action.phase.id);
    if (!phase || buildingFor.current === phase.id) return;
    buildingFor.current = phase.id;
    // Not cancelled when the dashboard re-reads the program (a new `program`
    // object re-runs this effect): the build is already paid for and runs
    // once, so its ending must always land, or the card says "Building"
    // forever. Only an unmounted card ignores it.
    (async () => {
      const key = autoBuildKey(phase.id);
      const rec = parseAutoBuildRecord(await AsyncStorage.getItem(key).catch(() => null));
      if (!mayAutoBuild(rec, Date.now())) { if (mounted.current) setBuildFailed(true); return; }
      await AsyncStorage.setItem(key, JSON.stringify({ tries: rec.tries + 1, lastAt: Date.now() })).catch(() => {});
      if (mounted.current) setBuilding(true);
      const plan = await requestPhasePlan({ phase, getToken, watching: () => watchingRef.current });
      if (!mounted.current) return;
      setBuilding(false);
      if (!plan) setBuildFailed(true);
      // Success lands through the draft store's change event.
    })();
  }, [action?.kind, action?.phase.id, getToken, program]);
  // Read when the build ends: the ready popup can show then, so no banner too.
  const watchingRef = useRef(popupAllowed);
  watchingRef.current = popupAllowed;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Ready: has this phase's popup been shown already, and how many workouts
  // does its draft hold (the popup's one number).
  const readyId = action?.kind === 'review' ? action.phase.id : null;
  const [ready, setReady] = useState<{ id: string; popped: boolean; workouts: number } | null>(null);
  useEffect(() => {
    if (!readyId) { setReady(null); return; }
    let alive = true;
    Promise.all([
      AsyncStorage.getItem(readyPoppedKey(readyId)).catch(() => null),
      readPhaseDraft(readyId),
    ]).then(([popped, draft]) => {
      if (alive) setReady({ id: readyId, popped: popped != null, workouts: draft?.plan.workouts.length ?? 0 });
    });
    return () => { alive = false; };
  }, [readyId]);

  const kind = action?.kind ?? null;
  const shown = action != null && !(snoozedUntil != null && Date.now() < snoozedUntil);
  useEffect(() => {
    if (shown && kind) track('next_phase_card_shown', { kind, phase_seq: action?.phase.seq ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, kind, targetId]);

  if (!action) return null;
  const name = action.phase.name;

  if (action.kind === 'review') {
    if (!ready || ready.id !== action.phase.id || ready.popped || !popupAllowed) return null;
    const label = `Phase ${action.phase.seq + 1}`;
    const days = action.startsInDays;
    // Put in the bell, and the popup is spent: Review and Later both do it.
    const file = () => {
      void AsyncStorage.setItem(readyPoppedKey(action.phase.id), String(Date.now())).catch(() => {});
      setReady({ ...ready, popped: true });
      readyInbox.add({
        id: `phase:${action.phase.id}`,
        title: `${label} is ready`,
        body: `${name}. I built its workouts. Look them over, change anything with me, then save.`,
        target: { route: `/goal-plan?build=phase&seq=${action.phase.seq}&auto=1` },
        // Opening it and backing out unsaved must not lose it: it goes when
        // the draft is saved or dropped (CoachSheetHost).
        keepUntilDone: true,
      });
    };
    const card: SavedDronaCard = {
      id: `phase-${action.phase.id}`,
      week_start: '',
      slot: 'moment',
      kind: 'act',
      topic: 'phase_ready',
      title: `${label} is ready`,
      body: `${name} ${startsInText(days, action.running)}. I built its workouts. Look them over, change anything with me, then save.`,
      evidence: [
        ...(ready.workouts > 0 ? [{ label: ready.workouts === 1 ? 'workout' : 'workouts', value: String(ready.workouts) }] : []),
        action.running || days <= 0
          ? { label: action.running ? 'under way' : 'starts today', value: 'Now' }
          : { label: days === 1 ? 'day to go' : 'days to go', value: String(days) },
      ],
      payload: {},
      status: 'pending',
      deferred_at: null,
      expires_at: null,
      decided_at: null,
      created_at: null,
    };
    return (
      <DronaCardPopup
        card={card}
        kicker="DRONA BUILT"
        primaryLabel="Review and save"
        secondary={null}
        onAct={() => {
          haptics.tap();
          track('next_phase_card_tapped', { kind: 'review', phase_seq: action.phase.seq });
          file();
          onReview(action.phase.seq);
        }}
        onDismiss={() => {}}
        onUndo={() => {}}
        onLater={() => {
          track('next_phase_ready_later', { phase_seq: action.phase.seq });
          file();
        }}
      />
    );
  }

  if (!shown) return null;
  const when = startsInText(action.startsInDays, action.running);
  const label = `Phase ${action.phase.seq + 1}`;

  let title: string;
  let body: string;
  let cta: string | null;
  let onPress: (() => void) | null;
  if (action.kind === 'auto_build') {
    if (building || !buildFailed) {
      title = `Building ${label}`;
      body = `${name} ${when}. I am putting its workouts together now.`;
      cta = null;
      onPress = null;
    } else {
      title = action.running ? `${label} has no workouts` : `${label} ${when}`;
      body = `${name} ${when}. Build its workouts with me in a minute.`;
      cta = 'Build it';
      onPress = () => onReview(action.phase.seq);
    }
  } else {
    title = action.running ? `${label} has no workouts` : `${label} ${when}`;
    body = `${name} ${when}. Pro builds its workouts for you, fitted to how phase ${action.phase.seq} went.`;
    cta = 'See Pro';
    onPress = onUpgrade;
  }

  const later = () => {
    haptics.tick();
    const now = Date.now();
    setSnoozedUntil(now + NEXT_PHASE_SNOOZE_MS);
    AsyncStorage.setItem(nextPhaseSnoozeKey(action.phase.id), String(now)).catch(() => {});
  };

  return (
    <View style={containerStyle}>
    <View style={[s.card, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
      <View style={s.head}>
        <View style={[s.mark, { backgroundColor: C.muted }]}>
          <DronaMark size={11} state={cta ? 'static' : 'thinking'} />
        </View>
        <Text style={[s.title, { color: C.foreground }]} numberOfLines={1}>{title}</Text>
      </View>
      <Text style={[s.body, { color: C.mutedFg }]}>{body}</Text>
      {cta && onPress && (
        <View style={s.actions}>
          <Pressable
            onPress={() => { haptics.tap(); track('next_phase_card_tapped', { kind: action.kind, phase_seq: action.phase.seq }); onPress(); }}
            style={({ pressed }) => [s.primary, { backgroundColor: Colors.primary, opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="button"
          >
            <Text style={[s.primaryText, { color: Colors.primaryFg }]}>{cta}</Text>
          </Pressable>
          <Pressable onPress={later} hitSlop={8} accessibilityRole="button" accessibilityLabel="Not now">
            <Text style={[s.later, { color: C.mutedFg }]}>Not now</Text>
          </Pressable>
        </View>
      )}
    </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: Spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  mark: { width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: FontSize.md, fontWeight: FontWeight.bold, flexShrink: 1 },
  body: { fontSize: FontSize.xs, lineHeight: 17 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 12 },
  primary: { height: 36, borderRadius: Radius.md, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  later: { fontSize: FontSize.xs, fontWeight: FontWeight.medium },
});
