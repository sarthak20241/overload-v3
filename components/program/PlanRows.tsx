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
import { planRowLine, rowLine, type LiveReadings } from '@/lib/phaseMetricHeadline';
import { Row, SectionLabel, Stagger, S, T, useGoalPalette, useStatusColor } from '@/components/program/finish';
import { DumbbellIcon, MoonIcon, UtensilsIcon } from '@/components/program/LineIcons';
import { FontWeight } from '@/constants/theme';

/** The one supporting metric a plan row shows, in order of preference per pillar. */
const ROW_METRIC_PREFERENCE: Record<Pillar, MetricKind[]> = {
  train: ['sessions_per_week', 'steps', 'cardio_sessions', 'sets_per_muscle', 'lift_e1rm', 'distance', 'duration', 'custom'],
  eat: ['protein_days', 'bodyweight'],
  recover: ['sleep_hours'],
};

/**
 * A subtitle at 14pt beside an icon and a chevron fits about this many
 * characters on a 402pt screen. Measured on device: "3 of 4 sessions last
 * week · On track" (36) used ~233pt and left ~65pt, so ~46 fit; 42 keeps a
 * margin for wide glyphs.
 */
const SUBTITLE_MAX_CHARS = 42;

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
  const h = metric ? rowLine(metric, live) : null;
  const fitsLine = (text: string, status: MetricStatus | null) => text.length + (status ? 3 + STATUS_LABEL[status].length : 0) <= SUBTITLE_MAX_CHARS;
  const metricText = () => (!h ? '' : fitsLine(h.text, h.status) ? h.text : h.short);
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
  /** Space between the "Your plan" heading and the first row. */
  headingGap?: number;
}

export function PlanRows({ phase, readinessToday, live, from, staggerFrom = 0, heading = true, headingGap = 6 }: Props) {
  const { C } = useTheme();
  const router = useRouter();
  const statusColor = useStatusColor();
  // The Goal screen draws the reference's look: 58pt rows, thin icons in a
  // 40pt column (the dumbbell drawn larger: it is wide and short), 16/500
  // titles over 13pt subtitles, 1pt lines, dots with 6pt of air,
  // plan-first lines, status words in the same muted colour.
  const pal = useGoalPalette();
  const goal = from === 'goal';
  // The approved reference's thin outline icons (Lucide paths, drawn inline).
  const rows: { pillar: Pillar; Icon: typeof DumbbellIcon; title: string }[] = [
    { pillar: 'train', Icon: DumbbellIcon, title: 'Train' },
    { pillar: 'eat', Icon: UtensilsIcon, title: 'Eat' },
    { pillar: 'recover', Icon: MoonIcon, title: 'Recover' },
  ];
  const goalLine = (pillar: Pillar) => {
    const pattern = weekPatternFor(phase.training_block);
    return planRowLine(pillar, {
      split: phase.training_block?.split_type ?? null,
      days: phase.training_block?.days_per_week ?? (pattern ? pattern.filter((d) => d !== REST).length : null),
      kcal: phase.diet_calorie_target,
      proteinG: phase.diet_protein_g,
      sleep: phase.metrics.find((m) => m.kind === 'sleep_hours') ?? null,
    }, live, readinessToday);
  };
  const open = (pillar: Pillar) => {
    track('program_pillar_opened', { pillar, seq: phase.seq, from });
    router.push({ pathname: '/goal-plan-pillar', params: { pillar, seq: String(phase.seq) } } as any);
  };
  return (
    <View>
      {heading && (
        <Stagger index={staggerFrom}>
          <Text style={[T.heading, { color: C.foreground, marginBottom: headingGap }]}>Your plan</Text>
        </Stagger>
      )}
      {!heading && <SectionLabel style={{ marginBottom: S.md }}>Your plan</SectionLabel>}
      {rows.map(({ pillar, Icon, title }, i) => {
        // The Goal screen uses the reference's plan-first line; the phase
        // screen keeps the metric line with its coloured status.
        const s = goal ? goalLine(pillar) : pillarSummary(phase, pillar, readinessToday, live);
        return (
          <Stagger key={pillar} index={staggerFrom + 1 + i}>
            <Row
              iconNode={goal
                ? <Icon size={pillar === 'train' ? 40 : pillar === 'recover' ? 31 : 29} strokeWidth={1.6} color={pal.icon} />
                : <Icon size={26} color={C.foreground} />}
              title={title}
              minHeight={goal ? 58 : 54}
              look={goal ? {
                muted: pal.muted, divider: pal.divider, titleSize: 16, titleWeight: FontWeight.medium, subSize: 12.5,
                sub: pal.rowSub, chevron: pal.chevron, iconColumn: 40,
              } : undefined}
              subtitleParts={goal ? [...s.text.split(' · '), ...(s.status ? [STATUS_LABEL[s.status]] : [])] : undefined}
              first={i === 0}
              last={i === rows.length - 1}
              onPress={() => open(pillar)}
              accessibilityLabel={`${title}. ${s.text}${s.status ? `, ${STATUS_LABEL[s.status]}` : ''}`}
              subtitle={(
                <>
                  {s.text}
                  {/* Calm by default: a good or neutral status reads in the
                      same muted colour; only a problem (Slipping, Behind) gets colour. */}
                  {s.status ? (
                    <Text style={!goal && statusTone(s.status) === 'warn' ? { color: statusColor('warn'), fontWeight: FontWeight.medium } : null}>
                      {` · ${STATUS_LABEL[s.status]}`}
                    </Text>
                  ) : null}
                </>
              )}
            />
          </Stagger>
        );
      })}
    </View>
  );
}
