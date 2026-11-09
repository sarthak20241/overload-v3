/**
 * First-run onboarding: the intake that makes the app worth opening on day
 * one. Nine beats, roughly a minute end to end:
 *
 *   welcome    orientation: what Overload is, in Drona's voice
 *   goal       what the user trains for (rep ranges, calorie direction)
 *   experience how long they've lifted (starting volume)
 *   frequency  days per week as a story slider (activity factor). The split is
 *              NOT chosen here: it's decided at generation from goal,
 *              experience, days, and the optional notes below.
 *   health     optional free text: injuries / conditions to train around
 *   prefs      optional free text: preferences for the routine
 *   gender     one tap, auto-advance (BMR math)
 *   age        age wheel, the page hero (BMR math)
 *   height     height wheel (BMR math)
 *   weight     current weight ruler (BMR + coach context)
 *   target     goal weight (diet direction)
 *   plan       the payoff: starter routines + daily calorie/macro targets
 *              generated from the answers, expectation-setting from the
 *              coach, and the activation CTA
 *
 * Every answer visibly feeds the generated plan (that's what earns the
 * questions), single-select steps auto-advance to cut taps, every step arrives
 * pre-answered with a smart default (no skip affordance), and the flow ends by creating real routines and fuel targets so
 * the dashboard and nutrition screens are personalized from the first open.
 * Permissions are deliberately not requested here (see lib/onboarding.ts).
 */
import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Pressable,
  BackHandler,
  Keyboard,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import {
  Colors,
  FontFamily,
  Radius,
  FontSize,
  FontWeight,
  Spacing,
  IconSize,
  LetterSpacing,
  Shadow,
} from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { useGuestMode } from '@/lib/guestMode';
import { track } from '@/lib/analytics';
import { useBasicInfo } from '@/hooks/useBasicInfo';
import { useSync } from '@/components/SyncProvider';
import { useToast } from '@/components/ui/Toast';
import { PressableScale } from '@/components/ui/PressableScale';
import {
  OnboardingHeader,
  OptionCard,
  PrimaryCta,
  QuestionStep,
  TextAreaField,
} from '@/components/onboarding/OnboardingKit';
import { NumberWheel, UnitWheel, WeightWheel } from '@/components/onboarding/BodyPickers';
import { displayFromKg, kgFromDisplay, LBS_PER_KG, WEIGHT_WHEEL } from '@/lib/weightWheel';
import { FrequencyStory } from '@/components/onboarding/FrequencyStory';
import { PaceSlider } from '@/components/onboarding/PaceSlider';
import { CommitmentHold } from '@/components/onboarding/CommitmentHold';
import { Celebration } from '@/components/ui/Celebration';
import { BuildMoment } from '@/components/onboarding/BuildMoment';
import { ProjectedCurve } from '@/components/onboarding/ProjectedCurve';
import { DronaMark } from '@/components/coach/DronaMark';
import { DronaHeroOrb } from '@/components/coach/DronaHeroOrb';
import { DemoLoop } from '@/components/onboarding/DemoLoop';
import {
  EMPTY_ANSWERS,
  type OnboardingAnswers,
  computeDailyTargets,
  paceAdjustedTargets,
  paceBounds,
  projectGoalDateIso,
  saveOnboardingProfile,
  markOnboardingDone,
  onboardingIdentity,
} from '@/lib/onboarding';
import { buildAnonIntake, requestAnonOnboardingProgram } from '@/lib/onboardingDrona';
import { weekPatternFor, shortDayLabel, REST } from '@/lib/weekPattern';
import { getDeviceId } from '@/lib/deviceId';
import { setPendingOnboarding, saveOnboardingProgram } from '@/lib/pendingOnboarding';
import {
  buildOnboardingProgramMessage,
  buildStarterProgram,
  dronaProgramFromStructured,
  requestDronaOnboardingProgram,
} from '@/lib/onboardingProgram';
import type { GeneratedProgram } from '@/lib/programData';
import type { CoachGoal, ExperienceLevel } from '@/lib/types';
import { MedicalDisclaimer } from '@/components/health/MedicalDisclaimer';
import { joinGoals, selectedGoals, toggleGoal } from '@/lib/fitnessGoals';

const WEIGHT_UNITS = [
  { value: 'kg', label: 'kg' },
  { value: 'lbs', label: 'lbs' },
] as const;
const HEIGHT_UNITS = [
  { value: 'cm', label: 'cm' },
  { value: 'ft', label: 'ft, in' },
] as const;
const MIN_AGE_YEARS = 13;
const MAX_AGE_YEARS = 120;
const MIN_WEIGHT_KG = 25;
const MAX_WEIGHT_KG = 500;
const MIN_HEIGHT_CM = 100;
const MAX_HEIGHT_CM = 250;

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function formatMeasurement(value: number): string {
  return String(Math.round(value * 10) / 10);
}

type Step =
  | 'welcome' | 'goal' | 'experience' | 'frequency' | 'health' | 'prefs'
  | 'gender' | 'age' | 'height' | 'weight' | 'target' | 'pace'
  | 'interlude' | 'commit' | 'build' | 'plan';
const STEP_ORDER: Step[] = ['welcome', 'goal', 'experience', 'frequency', 'health', 'prefs', 'gender', 'age', 'height', 'weight', 'target', 'pace', 'interlude', 'commit', 'build', 'plan'];
// Steps counted by the progress header (welcome and the build moment hide it).
const PROGRESS_STEPS: Step[] = ['goal', 'experience', 'frequency', 'health', 'prefs', 'gender', 'age', 'height', 'weight', 'target', 'pace', 'interlude', 'commit', 'build', 'plan'];

const GOAL_OPTIONS: { value: CoachGoal; icon: keyof typeof Feather.glyphMap; title: string }[] = [
  { value: 'hypertrophy', icon: 'layers', title: 'Build muscle' },
  { value: 'strength', icon: 'zap', title: 'Get stronger' },
  { value: 'fat_loss', icon: 'wind', title: 'Lose fat' },
  { value: 'endurance', icon: 'repeat', title: 'Build endurance' },
  { value: 'general', icon: 'compass', title: 'Overall fitness' },
];

const EXPERIENCE_OPTIONS: { value: ExperienceLevel; icon: keyof typeof Feather.glyphMap; title: string; sub: string }[] = [
  { value: 'beginner', icon: 'sunrise', title: 'Just starting out', sub: 'Under a year of training' },
  { value: 'intermediate', icon: 'trending-up', title: 'Some experience', sub: 'One to three years' },
  { value: 'advanced', icon: 'award', title: 'Very experienced', sub: 'More than three years' },
];

const GOAL_PHRASES: Record<CoachGoal, string> = {
  hypertrophy: 'Building muscle',
  strength: 'Getting stronger',
  fat_loss: 'Cutting fat while keeping muscle',
  endurance: 'Building endurance',
  general: 'Staying fit and healthy',
};

export default function OnboardingScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const { user, isSignedIn, isLoaded, getToken } = useClerkUser();
  const { isGuest, isLoaded: guestLoaded } = useGuestMode();
  // A fresh visitor (no account, not an explicit guest) is the guest-first
  // funnel's main subject: they run the intake, then convert at the reveal.
  const isFreshVisitor = !isSignedIn && !isGuest;
  const { flushNow } = useSync();
  const supabaseClient = useSupabaseClient();
  const basicInfo = useBasicInfo();
  const toast = useToast();

  const [step, setStep] = useState<Step>('welcome');
  // Smart defaults (plan, psychology layer): goal and single-select steps arrive
  // pre-answered with the most common choice, so Continue is always one tap and
  // the pre-selection reads as a recommendation.
  const [answers, setAnswers] = useState<OnboardingAnswers>({
    ...EMPTY_ANSWERS,
    goal: 'hypertrophy',
    goals: ['hypertrophy'],
    experience: 'beginner',
    frequency: 3,
  });
  const [finishing, setFinishing] = useState(false);
  const [celebrating, setCelebrating] = useState(false);

  // "Something else" opens a text box under six cards; once the keyboard is
  // up, scroll it into view or the user types blind.
  const goalScrollRef = useRef<ScrollView>(null);
  // Text typed before "Something else" was toggled off, so a re-tap brings it
  // back. A closed card sends nothing (goalNote is null while it is off).
  const stashedGoalNote = useRef('');
  const goalNoteOpen = step === 'goal' && answers.goalNote != null;
  // Continue needs a preset goal or a written one. "Something else" open but
  // left empty blocks it: it would tell Drona nothing.
  const hasWrittenGoal = !!answers.goalNote?.trim();
  const emptyNoteOpen = answers.goalNote != null && !hasWrittenGoal;
  const goalStepReady = hasWrittenGoal || (selectedGoals(answers).length > 0 && !emptyNoteOpen);
  useEffect(() => {
    if (!goalNoteOpen) return;
    const toEnd = () => goalScrollRef.current?.scrollToEnd({ animated: true });
    const sub = Keyboard.addListener('keyboardDidShow', toEnd);
    const t = setTimeout(toEnd, 80);
    return () => { sub.remove(); clearTimeout(t); };
  }, [goalNoteOpen]);

  // Analytics. One effect on `step` is the whole drop-off funnel: every beat
  // reports itself, so PostHog can rank the steps people quit on without a
  // call in each of the sixteen handlers.
  const onboardingStartedAt = useRef(Date.now());
  useEffect(() => {
    track('onboarding_started');
  }, []);
  const stepEnteredAt = useRef(Date.now());
  useEffect(() => {
    stepEnteredAt.current = Date.now();
    track('onboarding_step_viewed', {
      step,
      step_index: STEP_ORDER.indexOf(step),
      total_steps: STEP_ORDER.length,
      seconds_since_start: Math.round((Date.now() - onboardingStartedAt.current) / 1000),
    });
  }, [step]);
  // Forward vs back, from the two functions every step change flows through
  // (goTo for CTAs and the chevron, selectAndAdvance for single-select beats).
  const reportStepChange = useCallback((next: Step, method: 'cta' | 'auto_advance') => {
    const from = STEP_ORDER.indexOf(step);
    const to = STEP_ORDER.indexOf(next);
    if (to === from) return;
    const props = {
      step,
      step_index: from,
      seconds_on_step: Math.round((Date.now() - stepEnteredAt.current) / 1000),
    };
    if (to > from) track('onboarding_step_completed', { ...props, next_step: next, method });
    else track('onboarding_back', { ...props, prev_step: next });
  }, [step]);

  // Body/target inputs are picker-backed numbers, prefilled with population
  // medians (smart defaults): scan and adjust, never fill from scratch.
  const [ageYears, setAgeYears] = useState(24);
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>('kg');
  const [heightUnit, setHeightUnit] = useState<'cm' | 'ft'>('cm');
  const [heightCm, setHeightCm] = useState(172);
  const [heightFt, setHeightFt] = useState(5);
  const [heightIn, setHeightIn] = useState(8);
  /** Current weight in the DISPLAY unit. */
  const [weightVal, setWeightVal] = useState(72.5);
  /** Goal weight in the DISPLAY unit; seeded from weight on first visit. */
  const [targetVal, setTargetVal] = useState(72.5);
  const targetTouched = useRef(false);
  // The same two weights in kg, unrounded: a unit switch reads these, so
  // flipping kg and lbs back and forth never drifts the number. Anything that
  // sets weightVal or targetVal (a future prefill from a saved profile, say)
  // must set these too, or the next unit switch jumps back to the old weight.
  const weightKgKept = useRef(72.5);
  // Height the same way: kept in exact cm, so cm -> ft, in -> cm never turns
  // 172 into 173. The ft and in refs let each wheel read the other's latest.
  const heightCmKept = useRef(172);
  const heightFtLatest = useRef(5);
  const heightInLatest = useRef(8);
  const targetKgKept = useRef(72.5);
  /** Chosen weekly rate (kg/week); null until a weight direction exists. */
  const [weeklyRate, setWeeklyRate] = useState<number | null>(null);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
  }, []);

  const toKg = useCallback(
    (v: number) => (weightUnit === 'lbs' ? Math.round((v / LBS_PER_KG) * 10) / 10 : v),
    [weightUnit],
  );

  // Onboarding hands out the program and no workouts at all. Phase 1's split
  // is built by Drona after sign-up, from the Goal screen, against the real
  // account; a generic starter week saved here would sit in the Routines tab
  // beside that split looking like a second plan nobody asked for.

  // Drona generation state. `buildReady` gates BuildMoment's final tick, so
  // the build screen elastically holds the thinking state while the LLM runs.
  const [buildReady, setBuildReady] = useState(false);
  const generationStarted = useRef(false);
  // The goal program (phases to the target date), same two-author contract:
  // Drona's when generation succeeds, the deterministic road otherwise.
  const [dronaProgram, setDronaProgram] = useState<GeneratedProgram | null>(null);

  // Live pace context for the target step: uses the DRAFT target value (not
  // yet committed to answers) so the outcome card updates as the ruler moves.
  const paceCtx = useMemo(() => {
    const w = toKg(weightVal);
    const t = toKg(targetVal);
    if (!inRange(w, MIN_WEIGHT_KG, MAX_WEIGHT_KG) || !inRange(t, MIN_WEIGHT_KG, MAX_WEIGHT_KG)) return null;
    const diff = t - w;
    if (Math.abs(diff) < 1) return null;
    const direction: 'loss' | 'gain' = diff < 0 ? 'loss' : 'gain';
    return { direction, bounds: paceBounds(direction, w), draft: { ...answers, weightKg: w, goalWeightKg: t } };
  }, [answers, weightVal, targetVal, toKg]);

  // Seed / re-seed the rate at the recommended pace whenever direction flips.
  const lastDirection = useRef<'loss' | 'gain' | null>(null);
  useEffect(() => {
    const dir = paceCtx?.direction ?? null;
    if (dir !== lastDirection.current) {
      lastDirection.current = dir;
      setWeeklyRate(paceCtx ? paceCtx.bounds.recommended : null);
    }
  }, [paceCtx]);

  const targets = useMemo(() => {
    if (weeklyRate != null) {
      const paced = paceAdjustedTargets(answers, weeklyRate);
      if (paced) return paced;
    }
    return computeDailyTargets(answers);
  }, [answers, weeklyRate]);

  const starterProgram = useMemo(
    () => buildStarterProgram(answers, { weeklyRateKg: weeklyRate, targets }),
    [answers, weeklyRate, targets],
  );
  const finalProgram = dronaProgram ?? starterProgram;

  // Reveal rows for the road. Each row opens: the one-line summary is what the
  // reveal is for, but a program the user has not read is a program they have
  // not agreed to, so the detail is one tap away rather than on another screen.
  const roadRows = useMemo(() => {
    let offset = 0;
    return finalProgram.phases.map((ph, idx) => {
      const start = offset + 1;
      const end = offset + ph.duration_weeks;
      offset = end;
      const weeks = start === end ? `Wk ${start}` : `Wk ${start}-${end}`;
      // A closed row says only how you eat and train; the why is inside.
      const meta = [
        ph.diet.calories != null ? `${ph.diet.calories.toLocaleString()} kcal` : null,
        // A phase without a named split still says how often you train.
        ph.training_block?.split_type ??
          (ph.training_block?.days_per_week
            ? `${ph.training_block.days_per_week} ${ph.training_block.days_per_week === 1 ? 'day' : 'days'} a week`
            : null),
      ]
        .filter(Boolean)
        .join(' · ');
      const macros = [
        ph.diet.protein_g != null ? { label: 'PROTEIN', value: `${ph.diet.protein_g}g` } : null,
        ph.diet.carb_g != null ? { label: 'CARBS', value: `${ph.diet.carb_g}g` } : null,
        ph.diet.fat_g != null ? { label: 'FAT', value: `${ph.diet.fat_g}g` } : null,
      ].filter(Boolean) as Array<{ label: string; value: string }>;
      // Same three icons the Goal screen uses, so a phase reads the same here
      // as it will there once it is saved.
      const directives = [
        { icon: 'zap' as const, label: 'DIET', text: ph.diet_directive ?? null },
        { icon: 'activity' as const, label: 'TRAINING', text: ph.training_directive ?? null },
        { icon: 'moon' as const, label: 'RECOVERY', text: ph.readiness_directive ?? null },
      ].filter((d) => !!d.text) as Array<{ icon: 'zap' | 'activity' | 'moon'; label: string; text: string }>;
      return {
        key: `${idx}-${ph.name}`,
        weeks,
        name: ph.name,
        meta,
        kcal: ph.diet.calories ?? null,
        macros,
        week: weekPatternFor(ph.training_block),
        split: ph.training_block?.split_type ?? null,
        directives,
      };
    });
  }, [finalProgram]);

  // Which road row is open, if any. One at a time: the reveal is already a long
  // scroll and every open row pushes the save button further away.
  const [openPhase, setOpenPhase] = useState<string | null>(null);

  const paceDate = useMemo(() => {
    if (!paceCtx || weeklyRate == null) return null;
    const iso = projectGoalDateIso(paceCtx.draft, weeklyRate);
    if (!iso) return null;
    const d = new Date(iso);
    const now = new Date();
    const far = d.getTime() - now.getTime() > 330 * 24 * 3600 * 1000;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(far ? { year: 'numeric' } : {}) });
  }, [paceCtx, weeklyRate]);

  const pacedPreview = useMemo(() => {
    if (!paceCtx || weeklyRate == null) return null;
    return paceAdjustedTargets(paceCtx.draft, weeklyRate);
  }, [paceCtx, weeklyRate]);

  // Reveal headline: always a dated, quantified promise (paywall-plan.md,
  // Cal AI's "Lose 11 lbs by August 19" beat). Weight-direction users get
  // their own number and date; holding-steady users get the 12-week strength
  // horizon instead of the old undated PLAN_TITLES tagline.
  const revealTitle = useMemo(() => {
    if (paceCtx && paceDate) {
      // Diff computed in the DISPLAY unit — targetVal/weightVal are already
      // in weightUnit, so the number and its label must both be in that unit.
      // The earlier version converted to kg then labeled "kg" regardless of
      // weightUnit, misrepresenting lbs users' delta on the funnel's
      // highest-stakes screen. Mirrors targetHint's approach further down.
      const diff = Math.abs(targetVal - weightVal).toFixed(1).replace(/\.0$/, '');
      return `${paceCtx.direction === 'loss' ? 'Down' : 'Up'} ${diff} ${weightUnit} by ${paceDate}.`;
    }
    const horizon = new Date(Date.now() + 84 * 24 * 3600 * 1000)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `Visibly stronger by ${horizon}.`;
  }, [paceCtx, paceDate, targetVal, weightVal, weightUnit]);

  // Fire Drona generation the moment the commit step mounts: the hold ritual
  // and confetti buy ~4 s of overlap before the build screen even appears,
  // and BuildMoment absorbs the rest elastically. One shot per session; any
  // failure quietly falls back to the deterministic plan (never surfaced).
  useEffect(() => {
    if (step !== 'commit' || generationStarted.current) return;
    generationStarted.current = true;
    const genStartedAt = Date.now();
    // No cancellation on step change: the user moves commit -> build while
    // the request is in flight, and the result must still land. Post-unmount
    // setState is a no-op in React 18, so this is safe.
    (async () => {
      // Which path built (or tried to build) the program. Outside the try so
      // a failure reports it too.
      let via: 'authed' | 'guest' = 'guest';
      try {
        const direction =
          answers.goalWeightKg && answers.weightKg && Math.abs(answers.goalWeightKg - answers.weightKg) >= 1
            ? answers.goalWeightKg < answers.weightKg ? 'loss' as const : 'gain' as const
            : null;
        const targetsPayload = targets
          ? { kcal: targets.kcal, protein: targets.protein, carb: targets.carb, fat: targets.fat }
          : null;

        const programExtras = { weeklyRateKg: weeklyRate, targets };
        // Drona's program replaces the deterministic road when it arrives.
        // Returns the phase count so the generated event can report what
        // actually landed rather than what was asked for.
        const applyProgram = (raw: Record<string, unknown> | null): number => {
          if (!raw) return 0;
          const mappedProgram = dronaProgramFromStructured(raw, answers, programExtras);
          if (!mappedProgram) return 0;
          setDronaProgram(mappedProgram);
          return mappedProgram.phases.length;
        };

        // ONE forced-tool call, and it is the program. The week of workouts
        // is no longer generated here: it is built after sign-up from the Goal
        // screen, so it lands against a real user id instead of a guest blob.
        let phases = 0;
        // The guest path: structured intake + device id, no account needed.
        const requestGuest = async () => {
          const deviceId = await getDeviceId();
          const intake = buildAnonIntake(answers, {
            weeklyRateKg: weeklyRate,
            direction,
            targets: targetsPayload,
          });
          return requestAnonOnboardingProgram({ deviceId, intake });
        };
        if (isSignedIn && getToken) {
          // Signed-in (re-onboarding / signed in before the intake): the Pro
          // path, with the user's own data and research. A free account may
          // use it once: the server spends the account's one free goal plan
          // (try_claim_free_goal_turn). If that is already spent it answers
          // 402 and this falls back to the deterministic program below. The
          // guest path is not tried: the free plan is once per account.
          via = 'authed';
          const token = await getToken();
          if (!token) throw new Error('no token');
          phases = applyProgram(await requestDronaOnboardingProgram({
            token,
            freshToken: () => getToken({ skipCache: true }),
            message: buildOnboardingProgramMessage(answers, programExtras),
          }));
        } else {
          // Guest-first funnel: no account yet. Anonymous, device-rate-limited
          // route. A 429 or any error just falls through to the deterministic
          // program below; the reveal never knows.
          phases = applyProgram(await requestGuest());
        }
        // Event names kept as they are so the existing funnel still lines
        // up; what onboarding generates is now the program, so it reports
        // phases where it used to report routines.
        track('onboarding_plan_generated', {
          source: 'drona',
          authed: !!(isSignedIn && getToken),
          via,
          phases,
          duration_ms: Date.now() - genStartedAt,
        });
      } catch (e) {
        /* fall back to the deterministic program; the reveal never knows */
        // Tracked because a high fallback rate is invisible in the UI by
        // design, and it is the single best predictor of a weak first plan.
        // `error` tells a spent free goal build ("HTTP 402") from a real
        // failure (a 5xx, a timeout, no token).
        track('onboarding_plan_failed', {
          authed: !!(isSignedIn && getToken),
          via,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 80),
          duration_ms: Date.now() - genStartedAt,
        });
      } finally {
        setBuildReady(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on commit entry
  }, [step]);

  const identity = onboardingIdentity(isSignedIn ? user?.id ?? null : null);

  const goTo = useCallback((next: Step) => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    reportStepChange(next, 'cta');
    setStep(next);
  }, [reportStepChange]);

  // The commit confetti plays on the commit screen and the build screen
  // follows once it lands, so nothing falls over the plan being built.
  // Celebration's own backstop calls this even if the burst never reports
  // its end.
  const finishCelebration = useCallback(() => {
    setCelebrating(false);
    if (step === 'commit') goTo('build');
  }, [step, goTo]);

  const stepIndex = STEP_ORDER.indexOf(step);
  const nextStep = STEP_ORDER[Math.min(stepIndex + 1, STEP_ORDER.length - 1)];
  const prevStep: Step =
    step === 'interlude' || step === 'plan'
      ? (paceCtx ? 'pace' : 'target')
      : STEP_ORDER[Math.max(stepIndex - 1, 0)];

  // Android hardware/gesture back mirrors the header chevron instead of
  // popping the (single-entry) root stack, which would exit the app mid-quiz.
  // Same convention as StartWorkoutModal in the (app) layout.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'welcome') return false; // let the OS handle it
      if (step === 'build') return true; // no backing out mid-build
      if (celebrating) return true; // committed: the build screen is next
      goTo(STEP_ORDER[Math.max(STEP_ORDER.indexOf(step) - 1, 0)]);
      return true;
    });
    return () => sub.remove();
  }, [step, goTo, celebrating]);

  // Single-select answers advance on their own after a beat, so the user sees
  // the selected state land before the screen moves. One tap per question.
  const selectAndAdvance = useCallback(
    (patch: Partial<OnboardingAnswers>) => {
      setAnswers((a) => ({ ...a, ...patch }));
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      const next = nextStep;
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        reportStepChange(next, 'auto_advance');
        setStep(next);
      }, 320);
    },
    [nextStep, reportStepChange],
  );

  const setWeightUnitTo = useCallback((nextUnit: 'kg' | 'lbs') => {
    if (nextUnit === weightUnit) return;
    setWeightVal(displayFromKg(weightKgKept.current, nextUnit));
    setTargetVal(displayFromKg(targetKgKept.current, nextUnit));
    setWeightUnit(nextUnit);
  }, [weightUnit]);

  const setHeightUnitTo = useCallback((nextUnit: 'cm' | 'ft') => {
    if (nextUnit === heightUnit) return;
    if (nextUnit === 'ft') {
      const totalInches = heightCmKept.current / 2.54;
      let feet = Math.floor(totalInches / 12);
      let inches = Math.round(totalInches - feet * 12);
      if (inches >= 12) {
        feet += 1;
        inches = 0;
      }
      const ft = Math.min(7, Math.max(4, feet));
      setHeightFt(ft);
      setHeightIn(inches);
      heightFtLatest.current = ft;
      heightInLatest.current = inches;
      setHeightUnit('ft');
      return;
    }
    setHeightCm(Math.min(MAX_HEIGHT_CM, Math.max(MIN_HEIGHT_CM, Math.round(heightCmKept.current))));
    setHeightUnit('cm');
  }, [heightUnit]);

  const onHeightCm = useCallback((v: number) => {
    setHeightCm(v);
    heightCmKept.current = v;
  }, []);
  const onHeightFt = useCallback((v: number) => {
    setHeightFt(v);
    heightFtLatest.current = v;
    heightCmKept.current = v * 30.48 + heightInLatest.current * 2.54;
  }, []);
  const onHeightIn = useCallback((v: number) => {
    setHeightIn(v);
    heightInLatest.current = v;
    heightCmKept.current = heightFtLatest.current * 30.48 + v * 2.54;
  }, []);

  const commitAgeStep = useCallback(() => {
    setAnswers((a) => ({
      ...a,
      ageYears: inRange(ageYears, MIN_AGE_YEARS, MAX_AGE_YEARS) ? ageYears : null,
    }));
    goTo('height');
  }, [ageYears, goTo]);

  const commitHeightStep = useCallback(() => {
    const cm = heightUnit === 'cm' ? heightCm : Math.round((heightFt * 30.48 + heightIn * 2.54) * 10) / 10;
    setAnswers((a) => ({
      ...a,
      heightCm: inRange(cm, MIN_HEIGHT_CM, MAX_HEIGHT_CM) ? cm : null,
    }));
    goTo('weight');
  }, [heightUnit, heightCm, heightFt, heightIn, goTo]);

  const commitWeightStep = useCallback(() => {
    const kg = toKg(weightVal);
    setAnswers((a) => ({
      ...a,
      weightKg: inRange(kg, MIN_WEIGHT_KG, MAX_WEIGHT_KG) ? kg : null,
    }));
    // Seed the goal weight from the current weight the first time through, so
    // the target step opens on "holding steady" and one flick sets direction.
    if (!targetTouched.current) {
      setTargetVal(weightVal);
      targetKgKept.current = weightKgKept.current;
    }
    goTo('target');
  }, [weightVal, toKg, goTo]);

  const commitTargetStep = useCallback(() => {
    const kg = toKg(targetVal);
    setAnswers((a) => ({
      ...a,
      goalWeightKg: inRange(kg, MIN_WEIGHT_KG, MAX_WEIGHT_KG) ? kg : null,
    }));
    // Pace is only a question when the target sets a direction; holding steady
    // goes straight to the reveal.
    goTo(paceCtx ? 'pace' : 'interlude');
  }, [targetVal, toKg, goTo, paceCtx]);

  // Live hint under the goal-weight ruler: name the direction so the number
  // feels read, not just stored.
  const targetHint = useMemo(() => {
    const diff = Math.round(Math.abs(targetVal - weightVal) * 10) / 10;
    if (diff < 1) return 'Holding steady at your current weight. Good.';
    return targetVal < weightVal
      ? `${diff} ${weightUnit} down. We will set your calories for it.`
      : `${diff} ${weightUnit} up. We will set your calories for it.`;
  }, [targetVal, weightVal, weightUnit]);

  const completeOnboarding = useCallback(
    async (opts: { createPlan: boolean; dest: '/(app)' | '/(app)/routines' }) => {
      if (finishing) return;
      setFinishing(true);
      const target = {
        isGuest: !isSignedIn,
        clerkId: isSignedIn ? user?.id ?? null : null,
        client: supabaseClient,
      };
      try {
        await saveOnboardingProfile(answers, targets, target);
        // Keep the device-local basics (unit preference, goal weight) in sync
        // so Profile reflects the intake immediately.
        basicInfo.setWeightUnit(weightUnit);
        if (answers.goalWeightKg && answers.goalWeightKg > 0) basicInfo.setGoalWeight(answers.goalWeightKg);
        // The program only. The workouts come from the Goal screen's build,
        // which the dashboard prompts for next.
        const firstPhaseId = opts.createPlan ? await saveOnboardingProgram(finalProgram, target) : null;
        await markOnboardingDone(identity);
        if (opts.createPlan) void flushNow();
        track('onboarding_completed', {
          created_plan: opts.createPlan,
          goal: answers.goal ?? null,
          goals: selectedGoals(answers).join(','),
          experience: answers.experience ?? null,
          days_per_week: answers.frequency ?? null,
          routines: 0,
          has_injury_notes: !!answers.healthNotes,
          has_preferences: !!answers.routinePrefs,
          seconds_total: Math.round((Date.now() - onboardingStartedAt.current) / 1000),
          outcome: 'saved',
        });
        // A saved program goes straight on to building phase 1's workouts.
        if (firstPhaseId && opts.dest !== '/(app)/routines') {
          router.replace({ pathname: '/goal-plan', params: { build: 'phase', auto: '1', tour: '1' } } as any);
          return;
        }
        router.replace(opts.dest);
      } catch {
        // Never trap the user at the finish line, but say what happened;
        // everything here is recoverable from Profile and Routines later.
        toast.error("Couldn't save everything. You can finish setup in Profile.");
        track('onboarding_completed', { outcome: 'save_failed', created_plan: opts.createPlan });
        await markOnboardingDone(identity);
        router.replace('/(app)');
      } finally {
        setFinishing(false);
      }
    },
    [answers, targets, finalProgram, finishing, isSignedIn, user?.id, identity, router, toast, flushNow, supabaseClient, basicInfo, weightUnit],
  );

  // Reveal CTA. A fresh visitor has no identity yet, so we stash the finished
  // intake and hand off to the auth screen; the (app) layout saves it under
  // whoever they become (signed-in or guest). Guests / signed-in users
  // re-onboarding save directly through the existing path.
  const finishOnboarding = useCallback(
    async (opts: { createPlan: boolean; dest: '/(app)' | '/(app)/routines' }) => {
      if (finishing) return;
      if (isFreshVisitor) {
        setFinishing(true);
        try {
          await setPendingOnboarding({
            answers,
            targets,
            program: finalProgram,
            programByDrona: dronaProgram != null,
            createPlan: opts.createPlan,
            dest: opts.dest,
            weightUnit,
            goalWeightKg: answers.goalWeightKg ?? null,
          });
          track('onboarding_completed', {
            outcome: 'handed_to_signup',
            created_plan: opts.createPlan,
            goal: answers.goal ?? null,
            goals: selectedGoals(answers).join(','),
            experience: answers.experience ?? null,
            days_per_week: answers.frequency ?? null,
            seconds_total: Math.round((Date.now() - onboardingStartedAt.current) / 1000),
          });
          router.replace('/(auth)');
        } finally {
          setFinishing(false);
        }
        return;
      }
      await completeOnboarding(opts);
    },
    [finishing, isFreshVisitor, answers, targets, finalProgram, dronaProgram, weightUnit, router, completeOnboarding],
  );

  // Onboarding is the front door now, so a fresh visitor (no identity yet)
  // has no plan to save on skip - they just want the sign-in screen for an
  // existing account. A guest or signed-in user re-visiting marks done and
  // returns to the app.
  const skipEverything = useCallback(async () => {
    if (finishing) return;
    track('onboarding_skipped', {
      step,
      step_index: STEP_ORDER.indexOf(step),
      is_fresh_visitor: isFreshVisitor,
      seconds_total: Math.round((Date.now() - onboardingStartedAt.current) / 1000),
    });
    if (isFreshVisitor) {
      router.replace('/(auth)');
      return;
    }
    setFinishing(true);
    try {
      await markOnboardingDone(identity);
      router.replace('/(app)');
    } finally {
      setFinishing(false);
    }
  }, [finishing, isFreshVisitor, identity, router, step]);

  // Placed after every hook (rules of hooks). No auth bounce: onboarding is
  // the front door, so fresh visitors (neither signed-in nor guest) view it
  // and convert at the reveal.
  if (!isLoaded || !guestLoaded) return null;

  const showHeader = step !== 'welcome' && step !== 'build';
  const progressIndex = PROGRESS_STEPS.indexOf(step);

  const welcome = step === 'welcome';

  return (
    <View style={[s.safeArea, { backgroundColor: welcome ? WELCOME_STAGE : C.background }]}>
      {/* The welcome screen IS the demo: the film fills the screen, status bar
          included, and loops behind the two buttons. */}
      {welcome && (
        <>
          <StatusBar style="light" />
          <DemoLoop />
          <LinearGradient
            // Dark well before the link: the food scene's keyboard is near white.
            // It starts below the film's opening words, so it never dims them.
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.85)', 'rgba(0,0,0,0.96)']}
            locations={[0, 0.3, 1]}
            style={s.welcomeScrim}
            pointerEvents="none"
          />
        </>
      )}
      <SafeAreaView style={[s.safeArea, { backgroundColor: welcome ? 'transparent' : C.background }]}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          {showHeader && (
            <OnboardingHeader
              // Once committed, the confetti hands straight to the build.
              onBack={() => { if (!celebrating) goTo(prevStep); }}
              progressIndex={progressIndex}
              progressTotal={PROGRESS_STEPS.length}
            />
          )}

          {step === 'welcome' && (
            <View style={[s.stepFill, s.welcomeFill]}>
              {/* The film carries the promise and the three features; only the
                  buttons sit on top of it, in the bottom quarter it keeps clear. */}
              <Animated.View entering={FadeInDown.delay(500).duration(450)} style={s.footer}>
                <PrimaryCta
                  label="Start with my goal"
                  onPress={() => goTo('goal')}
                  accessibilityLabel="Start setup"
                />
                <TouchableOpacity
                  onPress={skipEverything}
                  disabled={finishing}
                  style={s.ghostLink}
                  accessibilityRole="button"
                  accessibilityLabel={isFreshVisitor ? 'I already have an account' : 'Skip setup'}
                >
                  <Text style={[s.ghostLinkText, { color: WELCOME_LINK }]}>
                    {isFreshVisitor ? 'I already have an account' : 'Skip setup'}
                  </Text>
                </TouchableOpacity>
              </Animated.View>
            </View>
          )}

          {step === 'goal' && (
            <QuestionStep
              stepKey="goal"
              question="What are you training for?"
              sub="Pick all that apply. Change them anytime."
              // One short line, only when it changes something: the goal step
              // must fit one screen with no scroll.
              caption={selectedGoals(answers).includes('fat_loss')
                ? 'To lose fat, you will eat a little less than your body burns.'
                : undefined}
              compact
              keyboardTaps
              scrollRef={goalScrollRef}
              footer={
                <PrimaryCta
                  label="Continue"
                  disabled={!goalStepReady}
                  onPress={() => goTo('experience')}
                />
              }
            >
              <View style={s.optionsCompact}>
                {GOAL_OPTIONS.map((opt, idx) => (
                  <OptionCard
                    key={opt.value}
                    index={idx}
                    icon={opt.icon}
                    title={opt.title}
                    multiple
                    compact
                    selected={selectedGoals(answers).includes(opt.value)}
                    onPress={() => setAnswers((a) => ({ ...a, ...toggleGoal(a, opt.value) }))}
                  />
                ))}
                {/* A goal in their own words: the plan builder and Drona's
                    memory both get it (goal_detail), so a niche goal like a race
                    date or a comeback from injury shapes the program. */}
                <OptionCard
                  index={GOAL_OPTIONS.length}
                  icon="edit-3"
                  title="Something else"
                  multiple
                  compact
                  selected={answers.goalNote != null}
                  onPress={() => {
                    if (answers.goalNote != null) stashedGoalNote.current = answers.goalNote;
                    const next = answers.goalNote == null ? stashedGoalNote.current : null;
                    setAnswers((a) => ({ ...a, goalNote: next }));
                  }}
                />
              </View>
              {answers.goalNote != null && (
                <TextAreaField
                  value={answers.goalNote}
                  onChangeText={(text) => setAnswers((a) => ({ ...a, goalNote: text }))}
                  placeholder="e.g. Run a half marathon in March"
                  accessibilityLabel="Your goal in your own words"
                  autoFocus
                  compact
                />
              )}
            </QuestionStep>
          )}

          {step === 'experience' && (
            <QuestionStep
              stepKey="experience"
              question="How long have you lifted weights?"
              sub="So we start you at the right level."
            >
              <View style={s.options}>
                {EXPERIENCE_OPTIONS.map((opt, idx) => (
                  <OptionCard
                    key={opt.value}
                    index={idx}
                    icon={opt.icon}
                    title={opt.title}
                    sub={opt.sub}
                    selected={answers.experience === opt.value}
                    onPress={() => selectAndAdvance({ experience: opt.value })}
                  />
                ))}
              </View>
            </QuestionStep>
          )}

          {step === 'frequency' && (
            <QuestionStep
              stepKey="frequency"
              question="How many days a week?"
              sub="Pick what you can really keep up. You can change it later."
              footer={<PrimaryCta label="Continue" onPress={() => goTo('health')} />}
            >
                <Animated.View entering={FadeInDown.delay(120).duration(400)} style={{ marginTop: Spacing.lg }}>
                  <FrequencyStory
                    value={answers.frequency ?? 3}
                    onChange={(days) => setAnswers((a) => ({ ...a, frequency: days }))}
                  />
                </Animated.View>
            </QuestionStep>
          )}

          {step === 'health' && (
            <QuestionStep
              stepKey="health"
              question="Anything I should train around?"
              sub="Injuries, pain or past surgeries. We plan around them."
              caption="Optional. Leave it blank if there is nothing."
              keyboardTaps
              footer={
                <PrimaryCta
                  label={answers.healthNotes?.trim() ? 'Continue' : 'Skip for now'}
                  onPress={() => goTo('prefs')}
                />
              }
            >
                <TextAreaField
                  value={answers.healthNotes ?? ''}
                  onChangeText={(text) => setAnswers((a) => ({ ...a, healthNotes: text }))}
                  placeholder="e.g. Sore left knee"
                  accessibilityLabel="Physical or medical notes"
                />
                <MedicalDisclaimer variant="line" style={{ marginTop: Spacing.lg }} />
            </QuestionStep>
          )}

          {step === 'prefs' && (
            <QuestionStep
              stepKey="prefs"
              question="How do you like to train?"
              sub="Home or gym, moves you like, time you have."
              caption="Optional. Leave it blank and we will pick what works best."
              keyboardTaps
              footer={
                <PrimaryCta
                  label={answers.routinePrefs?.trim() ? 'Continue' : 'Skip for now'}
                  onPress={() => goTo('gender')}
                />
              }
            >
                <TextAreaField
                  value={answers.routinePrefs ?? ''}
                  onChangeText={(text) => setAnswers((a) => ({ ...a, routinePrefs: text }))}
                  placeholder="e.g. Home, dumbbells, 45 min"
                  accessibilityLabel="Routine preferences"
                />
            </QuestionStep>
          )}

          {step === 'gender' && (
            <QuestionStep
              stepKey="gender"
              question="What is your sex?"
              sub="It helps us set your calories and your plan."
            >
                <Animated.View entering={FadeInDown.delay(100).duration(400)} style={s.genderCol}>
                  {(
                    [
                      { value: 'M', label: 'Male' },
                      { value: 'F', label: 'Female' },
                      { value: 'O', label: 'Other' },
                    ] as const
                  ).map((g) => {
                    const selected = answers.gender === g.value;
                    return (
                      <PressableScale
                        key={g.value}
                        onPress={() => selectAndAdvance({ gender: g.value })}
                        style={[
                          s.genderChip,
                          {
                            backgroundColor: selected ? C.primaryMuted : C.card,
                            borderColor: selected ? C.primaryBorder : C.borderSubtle,
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={g.label}
                        accessibilityState={{ selected }}
                      >
                        <Text
                          style={[
                            s.genderChipText,
                            { color: selected ? C.accentText : C.textSecondary },
                          ]}
                        >
                          {g.label}
                        </Text>
                      </PressableScale>
                    );
                  })}
                </Animated.View>
            </QuestionStep>
          )}

          {step === 'age' && (
            <QuestionStep
              stepKey="age"
              question="How old are you?"
              sub="It helps us set your daily calories."
              footer={<PrimaryCta label="Continue" onPress={commitAgeStep} />}
            >
                <View style={s.heroCenter}>
                  <NumberWheel
                    min={MIN_AGE_YEARS}
                    max={100}
                    value={ageYears}
                    onChange={setAgeYears}
                    accessibilityLabel="Age in years"
                  />
                </View>
            </QuestionStep>
          )}

          {step === 'height' && (
            <QuestionStep
              stepKey="height"
              question="How tall are you?"
              sub="It helps us set your daily calories."
              footer={<PrimaryCta label="Continue" onPress={commitHeightStep} />}
            >
                <View style={s.heroCenter}>
                  <View style={s.wheelRow}>
                    {heightUnit === 'cm' ? (
                      <NumberWheel
                        min={MIN_HEIGHT_CM}
                        max={220}
                        width={140}
                        value={heightCm}
                        onChange={onHeightCm}
                        accessibilityLabel="Height in centimeters"
                      />
                    ) : (
                      <>
                        <NumberWheel
                          min={4}
                          max={7}
                          width={70}
                          value={heightFt}
                          onChange={onHeightFt}
                          accessibilityLabel="Height, feet"
                        />
                        <NumberWheel
                          min={0}
                          max={11}
                          width={70}
                          value={heightIn}
                          onChange={onHeightIn}
                          accessibilityLabel="Height, inches"
                        />
                      </>
                    )}
                    <UnitWheel
                      options={HEIGHT_UNITS}
                      value={heightUnit}
                      onChange={setHeightUnitTo}
                      accessibilityLabel={`Height unit, now ${heightUnit === 'cm' ? 'centimeters' : 'feet and inches'}`}
                    />
                  </View>
                </View>
            </QuestionStep>
          )}

          {step === 'weight' && (
            <QuestionStep
              stepKey="weight"
              question="What do you weigh today?"
              sub="Just a starting point. We watch the trend."
              footer={<PrimaryCta label="Continue" onPress={commitWeightStep} />}
            >
                <Animated.View entering={FadeInDown.delay(120).duration(400)} style={s.heroCenter}>
                  <View style={s.wheelRow}>
                    <WeightWheel
                      // A new unit is a new scale: start the wheels fresh on it.
                      key={weightUnit}
                      min={WEIGHT_WHEEL[weightUnit].min}
                      max={WEIGHT_WHEEL[weightUnit].max}
                      value={weightVal}
                      onChange={(v) => {
                        setWeightVal(v);
                        weightKgKept.current = kgFromDisplay(v, weightUnit);
                        // Mirror every stop into answers so the saved number, the
                        // reveal and the program all read the wheel's final value.
                        const kg = toKg(v);
                        setAnswers((a) => ({ ...a, weightKg: inRange(kg, MIN_WEIGHT_KG, MAX_WEIGHT_KG) ? kg : null }));
                      }}
                      accessibilityLabel={`Weight in ${weightUnit === 'kg' ? 'kilograms' : 'pounds'}`}
                    />
                    <UnitWheel
                      options={WEIGHT_UNITS}
                      value={weightUnit}
                      onChange={setWeightUnitTo}
                      width={72}
                      accessibilityLabel={`Weight unit, now ${weightUnit}`}
                    />
                  </View>
                </Animated.View>
            </QuestionStep>
          )}

          {step === 'target' && (
            <QuestionStep
              stepKey="target"
              question="What weight do you want to reach?"
              sub="This tells us if you should eat more or less."
              footer={<PrimaryCta label="Continue" onPress={commitTargetStep} />}
            >
                <Animated.View entering={FadeInDown.delay(100).duration(400)} style={s.heroCenter}>
                  <View style={s.wheelRow}>
                    <WeightWheel
                      key={weightUnit}
                      min={WEIGHT_WHEEL[weightUnit].min}
                      max={WEIGHT_WHEEL[weightUnit].max}
                      value={targetVal}
                      onChange={(v) => {
                        targetTouched.current = true;
                        setTargetVal(v);
                        targetKgKept.current = kgFromDisplay(v, weightUnit);
                        // Same mirror as the weight wheel.
                        const kg = toKg(v);
                        setAnswers((a) => ({ ...a, goalWeightKg: inRange(kg, MIN_WEIGHT_KG, MAX_WEIGHT_KG) ? kg : null }));
                      }}
                      accessibilityLabel={`Goal weight in ${weightUnit === 'kg' ? 'kilograms' : 'pounds'}`}
                    />
                    <UnitWheel
                      options={WEIGHT_UNITS}
                      value={weightUnit}
                      onChange={setWeightUnitTo}
                      width={72}
                      accessibilityLabel={`Weight unit, now ${weightUnit}`}
                    />
                  </View>
                  <Text style={[s.targetHint, { color: C.textDim, textAlign: 'center' }]}>{targetHint}</Text>
                </Animated.View>
            </QuestionStep>
          )}

          {step === 'pace' && (
            <QuestionStep
              stepKey="pace"
              question="How fast do you want to get there?"
              sub="Pick a speed you can keep up."
              footer={<PrimaryCta label="Continue" onPress={() => goTo('interlude')} />}
            >
                {paceCtx && weeklyRate != null && (
                  <Animated.View entering={FadeInDown.delay(100).duration(400)} style={{ flexGrow: 1, justifyContent: 'center' }}>
                    <PaceSlider
                      min={paceCtx.bounds.min}
                      max={paceCtx.bounds.max}
                      recommended={paceCtx.bounds.recommended}
                      value={weeklyRate}
                      unitLabel="kg"
                      onChange={setWeeklyRate}
                    />
                    <View style={[s.paceCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                      <Text style={[s.paceCardTitle, { color: C.foreground }]}>
                        Goal by <Text style={{ color: C.accentText }}>{paceDate ?? '...'}</Text>
                      </Text>
                      {pacedPreview && (
                        <Text style={[s.paceCardSub, { color: C.textMuted }]}>
                          Eat about {pacedPreview.kcal.toLocaleString()} calories and {pacedPreview.protein}g protein a day
                        </Text>
                      )}
                      <Text style={[s.paceCardLine, { color: C.textDim }]}>
                        {weeklyRate < paceCtx.bounds.recommended - 0.05
                          ? 'Slower, but easier to keep up on busy weeks.'
                          : weeklyRate > paceCtx.bounds.recommended + 0.05
                            ? 'Fast. You will need enough protein and good sleep.'
                            : 'A steady speed most people can keep up.'}
                      </Text>
                    </View>
                  </Animated.View>
                )}
            </QuestionStep>
          )}

          {step === 'interlude' && (
            <QuestionStep
              stepKey="interlude"
              question="I’m Drona, your coach."
              sub={`${answers.frequency ?? 3} days a week${paceDate ? `, on track for ${paceDate}` : ''}${targets ? `, ${targets.kcal.toLocaleString()} calories a day` : ''}.`}
              footer={<PrimaryCta label="Sounds good" onPress={() => goTo('commit')} />}
            >
                <Animated.View entering={FadeInDown.delay(120).duration(400)} style={s.heroCenter}>
                  {/* The same orb as the paywall's trust screen, so Drona reads
                      as the one setting the route. */}
                  <DronaHeroOrb />
                  <View style={s.claimList}>
                    {[
                      'I make your plan and watch how it goes',
                      'If you fall behind, I change the plan',
                      'So you still reach your goal on time',
                    ].map((line, idx) => (
                      <Animated.View
                        key={line}
                        entering={FadeInDown.delay(260 + idx * 120).duration(400)}
                        style={s.claimRow}
                      >
                        <Feather name="check" size={IconSize.xs} color={C.accentText} />
                        <Text style={[s.claimText, { color: C.textSecondary }]}>{line}</Text>
                      </Animated.View>
                    ))}
                  </View>
                </Animated.View>
            </QuestionStep>
          )}

          {step === 'commit' && (
            <QuestionStep
              stepKey="commit"
              question="Make a promise to yourself."
              sub="A plan only works if you show up."
            >
                <CommitmentHold
                  pledgeTitle="I'm in."
                  pledgeBody={`${joinGoals(selectedGoals(answers).map((g, i) => i === 0 ? GOAL_PHRASES[g] : GOAL_PHRASES[g].toLowerCase()))}, ${answers.frequency ?? 3} days a week${paceCtx && paceDate ? `, ${Math.abs(toKg(targetVal) - toKg(weightVal)).toFixed(1)} kg ${targetVal < weightVal ? 'down' : 'up'} by ${paceDate}` : ''}. I log my sessions, even the rough ones.`}
                  onCommitted={() => setCelebrating(true)}
                />
            </QuestionStep>
          )}

          {step === 'build' && (
            <Animated.View key="build" entering={FadeIn.duration(250)} style={s.stepFill}>
              <BuildMoment
                lines={[
                  'Reading your answers',
                  'Planning the weeks to your goal',
                  'Picking exercises for you',
                  'Working out your daily calories',
                  'Setting up your first week',
                ]}
                ready={buildReady}
                onDone={() => goTo('plan')}
              />
            </Animated.View>
          )}

          {step === 'plan' && (
            <QuestionStep
              stepKey="plan"
              question={revealTitle}
              sub={`${finalProgram.phases.length} ${finalProgram.phases.length === 1 ? 'phase' : 'phases'}, ${answers.frequency ?? 3} ${(answers.frequency ?? 3) === 1 ? 'day' : 'days'} a week${targets ? ', daily calories set' : ''}.`}
              footer={
                <>
                  <PrimaryCta
                    label={isFreshVisitor ? 'Save my plan' : 'Start my plan'}
                    onPress={() => finishOnboarding({ createPlan: true, dest: '/(app)' })}
                    loading={finishing}
                    accessibilityLabel={isFreshVisitor ? 'Save my plan' : 'Start my plan'}
                  />
                  <TouchableOpacity
                    onPress={() => finishOnboarding({ createPlan: false, dest: '/(app)/routines' })}
                    disabled={finishing}
                    style={s.ghostLink}
                    accessibilityRole="button"
                    accessibilityLabel="Build my own routines"
                  >
                    <Text style={[s.ghostLinkText, { color: C.textMuted }]}>I'll build my own routines</Text>
                  </TouchableOpacity>
                </>
              }
            >
                {paceCtx && paceDate && (
                  <Animated.View entering={FadeInDown.delay(80).duration(400)}>
                    <ProjectedCurve
                      direction={paceCtx.direction}
                      startLabel={`Now · ${weightVal} ${weightUnit}`}
                      endLabel={`${paceDate} · ${targetVal} ${weightUnit}`}
                    />
                  </Animated.View>
                )}

                {/* The road: the program's phases, so the reveal shows the whole
                    route to the goal and not just week one. */}
                <Animated.View
                  entering={FadeInDown.delay(90).duration(400)}
                  style={[s.roadCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
                >
                  <Text style={[s.fuelEyebrow, { color: C.textMuted }]}>YOUR PLAN</Text>
                  <Text style={[s.roadTitle, { color: C.foreground }]}>{finalProgram.title}</Text>
                  {finalProgram.objective ? (
                    <ClampedText
                      text={finalProgram.objective}
                      lines={2}
                      style={[s.roadObjective, { color: C.textSecondary }]}
                    />
                  ) : null}
                  <View style={s.roadList}>
                    {roadRows.map((row) => {
                      const open = openPhase === row.key;
                      return (
                        <View key={row.key}>
                          <Pressable
                            onPress={() => setOpenPhase(open ? null : row.key)}
                            style={s.roadRow}
                            hitSlop={6}
                          >
                            <Text style={[s.roadWeeks, { color: C.accentText }]}>{row.weeks}</Text>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={[s.roadName, { color: C.foreground }]} numberOfLines={open ? undefined : 1}>
                                {row.name}
                              </Text>
                              {row.meta && !open ? (
                                <Text style={[s.roadMeta, { color: C.textMuted }]} numberOfLines={1}>{row.meta}</Text>
                              ) : null}
                            </View>
                            <Feather
                              name={open ? 'chevron-up' : 'chevron-down'}
                              size={14}
                              color={C.textMuted}
                              style={{ marginTop: 2 }}
                            />
                          </Pressable>

                          {open && (
                            <Animated.View entering={FadeIn.duration(180)} style={s.roadDetail}>
                              {(row.kcal != null || row.macros.length > 0) && (
                                <View style={s.roadChipRow}>
                                  {row.kcal != null && (
                                    <View
                                      style={[
                                        s.roadChip,
                                        { backgroundColor: C.primaryMuted, borderColor: C.primaryBorder },
                                      ]}
                                    >
                                      <Text style={[s.roadChipValue, { color: C.accentText }]}>
                                        {row.kcal.toLocaleString()}
                                      </Text>
                                      <Text style={[s.roadChipLabel, { color: C.accentText }]}>KCAL / DAY</Text>
                                    </View>
                                  )}
                                  {row.macros.map((m) => (
                                    <View
                                      key={m.label}
                                      style={[s.roadChip, { backgroundColor: C.muted, borderColor: 'transparent' }]}
                                    >
                                      <Text style={[s.roadChipValue, { color: C.foreground }]}>{m.value}</Text>
                                      <Text style={[s.roadChipLabel, { color: C.textMuted }]}>{m.label}</Text>
                                    </View>
                                  ))}
                                </View>
                              )}

                              {row.week && (
                                <View style={{ marginTop: Spacing.md }}>
                                  <Text style={[s.roadDetailLabel, { color: C.textMuted }]}>
                                    {row.split ? `YOUR WEEK · ${row.split}` : 'YOUR WEEK'}
                                  </Text>
                                  <View style={s.roadWeekStrip}>
                                    <View style={[s.roadWeekRule, { backgroundColor: C.borderSubtle }]} />
                                    {row.week.map((label, i) => {
                                      const rest = label === REST;
                                      return (
                                        <View key={i} style={s.roadWeekCell}>
                                          <View
                                            style={[
                                              s.roadWeekDot,
                                              rest
                                                ? { backgroundColor: C.background, borderColor: C.borderSubtle }
                                                : { backgroundColor: C.accentText, borderColor: C.accentText },
                                            ]}
                                          />
                                          <Text style={[s.roadWeekDay, { color: C.textMuted }]}>D{i + 1}</Text>
                                          <Text
                                            numberOfLines={1}
                                            style={[
                                              s.roadWeekLabel,
                                              {
                                                color: rest ? C.textMuted : C.foreground,
                                                fontWeight: rest ? FontWeight.medium : FontWeight.semibold,
                                              },
                                            ]}
                                          >
                                            {shortDayLabel(label)}
                                          </Text>
                                        </View>
                                      );
                                    })}
                                  </View>
                                </View>
                              )}

                              {row.directives.map((d) => (
                                <View key={d.label} style={s.roadDirectiveRow}>
                                  <View style={[s.roadDirectiveIcon, { backgroundColor: C.primaryMuted }]}>
                                    <Feather name={d.icon} size={12} color={C.accentText} />
                                  </View>
                                  <View style={{ flex: 1, minWidth: 0 }}>
                                    <Text style={[s.roadDetailLabel, { color: C.textMuted }]}>{d.label}</Text>
                                    <Text style={[s.roadDetailText, { color: C.textSecondary }]}>{d.text}</Text>
                                  </View>
                                </View>
                              ))}
                            </Animated.View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                </Animated.View>

                {/* Daily fuel targets: the diet half of the intake payoff */}
                {targets ? (
                  <Animated.View
                    entering={FadeInDown.delay(320).duration(400)}
                    style={[s.fuelCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
                  >
                    <Text style={[s.fuelEyebrow, { color: C.textMuted }]}>EAT EACH DAY</Text>
                    <View style={s.fuelKcalRow}>
                      <Text style={[s.fuelKcal, { color: C.foreground }]}>{targets.kcal.toLocaleString()}</Text>
                      <Text style={[s.fuelKcalUnit, { color: C.textMuted }]}>calories a day</Text>
                    </View>
                    <View style={s.macroRow}>
                      {(
                        [
                          { key: 'protein', label: 'Protein', grams: targets.protein },
                          { key: 'carbs', label: 'Carbs', grams: targets.carb },
                          { key: 'fat', label: 'Fat', grams: targets.fat },
                        ] as const
                      ).map((m) => (
                        <View key={m.key} style={s.macroItem}>
                          <View style={[s.macroDot, { backgroundColor: C.macro[m.key] }]} />
                          <Text style={[s.macroText, { color: C.textSecondary }]}>
                            {m.label} <Text style={{ color: C.foreground, fontWeight: FontWeight.semibold }}>{m.grams}g</Text>
                          </Text>
                        </View>
                      ))}
                    </View>
                    {!isSignedIn && (
                      <Text style={[s.fuelNote, { color: C.textDim }]}>
                        Guest targets live on this screen only. Sign in and they follow you to the nutrition tab.
                      </Text>
                    )}
                  </Animated.View>
                ) : (
                  <Animated.Text
                    entering={FadeInDown.delay(320).duration(400)}
                    style={[s.fuelSkipped, { color: C.textDim }]}
                  >
                    Skipped the stats, so no calorie targets yet. Add age and weight in Profile and I will size them.
                  </Animated.Text>
                )}

                {/* Expectation setting, from the narrator */}
                <Animated.View
                  entering={FadeInDown.delay(440).duration(400)}
                  style={[s.coachCard, { backgroundColor: C.primaryMuted, borderColor: C.primaryBorder }]}
                >
                  <View style={[s.coachIcon, { backgroundColor: C.muted }]}>
                    <DronaMark size={12} state="static" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <ClampedText
                      lines={3}
                      style={[s.coachText, { color: C.foreground }]}
                      text={dronaProgram?.rationale ??
                        `Log every session, even the rough ones. I read your sets, watch the trend, and tell you when to add weight. ${targets ? 'Eat to your targets, show' : 'Show'} up ${answers.frequency ?? 3} days a week and the numbers take care of themselves.`}
                    />
                    <Text style={[s.coachSig, { color: C.accentText }]}>COACH DRONA</Text>
                  </View>
                </Animated.View>
            </QuestionStep>
          )}
        </KeyboardAvoidingView>
        {celebrating && <Celebration onDone={finishCelebration} />}
      </SafeAreaView>
    </View>
  );
}

/** The welcome film's dark stage, shown before the first frame paints. */
const WELCOME_STAGE = '#0a0a0a';
/** The secondary link on the film: light in either theme. */
const WELCOME_LINK = 'rgba(255,255,255,0.72)';

/** A long line held to a few lines; a tap opens the rest. */
function ClampedText({ text, lines, style }: { text: string; lines: number; style: StyleProp<TextStyle> }) {
  const [open, setOpen] = useState(false);
  // New text starts closed again.
  useEffect(() => setOpen(false), [text]);
  return (
    <Text
      style={style}
      numberOfLines={open ? undefined : lines}
      onPress={() => setOpen((o) => !o)}
      suppressHighlighting
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityHint={open ? undefined : 'Shows the rest'}
    >
      {text}
    </Text>
  );
}

const s = StyleSheet.create({
  safeArea: { flex: 1 },
  stepFill: { flex: 1 },

  // Welcome
  welcomeFill: { justifyContent: 'flex-end' },
  // Under the buttons only: the film keeps its bottom quarter clear for them.
  welcomeScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '26%' },

  // Question steps
  options: { gap: Spacing.md },
  optionsCompact: { gap: Spacing.sm },


  // Body basics + target
  genderCol: { gap: Spacing.md, marginTop: Spacing.lg },
  genderChip: {
    paddingVertical: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    alignItems: 'center',
  },
  genderChipText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  heroCenter: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  // A value wheel (or two) and the unit wheel beside it.
  wheelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  targetHint: {
    fontSize: FontSize.sm,
    lineHeight: 19,
    marginTop: Spacing.md,
  },
  paceCard: {
    borderRadius: 20,
    borderWidth: 1,
    padding: Spacing.lg,
    marginTop: Spacing.xl,
    alignItems: 'center',
    gap: 4,
  },
  paceCardTitle: {
    fontFamily: FontFamily.onboardingHeading,
    fontSize: 22,
  },
  paceCardSub: { fontSize: FontSize.md },
  paceCardLine: { fontSize: FontSize.sm, textAlign: 'center', marginTop: 2 },

  // Plan
  fuelCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    marginTop: Spacing.md,
  },
  roadCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    marginTop: Spacing.md,
  },
  roadTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: Spacing.xs },
  roadObjective: { fontSize: FontSize.sm, lineHeight: 19, marginTop: 4 },
  roadList: { marginTop: Spacing.md, gap: Spacing.sm },
  roadRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  roadWeeks: {
    width: 64,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    paddingTop: 2,
  },
  roadName: { fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  roadMeta: { fontSize: FontSize.xs, lineHeight: 16, marginTop: 1 },
  roadDetail: { marginTop: Spacing.sm },
  roadDirectiveRow: { flexDirection: 'row', gap: 10, marginTop: Spacing.md, alignItems: 'flex-start' },
  roadDirectiveIcon: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  roadChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  roadChip: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'flex-start',
    gap: 1,
  },
  roadChipValue: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  roadChipLabel: { fontSize: 8, fontWeight: FontWeight.semibold, letterSpacing: 0.7 },
  roadDetailLabel: { fontSize: 9, fontWeight: FontWeight.semibold, letterSpacing: 0.8, marginBottom: 3 },
  roadDetailText: { fontSize: FontSize.sm, lineHeight: 19 },
  roadWeekStrip: { flexDirection: 'row', marginTop: 4 },
  roadWeekRule: { position: 'absolute', left: 12, right: 12, top: 4, height: StyleSheet.hairlineWidth },
  roadWeekCell: { flex: 1, alignItems: 'center', gap: 3 },
  roadWeekDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1 },
  roadWeekDay: { fontSize: 8, fontWeight: FontWeight.semibold, letterSpacing: 0.4 },
  roadWeekLabel: { fontSize: 9, textAlign: 'center' },
  fuelEyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
  },
  fuelKcalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  fuelKcal: {
    fontSize: FontSize.xxxl,
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.tight,
  },
  fuelKcalUnit: { fontSize: FontSize.sm },
  macroRow: {
    flexDirection: 'row',
    gap: Spacing.lg,
    marginTop: Spacing.md,
    flexWrap: 'wrap',
  },
  macroItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  macroDot: { width: 8, height: 8, borderRadius: 4 },
  macroText: { fontSize: FontSize.sm },
  fuelNote: { fontSize: FontSize.xs, lineHeight: 16, marginTop: Spacing.md },
  fuelSkipped: {
    fontSize: FontSize.sm,
    lineHeight: 19,
    marginTop: Spacing.lg,
  },
  coachCard: {
    flexDirection: 'row',
    gap: Spacing.md,
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    marginTop: Spacing.xl,
  },
  coachIcon: {
    width: 24,
    height: 24,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coachText: { fontSize: FontSize.base, lineHeight: 21 },
  coachSig: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginTop: Spacing.sm,
  },

  // Footer / CTAs
  footer: {
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  claimList: { gap: Spacing.lg, marginTop: Spacing.xxl, alignSelf: 'stretch' },
  // Left-aligned rows: centered rows put each check mark in a different place.
  claimRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  claimText: { fontFamily: FontFamily.onboardingBody, fontSize: 16, lineHeight: 22, flexShrink: 1 },
  ghostLink: { alignItems: 'center', paddingVertical: Spacing.lg },
  ghostLinkText: { fontSize: FontSize.base },
});
