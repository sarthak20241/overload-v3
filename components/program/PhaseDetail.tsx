/**
 * The phase card of the phase screen (.planning/phase-metrics/SPEC.md,
 * sections 8 and 9): a vertical timeline of the program's phases that ends
 * in the goal, then the viewed phase's job, the no-workouts notice, and
 * Drona's line. The Train / Eat / Recover detail lives on the pillar screens
 * (app/goal-plan-pillar.tsx), reached through the plan rows under this card.
 *
 * The timeline reads top to bottom as the road to the goal: one row per
 * phase (a node on a thin rail, the name and its weeks; the current phase
 * also carries its week and job bar), and a last node that is the goal
 * itself, not a phase. Tapping a phase row views that phase.
 *
 * Also home to the one small helper the plan rows and the pillar screens
 * share: which pillar a metric belongs to. A metric's number and its label
 * come from lib/phaseMetricHeadline.ts, the same on every screen.
 */
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { haptics } from '@/lib/haptics';
import { phaseFor, type ActiveProgram } from '@/lib/programData';
import { defaultJobText, heroOf, isWeeklyKind, jobFraction, metricLabel, type MetricKind } from '@/lib/phaseMetrics';
import { goalText } from '@/lib/phaseMetricHeadline';
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

interface Props {
  program: ActiveProgram;
  /** The phase shown; null = the current one (or the first, before the program starts). */
  seq: number | null;
  /** Whether today's calendar is past the program's end. */
  ended: boolean;
  onSelectSeq: (seq: number | null) => void;
}

/** A node's size, and the space above it inside its row. */
const NODE = 26;
const ROW_PAD = 9;

function fmtShortISO(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/**
 * The goal at the end of the road, in a few words: the program's target
 * weight, else the hero target of the last phase that has one (where the
 * program means to end up), else null (the timeline shows the title).
 */
function goalLineOf(program: ActiveProgram): string | null {
  if (program.target_weight_kg != null) return `Reach ${goalText('bodyweight', program.target_weight_kg)} kg`;
  const last = [...program.phases].reverse().find((p) => p.metrics.length > 0);
  const hero = last ? heroOf(last.metrics) : null;
  if (!hero) return null;
  const unit = hero.unit ? ` ${hero.unit}` : '';
  if (hero.kind === 'bodyweight') {
    return `${hero.direction === 'hold' ? 'Hold' : 'Reach'} ${goalText('bodyweight', hero.target_value)}${unit || ' kg'}`;
  }
  if (isWeeklyKind(hero.kind)) return defaultJobText(hero);
  return `${metricLabel(hero)} ${goalText(hero.kind, hero.target_value, hero.unit)}${unit}`;
}

export function PhaseDetail({ program, seq, ended, onSelectSeq }: Props) {
  const { C } = useTheme();
  const ph = phaseFor(program, seq);
  if (!ph) return null;

  const isCur = ph.seq === program.currentPhaseSeq;
  const phHero = heroOf(ph.metrics);
  const job = ph.job_text ?? (phHero ? defaultJobText(phHero) : null);
  const pct = phHero ? Math.round(jobFraction(phHero) * 100) : 0;
  const line = isCur ? (ph.coach_line ?? ph.training_directive) : (ph.training_directive ?? ph.diet_directive);
  const unbuilt = ph.routines.length === 0;

  const totalWeeks = program.total_weeks ?? program.phases.reduce((a, p) => a + p.duration_weeks, 0);
  const endISO = program.target_date ?? addDaysISO(program.start_date, totalWeeks * 7);
  const goalLine = goalLineOf(program);
  const goalTitle = goalLine ?? program.title;
  const goalWhen = `${ended ? 'Ended' : 'By'} ${fmtShortISO(endISO)}`;

  const isPast = (s: number) => (program.currentPhaseSeq != null ? s < program.currentPhaseSeq : ended);
  // The rail below a node: lime-tinted once that phase is done.
  const railColor = (done: boolean) => (done ? colorWithAlpha(Colors.primary, 0.35) : C.border);
  const lastIdx = program.phases.length - 1;
  const showViewing = !isCur && program.currentPhaseSeq != null;
  const hasDetail = showViewing || !!job || (isCur && unbuilt) || !!line;

  return (
    <View style={[styles.card, { backgroundColor: C.card }]}>
      {/* The timeline. Past phases are lime ticks, the current one a filled
          lime circle with its number, the rest hollow numbers; the viewed
          row is shaded and its node carries a ring. */}
      <View accessibilityRole="tablist">
        {program.phases.map((p, i) => {
          const past = isPast(p.seq);
          const cur = p.seq === program.currentPhaseSeq;
          const sel = p.seq === ph.seq;
          const prevDone = i > 0 && isPast(program.phases[i - 1].seq);
          const wkStart = p.start_offset_weeks + 1;
          const wkEnd = p.start_offset_weeks + p.duration_weeks;
          const weeks = wkStart === wkEnd ? `Week ${wkStart}` : `Weeks ${wkStart}-${wkEnd}`;
          const weekOf = cur && program.weekInPhase != null ? `Week ${program.weekInPhase} of ${p.duration_weeks}` : null;
          const pHero = cur ? heroOf(p.metrics) : null;
          const pPct = pHero ? Math.round(jobFraction(pHero) * 100) : null;
          return (
            <Pressable
              key={p.id}
              onPress={() => { haptics.tick(); onSelectSeq(cur ? null : p.seq); track('program_phase_viewed', { seq: p.seq, current: cur }); }}
              accessibilityRole="tab"
              accessibilityState={{ selected: sel }}
              accessibilityLabel={`Phase ${i + 1}, ${p.name}, ${weeks}${cur ? `, current${weekOf ? `, ${weekOf}` : ''}${pPct != null ? `, ${pPct} percent of the phase target` : ''}` : past ? ', done' : ''}`}
              style={({ pressed }) => [styles.row, sel && { backgroundColor: C.muted }, pressed && { opacity: 0.7 }]}
            >
              <View style={styles.rail}>
                <View style={[styles.railTop, { backgroundColor: i === 0 ? 'transparent' : railColor(prevDone) }]} />
                <View
                  style={[
                    styles.node,
                    cur
                      ? { backgroundColor: Colors.primary, borderColor: sel ? C.foreground : Colors.primary }
                      : past
                        ? { backgroundColor: C.primaryMuted, borderColor: sel ? C.foreground : 'transparent' }
                        : { borderColor: sel ? C.foreground : C.border },
                  ]}
                >
                  {past && !cur ? (
                    <Feather name="check" size={12} color={C.accentText} />
                  ) : (
                    <Text style={[T.dayLetter, { fontSize: 12 }, cur ? { color: Colors.primaryFg, fontWeight: FontWeight.bold } : { color: sel ? C.foreground : C.textDim }]}>
                      {i + 1}
                    </Text>
                  )}
                </View>
                <View style={[styles.railLine, { backgroundColor: railColor(past) }]} />
              </View>

              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text
                    style={[styles.name, { color: cur || sel || past ? C.foreground : C.mutedFg, fontWeight: cur ? FontWeight.bold : FontWeight.semibold }]}
                    numberOfLines={1}
                  >
                    {p.name}
                  </Text>
                  <Text style={[styles.rowMeta, { color: C.mutedFg }]}>{weeks}</Text>
                </View>
                {(weekOf || pPct != null) && (
                  <View style={styles.curBlock}>
                    <View style={styles.curTop}>
                      <Text style={[styles.rowMeta, { color: C.mutedFg }]}>{weekOf ?? 'This phase'}</Text>
                      {pPct != null && <Text style={[T.status, { color: C.accentText }]}>{pPct}%</Text>}
                    </View>
                    {pPct != null && (
                      <View style={[styles.jobBar, { backgroundColor: C.borderSubtle }]}>
                        <View style={[styles.jobFill, { width: `${Math.max(2, pPct)}%`, backgroundColor: Colors.primary }]} />
                      </View>
                    )}
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* The end of the road: the goal itself, not a phase. */}
      <View style={styles.row} accessible accessibilityLabel={`Goal: ${goalTitle}, ${goalWhen}`}>
        <View style={styles.rail}>
          <View style={[styles.railTop, { backgroundColor: lastIdx >= 0 ? railColor(isPast(program.phases[lastIdx].seq)) : 'transparent' }]} />
          <View style={[styles.node, { backgroundColor: C.primaryMuted, borderColor: 'transparent' }]}>
            <Feather name="flag" size={12} color={C.accentText} />
          </View>
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={[styles.name, { color: C.foreground, fontWeight: FontWeight.bold }]} numberOfLines={1}>{goalTitle}</Text>
            <Text style={[styles.rowMeta, { color: C.mutedFg }]}>{goalWhen}</Text>
          </View>
        </View>
      </View>

      {hasDetail && <View style={[styles.divider, { backgroundColor: C.borderSubtle }]} />}

      {showViewing && (
        <View style={styles.viewingRow}>
          <Text style={[T.meta, { color: C.mutedFg, flex: 1, fontSize: 12, lineHeight: 16 }]}>
            {ph.seq < program.currentPhaseSeq! ? 'A phase you have done.' : 'A phase still to come.'}
          </Text>
          <Pressable onPress={() => { haptics.selection(); onSelectSeq(null); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back to the current phase">
            <Text style={[T.status, { color: C.accentText }]}>Back to now</Text>
          </Pressable>
        </View>
      )}

      {/* The viewed phase's job. Its progress bar sits on the current
          phase's timeline row, so the number shows here and the bar there. */}
      {job && (
        <View style={[styles.job, { backgroundColor: C.muted }]} accessibilityLabel={`${job}${isCur && phHero ? `, ${pct} percent done` : ''}`}>
          <View style={styles.jobTop}>
            <Text style={[T.status, { color: C.foreground, flexShrink: 1 }]} numberOfLines={2}>{job}</Text>
            {isCur && phHero && <Text style={[T.status, { color: C.accentText }]}>{pct}%</Text>}
          </View>
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
  card: { borderRadius: 22, paddingHorizontal: 18, paddingTop: S.md, paddingBottom: 14 },
  // A row reaches 8pt past the card's padding on each side so its shade has
  // room around the node; the rail runs edge to edge of the row, so the
  // segments of neighbouring rows meet into one line.
  row: { flexDirection: 'row', borderRadius: 14, marginHorizontal: -8, paddingHorizontal: 8 },
  rail: { width: NODE, alignItems: 'center' },
  railTop: { width: 1.5, height: ROW_PAD },
  railLine: { width: 1.5, flex: 1 },
  node: { width: NODE, height: NODE, borderRadius: NODE / 2, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, marginLeft: S.md, paddingTop: ROW_PAD, paddingBottom: ROW_PAD },
  rowTop: { flexDirection: 'row', alignItems: 'center', minHeight: NODE, gap: S.sm },
  name: { flex: 1, fontSize: 16, lineHeight: 20 },
  rowMeta: { fontSize: 13, lineHeight: 17, fontWeight: FontWeight.medium, fontVariant: ['tabular-nums'] },
  curBlock: { marginTop: 2, marginBottom: 2 },
  curTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: S.sm },
  jobBar: { height: 4, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginTop: S.sm, marginBottom: S.xs },
  viewingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 4, minHeight: 32 },
  job: { marginTop: S.sm, borderRadius: 14, paddingHorizontal: S.md, paddingVertical: 10 },
  jobTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: S.sm },
  notice: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginTop: S.sm, borderRadius: 12, paddingHorizontal: S.md, paddingVertical: 9 },
  coachRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 10 },
  coachAv: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
});
