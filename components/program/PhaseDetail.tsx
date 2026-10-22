/**
 * The phase card of the phase screen (.planning/phase-metrics/SPEC.md,
 * sections 8 and 9): the numbers-only stepper to switch phases, the name and
 * weeks, the job bar, the no-workouts notice, and Drona's line. The Train /
 * Eat / Recover detail lives on the pillar screens (app/goal-plan-pillar.tsx),
 * reached through the plan rows under this card.
 *
 * Also home to the two small helpers the plan rows and the pillar screens
 * share: which pillar a metric belongs to, and a tracked row's value text.
 */
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
import type { ActiveProgram, ActiveProgramPhaseRow } from '@/lib/programData';
import { defaultJobText, formatMetricValue, heroOf, jobFraction, type MetricKind, type PhaseMetricRow } from '@/lib/phaseMetrics';
import { S, T } from '@/components/program/finish';
import { Colors, FontWeight, colorWithAlpha } from '@/constants/theme';

export type Pillar = 'train' | 'eat' | 'recover';

/** Which pillar a supporting target belongs to. */
export const PILLAR_OF: Record<MetricKind, Pillar> = {
  bodyweight: 'eat',
  lift_e1rm: 'train',
  sets_per_muscle: 'train',
  steps: 'train',
  sessions_per_week: 'train',
  cardio_sessions: 'train',
  sleep_hours: 'recover',
  protein_days: 'eat',
  distance: 'train',
  duration: 'train',
  custom: 'train',
};

/** The value column of a tracked row: the number and what it is of. */
export function rowValue(m: PhaseMetricRow): { value: string; rest: string } {
  const cur = m.current_value;
  if (cur == null) {
    // A source with no data at all: say what would feed it.
    if (m.kind === 'custom') return { value: '', rest: 'Not logged yet' };
    if ((m.kind === 'steps' || m.kind === 'sleep_hours') && m.status === 'due') return { value: '', rest: 'Needs Health sync' };
    if (m.kind === 'lift_e1rm' && m.status === 'set') return { value: '', rest: 'Log the lift to start' };
    return { value: '', rest: 'No reading yet' };
  }
  const v = formatMetricValue(m.kind, cur, m.unit);
  const t = formatMetricValue(m.kind, m.target_value, m.unit);
  switch (m.kind) {
    case 'sessions_per_week': return { value: `${v} of ${t}`, rest: 'last week' };
    case 'cardio_sessions': return { value: `${v} of ${t}`, rest: 'last week' };
    case 'protein_days': return { value: `${v} of 7`, rest: 'days hit' };
    case 'sleep_hours': return { value: `${v}h`, rest: 'a night' };
    case 'steps': return { value: v, rest: 'avg' };
    case 'sets_per_muscle': return { value: v, rest: 'sets last week' };
    default: return { value: `${v}${m.unit ? ` ${m.unit}` : ''}`, rest: m.direction === 'hold' ? 'now' : `of ${t}` };
  }
}

interface Props {
  program: ActiveProgram;
  /** The phase shown; null = the current one (or the first, before the program starts). */
  seq: number | null;
  /** Whether today's calendar is past the program's end. */
  ended: boolean;
  onSelectSeq: (seq: number | null) => void;
}

export function PhaseDetail({ program, seq, ended, onSelectSeq }: Props) {
  const { C } = useTheme();
  const currentPhase = program.currentPhaseSeq != null ? program.phases.find((p) => p.seq === program.currentPhaseSeq) ?? null : null;
  const ph: ActiveProgramPhaseRow | null =
    (seq != null ? program.phases.find((p) => p.seq === seq) ?? null : null) ?? currentPhase ?? program.phases[0] ?? null;
  if (!ph) return null;

  const isCur = ph.seq === program.currentPhaseSeq;
  const phHero = heroOf(ph.metrics);
  const wkStart = ph.start_offset_weeks + 1;
  const wkEnd = ph.start_offset_weeks + ph.duration_weeks;
  const job = ph.job_text ?? (phHero ? defaultJobText(phHero) : null);
  const pct = phHero ? Math.round(jobFraction(phHero) * 100) : 0;
  const line = isCur ? (ph.coach_line ?? ph.training_directive) : (ph.training_directive ?? ph.diet_directive);
  const unbuilt = ph.routines.length === 0;

  return (
    <View style={[styles.card, { backgroundColor: C.card }]}>
      {/* Stepper: numbers only, every node the same size. Past phases are
          lime ticks, the current one a filled lime circle with its number,
          the rest hollow numbers; the viewed one carries a ring. */}
      <View style={styles.steps} accessibilityRole="tablist">
        {program.phases.map((p, i) => {
          const past = program.currentPhaseSeq != null ? p.seq < program.currentPhaseSeq : ended;
          const cur = p.seq === program.currentPhaseSeq;
          const sel = p.seq === ph.seq;
          return (
            <View key={p.id} style={[styles.stepWrap, i === program.phases.length - 1 && { flex: 0 }]}>
              <Pressable
                onPress={() => { haptics.tick(); onSelectSeq(cur ? null : p.seq); track('program_phase_viewed', { seq: p.seq, current: cur }); }}
                hitSlop={10}
                accessibilityRole="tab"
                accessibilityState={{ selected: sel }}
                accessibilityLabel={`Phase ${i + 1}, ${p.name}${cur ? ', current' : past ? ', done' : ''}`}
                style={({ pressed }) => [
                  styles.step,
                  cur
                    ? { backgroundColor: Colors.primary, borderColor: sel ? C.foreground : Colors.primary }
                    : past
                      ? { backgroundColor: C.primaryMuted, borderColor: sel ? C.foreground : 'transparent' }
                      : { borderColor: sel ? C.foreground : C.border },
                  pressed && { opacity: 0.7 },
                ]}
              >
                {past && !cur ? (
                  <Feather name="check" size={12} color={C.accentText} />
                ) : (
                  <Text style={[T.dayLetter, { fontSize: 12 }, cur ? { color: Colors.primaryFg, fontWeight: FontWeight.bold } : { color: sel ? C.foreground : C.textDim }]}>
                    {i + 1}
                  </Text>
                )}
              </Pressable>
              {i < program.phases.length - 1 && (
                <View style={[styles.stepLine, { backgroundColor: past ? colorWithAlpha(Colors.primary, 0.35) : C.border }]} />
              )}
            </View>
          );
        })}
      </View>

      <View style={styles.phaseTitleRow}>
        <Text style={[T.cardTitle, { color: C.foreground, flexShrink: 1 }]} numberOfLines={1}>{ph.name}</Text>
        <Text style={[T.meta, { color: C.mutedFg }]}>
          {wkStart === wkEnd ? `Week ${wkStart}` : `Weeks ${wkStart}-${wkEnd}`}
          {isCur && program.weekInPhase != null ? `  ·  wk ${program.weekInPhase} of ${ph.duration_weeks}` : ''}
        </Text>
      </View>
      {!isCur && program.currentPhaseSeq != null && (
        <View style={styles.viewingRow}>
          <Text style={[T.meta, { color: C.mutedFg, flex: 1, fontSize: 12, lineHeight: 16 }]}>
            {ph.seq < program.currentPhaseSeq ? 'A phase you have done.' : 'A phase still to come.'}
          </Text>
          <Pressable onPress={() => { haptics.selection(); onSelectSeq(null); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back to the current phase">
            <Text style={[T.status, { color: C.accentText }]}>Back to now</Text>
          </Pressable>
        </View>
      )}

      {job && (
        <View style={[styles.job, { backgroundColor: C.muted }]} accessibilityLabel={`${job}${isCur && phHero ? `, ${pct} percent done` : ''}`}>
          <View style={styles.jobTop}>
            <Text style={[T.status, { color: C.foreground, flexShrink: 1 }]} numberOfLines={1}>{job}</Text>
            {isCur && phHero && <Text style={[T.status, { color: C.accentText }]}>{pct}%</Text>}
          </View>
          {isCur && phHero && (
            <View style={[styles.jobBar, { backgroundColor: C.borderSubtle }]}>
              <View style={[styles.jobFill, { width: `${Math.max(2, pct)}%`, backgroundColor: Colors.primary }]} />
            </View>
          )}
        </View>
      )}

      {isCur && unbuilt && (
        <View style={[styles.notice, { backgroundColor: colorWithAlpha(Colors.warning, 0.12) }]}>
          <Feather name="alert-circle" size={12} color={C.warningText} />
          <Text style={[T.status, { color: C.warningText, flex: 1, fontWeight: FontWeight.semibold }]}>
            This phase has no workouts yet. Build them before your next session.
          </Text>
        </View>
      )}

      {line && (
        <View style={styles.coachRow} accessibilityLabel={`Drona: ${line}`}>
          <View style={[styles.coachAv, { backgroundColor: Colors.primary }]}>
            <Feather name="navigation" size={10} color={Colors.primaryFg} />
          </View>
          <Text style={[T.body, { color: C.foreground, flex: 1, fontSize: 14, lineHeight: 19 }]}>{line}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 22, paddingHorizontal: 18, paddingTop: S.lg, paddingBottom: 14 },
  steps: { flexDirection: 'row', alignItems: 'center' },
  stepWrap: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  step: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  stepLine: { flex: 1, height: 1.5, minWidth: 6, marginHorizontal: 6 },
  phaseTitleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14, gap: S.sm },
  viewingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 6, minHeight: 32 },
  job: { marginTop: S.sm, borderRadius: 14, paddingHorizontal: S.md, paddingTop: 10, paddingBottom: 11 },
  jobTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: S.sm },
  jobBar: { height: 5, borderRadius: 3, marginTop: S.sm, overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 3 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginTop: S.sm, borderRadius: 12, paddingHorizontal: S.md, paddingVertical: 9 },
  coachRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 10 },
  coachAv: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
});
