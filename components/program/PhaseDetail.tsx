/**
 * One phase of the program in full (.planning/phase-metrics/SPEC.md, "v2
 * layout"): the phase card (numbers-only stepper to switch phases, name and
 * weeks, the job bar, the no-workouts notice, Drona's line) and the Train /
 * Eat / Recover cards with the week strip, fuel marks, macro bar, tracked
 * rows with their status word, routines, the rules and the build call to
 * action. Shown by app/goal-plan-phase.tsx; the main Goal screen keeps only
 * the summary and links here.
 */
import type { ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import type { ActiveProgram, ActiveProgramPhaseRow } from '@/lib/programData';
import {
  defaultJobText, formatMetricValue, heroOf, jobFraction, metricRowName, STATUS_LABEL, statusTone,
  type MetricKind, type PhaseMetricRow,
} from '@/lib/phaseMetrics';
import { weekPatternFor, shortDayLabel, REST } from '@/lib/weekPattern';
import { fuelDaysText } from '@/lib/fuelDays';
import { Colors, Radius, FontSize, FontWeight, colorWithAlpha } from '@/constants/theme';

export type Pillar = 'train' | 'eat' | 'recover';

/** Which card a supporting target sits in. */
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
  onBuild: (phase: ActiveProgramPhaseRow) => void;
  onOpenRoutine: (routineId: string) => void;
  /** The y of each pillar card inside this view, so a caller can scroll to one. */
  onPillarLayout?: (pillar: Pillar, y: number) => void;
}

export function PhaseDetail({ program, seq, ended, onSelectSeq, onBuild, onOpenRoutine, onPillarLayout }: Props) {
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

  const statusColor = (m: PhaseMetricRow) => {
    const tone = statusTone(m.status);
    return tone === 'ok' ? C.accentText : tone === 'warn' ? C.warningText : C.textDim;
  };

  // One tracked target as a row on the shared 3-column grid: name / value / status.
  const renderMetricRow = (m: PhaseMetricRow, last: boolean) => {
    const { value, rest } = rowValue(m);
    return (
      <View key={m.id} style={[styles.trackRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
        <Text style={[styles.trackName, { color: C.foreground }]} numberOfLines={1}>{metricRowName(m, { proteinG: ph.diet_protein_g })}</Text>
        <Text style={[styles.trackValue, { color: C.mutedFg }]} numberOfLines={1}>
          {value ? <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{value} </Text> : null}
          {rest}
        </Text>
        <Text style={[styles.trackStatus, { color: statusColor(m) }]} numberOfLines={1}>{STATUS_LABEL[m.status]}</Text>
      </View>
    );
  };

  const rows = ph.metrics.filter((m) => m.id !== phHero?.id);
  const by = (pillar: Pillar) => rows.filter((m) => PILLAR_OF[m.kind] === pillar);
  const train = by('train');
  const eat = by('eat');
  const recover = by('recover');
  const week = weekPatternFor(ph.training_block);
  const days = ph.training_block?.days_per_week ?? (week ? week.filter((d) => d !== REST).length : null);
  const fuel = ph.diet_fuel_days && ph.diet_fuel_days.length > 0 ? ph.diet_fuel_days : null;
  const kcal = ph.diet_calorie_target;
  const pG = ph.diet_protein_g; const cG = ph.diet_carb_g; const fG = ph.diet_fat_g;
  const macroTotal = (pG ?? 0) * 4 + (cG ?? 0) * 4 + (fG ?? 0) * 9;
  const unbuilt = ph.routines.length === 0;
  const header = (label: string, right: ReactNode, rightColor?: string) => (
    <View style={styles.pillarHead}>
      <Text style={[styles.pillarKey, { color: C.accentText }]}>{label}</Text>
      <Text style={[styles.pillarRight, { color: rightColor ?? C.mutedFg }]} numberOfLines={1}>{right}</Text>
    </View>
  );
  const layoutOf = (pillar: Pillar) => (e: LayoutChangeEvent) => onPillarLayout?.(pillar, e.nativeEvent.layout.y);

  return (
    <View>
      {/* ── The phase card ───────────────────────────────────────────────── */}
      <View style={[styles.card, { backgroundColor: C.card }]}>
        {/* Stepper: numbers only, every node the same size. Past phases are
            lime ticks, the current one a filled lime circle with its number,
            the rest hollow numbers; the viewed one carries a ring. */}
        <View style={styles.steps}>
          {program.phases.map((p, i) => {
            const past = program.currentPhaseSeq != null ? p.seq < program.currentPhaseSeq : ended;
            const cur = p.seq === program.currentPhaseSeq;
            const sel = p.seq === ph.seq;
            return (
              <View key={p.id} style={[styles.stepWrap, i === program.phases.length - 1 && { flex: 0 }]}>
                <Pressable
                  onPress={() => { onSelectSeq(cur ? null : p.seq); track('program_phase_viewed', { seq: p.seq, current: cur }); }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${p.name}`}
                  style={[
                    styles.step,
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
                    <Text style={[styles.stepText, cur ? { color: Colors.primaryFg, fontWeight: FontWeight.bold } : { color: sel ? C.foreground : C.textDim }]}>
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
          <Text style={[styles.phaseName, { color: C.foreground }]} numberOfLines={1}>{ph.name}</Text>
          <Text style={[styles.phaseWeeks, { color: C.mutedFg }]}>
            {wkStart === wkEnd ? `Week ${wkStart}` : `Weeks ${wkStart}-${wkEnd}`}
            {isCur && program.weekInPhase != null ? `  ·  wk ${program.weekInPhase} of ${ph.duration_weeks}` : ''}
          </Text>
        </View>
        {!isCur && program.currentPhaseSeq != null && (
          <View style={styles.viewingRow}>
            <Text style={[styles.viewingText, { color: C.mutedFg }]}>
              {ph.seq < program.currentPhaseSeq ? 'A phase you have done.' : 'A phase still to come.'}
            </Text>
            <Pressable onPress={() => onSelectSeq(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back to the current phase">
              <Text style={[styles.viewingLink, { color: C.accentText }]}>Back to now</Text>
            </Pressable>
          </View>
        )}

        {job && (
          <View style={[styles.job, { backgroundColor: C.muted }]}>
            <View style={styles.jobTop}>
              <Text style={[styles.jobText, { color: C.foreground }]} numberOfLines={1}>{job}</Text>
              {isCur && phHero && <Text style={[styles.jobPct, { color: C.accentText }]}>{pct}%</Text>}
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
            <Text style={[styles.noticeText, { color: C.warningText }]}>
              This phase has no workouts yet. Build them before your next session.
            </Text>
          </View>
        )}

        {line && (
          <View style={styles.coachRow}>
            <View style={[styles.coachAv, { backgroundColor: Colors.primary }]}>
              <Feather name="navigation" size={10} color={Colors.primaryFg} />
            </View>
            <Text style={[styles.coachText, { color: C.foreground }]}>{line}</Text>
          </View>
        )}
      </View>

      {/* ── TRAIN ────────────────────────────────────────────────────────── */}
      <View style={[styles.pillar, { backgroundColor: C.card }]} onLayout={layoutOf('train')}>
        {unbuilt && isCur
          ? header('TRAIN', 'Not built', C.warningText)
          : header('TRAIN', (
            <>{ph.training_block?.split_type ?? 'Training'}{days ? <>  ·  <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{days} days</Text></> : null}</>
          ))}
        {week && (
          <View style={[styles.plan, { borderColor: C.borderSubtle }]}>
            <View style={styles.strip}>
              {week.map((label, i) => {
                const rest = label === REST;
                return (
                  <View key={i} style={styles.dc}>
                    <Text style={[styles.dcDay, { color: C.textDim }]}>D{i + 1}</Text>
                    <Text style={[styles.dcName, { color: rest ? C.textDim : C.foreground, fontWeight: rest ? FontWeight.medium : FontWeight.semibold }]} numberOfLines={1}>
                      {shortDayLabel(label)}
                    </Text>
                    <View style={[styles.dcBar, { backgroundColor: rest ? 'transparent' : C.border }]} />
                  </View>
                );
              })}
            </View>
            {fuel && (
              <View style={styles.note}>
                <View style={[styles.noteMark, { backgroundColor: Colors.primary }]} />
                <Text style={[styles.noteText, { color: C.mutedFg }]} numberOfLines={1}>Fuel day  {fuelDaysText(fuel)}</Text>
              </View>
            )}
          </View>
        )}
        {train.map((m, i) => renderMetricRow(m, i === train.length - 1))}
        {unbuilt ? (
          // No sessions yet: a real call to action, not a row link. The
          // current phase is more urgent (today's session depends on it),
          // and says so in the header and the phase card above.
          <View style={[styles.buildWrap, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
            <Text style={[styles.buildLine, { color: C.mutedFg }]}>
              No sessions yet for {ph.name}. I build the split from this phase's plan, about a minute.
            </Text>
            <Pressable
              onPress={() => onBuild(ph)}
              style={[styles.buildBtn, { backgroundColor: Colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel={`Build this phase's workouts for ${ph.name}`}
            >
              <Feather name="zap" size={14} color={Colors.primaryFg} />
              <Text style={[styles.buildBtnText, { color: Colors.primaryFg }]}>Build this phase's workouts</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.rr, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }]}>
            <Text style={[styles.trackName, { color: C.foreground }]}>Routines</Text>
            <View style={styles.routineChips}>
              {ph.routines.map((r) => (
                <Pressable key={r.id} onPress={() => onOpenRoutine(r.id)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`Preview ${r.name}`}>
                  <Text style={[styles.routineChip, { color: C.mutedFg }]} numberOfLines={1}>{r.name}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => onBuild(ph)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Rebuild the workout split for ${ph.name}`}>
                <Feather name="refresh-cw" size={12} color={C.textDim} />
              </Pressable>
            </View>
          </View>
        )}
        {ph.training_directive && ph.coach_line && (
          <Text style={[styles.rule, { color: C.mutedFg, borderColor: C.borderSubtle }]}>{ph.training_directive}</Text>
        )}
      </View>

      {/* ── EAT ──────────────────────────────────────────────────────────── */}
      <View style={[styles.pillar, { backgroundColor: C.card }]} onLayout={layoutOf('eat')}>
        {header('EAT', kcal != null ? <><Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{kcal.toLocaleString('en-US')}</Text> kcal a day</> : 'Daily targets')}
        {macroTotal > 0 && (
          <View style={[styles.plan, { borderColor: C.borderSubtle }]}>
            <View style={styles.stack}>
              {pG != null && <View style={{ flex: (pG * 4) / macroTotal, backgroundColor: C.macro.protein, borderRadius: 3 }} />}
              {cG != null && <View style={{ flex: (cG * 4) / macroTotal, backgroundColor: C.macro.carbs, borderRadius: 3 }} />}
              {fG != null && <View style={{ flex: (fG * 9) / macroTotal, backgroundColor: C.macro.fat, borderRadius: 3 }} />}
            </View>
            <View style={styles.leg}>
              {([['protein', pG, C.macro.protein], ['carbs', cG, C.macro.carbs], ['fat', fG, C.macro.fat]] as const).map(([name, g, color]) => g != null && (
                <View key={name} style={styles.legItem}>
                  <View style={[styles.legDot, { backgroundColor: color }]} />
                  <Text style={[styles.legText, { color: C.mutedFg }]}><Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{g}g</Text> {name}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
        {eat.map((m, i) => renderMetricRow(m, i === eat.length - 1))}
        {ph.diet_directive && (
          <Text style={[styles.rule, { color: C.mutedFg, borderColor: C.borderSubtle }]}>{ph.diet_directive}</Text>
        )}
      </View>

      {/* ── RECOVER ──────────────────────────────────────────────────────── */}
      <View style={[styles.pillar, { backgroundColor: C.card }]} onLayout={layoutOf('recover')}>
        {header('RECOVER', recover.length > 0 ? 'Sleep and readiness' : 'Readiness')}
        <View style={{ height: 4 }} />
        {recover.map((m, i) => renderMetricRow(m, i === recover.length - 1))}
        {ph.readiness_directive && (
          <Text style={[styles.rule, { color: C.mutedFg, borderColor: C.borderSubtle }]}>{ph.readiness_directive}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 22, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, marginBottom: 8 },

  steps: { flexDirection: 'row', alignItems: 'center' },
  stepWrap: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  step: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  stepText: { fontSize: 12, fontWeight: FontWeight.semibold },
  stepLine: { flex: 1, height: 1.5, minWidth: 6, marginHorizontal: 6 },
  phaseTitleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14, gap: 8 },
  phaseName: { fontSize: 20, lineHeight: 24, fontWeight: FontWeight.bold, letterSpacing: -0.4, flexShrink: 1 },
  phaseWeeks: { fontSize: 13, fontWeight: FontWeight.medium },
  viewingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 6 },
  viewingText: { flex: 1, fontSize: 12, lineHeight: 16, fontWeight: FontWeight.medium },
  viewingLink: { fontSize: 12, fontWeight: FontWeight.semibold },
  job: { marginTop: 8, borderRadius: 14, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 11 },
  jobTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  jobText: { fontSize: 13, fontWeight: FontWeight.semibold, flexShrink: 1 },
  jobPct: { fontSize: 13, fontWeight: FontWeight.semibold },
  jobBar: { height: 5, borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  jobFill: { height: '100%', borderRadius: 3 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  noticeText: { flex: 1, fontSize: 12.5, lineHeight: 17, fontWeight: FontWeight.semibold },
  coachRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 10 },
  coachAv: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  coachText: { flex: 1, fontSize: 13.5, lineHeight: 18, fontWeight: FontWeight.medium },

  pillar: { borderRadius: 22, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6, marginBottom: 8 },
  pillarHead: { height: 22, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  pillarKey: { fontSize: 11.5, fontWeight: FontWeight.bold, letterSpacing: 0.9 },
  pillarRight: { fontSize: 13, fontWeight: FontWeight.medium, flexShrink: 1 },
  plan: { paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  strip: { flexDirection: 'row', justifyContent: 'space-between' },
  dc: { flex: 1, alignItems: 'center', gap: 3 },
  dcDay: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 0.4 },
  dcName: { fontSize: 12.5, textAlign: 'center' },
  dcBar: { width: 26, height: 4, borderRadius: 2, marginTop: 2 },
  note: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  noteMark: { width: 14, height: 4, borderRadius: 2 },
  noteText: { fontSize: 12, fontWeight: FontWeight.medium, flexShrink: 1 },
  stack: { flexDirection: 'row', gap: 3, height: 6 },
  leg: { flexDirection: 'row', gap: 16, marginTop: 8 },
  legItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legDot: { width: 6, height: 6, borderRadius: 3 },
  legText: { fontSize: 12.5, fontWeight: FontWeight.medium },
  trackRow: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40 },
  trackName: { minWidth: 118, flexShrink: 0, fontSize: 13.5, fontWeight: FontWeight.semibold },
  trackValue: { flex: 1, flexShrink: 1, textAlign: 'right', fontSize: 13, fontWeight: FontWeight.medium },
  trackStatus: { width: 68, textAlign: 'right', fontSize: 11.5, fontWeight: FontWeight.semibold },
  rr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 40, gap: 8 },
  routineChips: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
  routineChip: { fontSize: 13, fontWeight: FontWeight.medium },
  buildWrap: { paddingTop: 10, paddingBottom: 8, gap: 10 },
  buildLine: { fontSize: 13, lineHeight: 18, fontWeight: FontWeight.medium },
  buildBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: Radius.lg },
  buildBtnText: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  rule: { paddingTop: 10, paddingBottom: 8, fontSize: 12, lineHeight: 16, fontWeight: FontWeight.medium, borderTopWidth: StyleSheet.hairlineWidth },
});
