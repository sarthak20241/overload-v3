/**
 * "Your plan": the three rows (Train / Eat / Recover) shared by the main Goal
 * screen and the phase screen. Each row's subtitle carries ONE supporting
 * metric of the phase, read through metricHeadline so it is the same number
 * and status word the pillar screen's hero shows ("3 of 4 sessions last
 * week · On track"), else the plan text. Each row opens that pillar's screen
 * for the phase it describes.
 */
import { View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import type { ActiveProgramPhaseRow } from '@/lib/programData';
import { heroOf, STATUS_LABEL, statusTone, type MetricKind, type MetricStatus } from '@/lib/phaseMetrics';
import { weekPatternFor, REST } from '@/lib/weekPattern';
import { PILLAR_OF, type Pillar } from '@/components/program/PhaseDetail';
import { headlineText, metricHeadline, type LiveReadings } from '@/lib/phaseMetricHeadline';
import { Row, SectionLabel, Stagger, S, T, useStatusColor } from '@/components/program/finish';
import { FontWeight } from '@/constants/theme';

/** The one supporting metric a plan row shows, in order of preference per pillar. */
const ROW_METRIC_PREFERENCE: Record<Pillar, MetricKind[]> = {
  train: ['sessions_per_week', 'steps', 'cardio_sessions', 'sets_per_muscle', 'lift_e1rm', 'distance', 'duration', 'custom'],
  eat: ['protein_days', 'bodyweight'],
  recover: ['sleep_hours'],
};

/** A subtitle at 14pt beside an icon and a chevron fits about this many characters on a 402pt screen. */
const SUBTITLE_MAX_CHARS = 36;

/**
 * A plan row's subtitle: ONE metric with its status when the pillar has one,
 * else the plan text. Never more than a line: a long headline takes its
 * short form, a Train row with a metric drops the split and day count, an
 * Eat row drops its calories when the line would not fit.
 */
export function pillarSummary(ph: ActiveProgramPhaseRow, pillar: Pillar, readinessToday: number | null, live: LiveReadings | null): { text: string; status: MetricStatus | null } {
  const hero = heroOf(ph.metrics);
  const candidates = ph.metrics.filter((m) => m.id !== hero?.id && PILLAR_OF[m.kind] === pillar);
  const metric = ROW_METRIC_PREFERENCE[pillar].map((k) => candidates.find((m) => m.kind === k)).find((m) => m != null) ?? null;
  const h = metric ? metricHeadline(metric, live) : null;
  const fitsLine = (text: string, status: MetricStatus | null) => text.length + (status ? 3 + STATUS_LABEL[status].length : 0) <= SUBTITLE_MAX_CHARS;
  const metricText = () => {
    if (!h) return '';
    const full = headlineText(h);
    return fitsLine(full, h.status) ? full : headlineText(h, true);
  };
  if (pillar === 'train') {
    if (h) return { text: metricText(), status: h.status };
    const week = weekPatternFor(ph.training_block);
    const days = ph.training_block?.days_per_week ?? (week ? week.filter((d) => d !== REST).length : null);
    return { text: [ph.training_block?.split_type, days ? `${days} days` : null].filter(Boolean).join(' · ') || 'Training plan', status: null };
  }
  if (pillar === 'eat') {
    const kcal = ph.diet_calorie_target != null ? `${ph.diet_calorie_target.toLocaleString('en-US')} kcal` : null;
    if (!h) {
      return { text: [kcal, ph.diet_protein_g != null ? `${ph.diet_protein_g} g protein` : null].filter(Boolean).join(' · ') || 'Daily targets', status: null };
    }
    const m = metricText();
    const full = kcal ? `${kcal} · ${m}` : m;
    return { text: fitsLine(full, h.status) ? full : m, status: h.status };
  }
  if (h) return { text: metricText(), status: h.status };
  return { text: readinessToday != null ? `Readiness ${Math.round(readinessToday)} today` : 'Sleep and readiness', status: null };
}

interface Props {
  phase: ActiveProgramPhaseRow;
  readinessToday: number | null;
  /** The live fallback for a metric with no job reading yet; null while it loads. */
  live: LiveReadings | null;
  /** Where the rows are tapped from, for analytics. */
  from: 'goal' | 'phase';
  /** The stagger index the heading starts at. */
  staggerFrom?: number;
  /** Show the "Your plan" heading. */
  heading?: boolean;
}

export function PlanRows({ phase, readinessToday, live, from, staggerFrom = 0, heading = true }: Props) {
  const { C } = useTheme();
  const router = useRouter();
  const statusColor = useStatusColor();
  const rows: { pillar: Pillar; icon: 'activity' | 'coffee' | 'moon'; title: string }[] = [
    { pillar: 'train', icon: 'activity', title: 'Train' },
    { pillar: 'eat', icon: 'coffee', title: 'Eat' },
    { pillar: 'recover', icon: 'moon', title: 'Recover' },
  ];
  const open = (pillar: Pillar) => {
    track('program_pillar_opened', { pillar, seq: phase.seq, from });
    router.push({ pathname: '/goal-plan-pillar', params: { pillar, seq: String(phase.seq) } } as any);
  };
  return (
    <View>
      {heading && (
        <Stagger index={staggerFrom}>
          <Text style={[T.cardTitle, { color: C.foreground, marginBottom: S.md }]}>Your plan</Text>
        </Stagger>
      )}
      {!heading && <SectionLabel style={{ marginBottom: S.md }}>Your plan</SectionLabel>}
      {rows.map(({ pillar, icon, title }, i) => {
        const s = pillarSummary(phase, pillar, readinessToday, live);
        return (
          <Stagger key={pillar} index={staggerFrom + 1 + i}>
            <Row
              icon={icon}
              title={title}
              first={i === 0}
              last={i === rows.length - 1}
              onPress={() => open(pillar)}
              accessibilityLabel={`${title}. ${s.text}${s.status ? `, ${STATUS_LABEL[s.status]}` : ''}`}
              subtitle={(
                <>
                  {s.text}
                  {s.status ? <Text style={{ color: statusColor(statusTone(s.status)), fontWeight: FontWeight.semibold }}>{` · ${STATUS_LABEL[s.status]}`}</Text> : null}
                </>
              )}
            />
          </Stagger>
        );
      })}
    </View>
  );
}
