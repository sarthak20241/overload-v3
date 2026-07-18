/**
 * First-run onboarding: the intake that makes the app worth opening on day
 * one. Nine beats, roughly a minute end to end:
 *
 *   welcome    orientation: what Overload is, in Drona's voice
 *   goal       what the user trains for (rep ranges, calorie direction)
 *   experience how long they've lifted (starting volume)
 *   frequency  days per week as a story slider (split choice, activity factor)
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
  ActivityIndicator,
  TouchableOpacity,
  BackHandler,
} from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
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
import { useBasicInfo } from '@/hooks/useBasicInfo';
import { useSync } from '@/components/SyncProvider';
import { useToast } from '@/components/ui/Toast';
import { PressableScale } from '@/components/ui/PressableScale';
import {
  OnboardingHeader,
  OptionCard,
  PrimaryCta,
  QuestionStep,
} from '@/components/onboarding/OnboardingKit';
import { NumberWheel, RulerSlider } from '@/components/onboarding/BodyPickers';
import { FrequencyStory } from '@/components/onboarding/FrequencyStory';
import { PaceSlider } from '@/components/onboarding/PaceSlider';
import {
  EMPTY_ANSWERS,
  type OnboardingAnswers,
  buildStarterRoutines,
  computeDailyTargets,
  paceAdjustedTargets,
  paceBounds,
  projectGoalDateIso,
  createStarterRoutines,
  saveOnboardingProfile,
  markOnboardingDone,
  onboardingIdentity,
  splitNameFor,
} from '@/lib/onboarding';
import type { CoachGoal, ExperienceLevel } from '@/lib/types';

const LBS_PER_KG = 2.20462;
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
  | 'welcome' | 'goal' | 'experience' | 'frequency'
  | 'gender' | 'age' | 'height' | 'weight' | 'target' | 'plan';
const STEP_ORDER: Step[] = ['welcome', 'goal', 'experience', 'frequency', 'gender', 'age', 'height', 'weight', 'target', 'plan'];
// Steps counted by the progress header (welcome has no header).
const PROGRESS_STEPS: Step[] = ['goal', 'experience', 'frequency', 'gender', 'age', 'height', 'weight', 'target', 'plan'];

const GOAL_OPTIONS: { value: CoachGoal; icon: keyof typeof Feather.glyphMap; title: string; sub: string }[] = [
  { value: 'hypertrophy', icon: 'layers', title: 'Build muscle', sub: 'Add size with steady, trackable volume' },
  { value: 'strength', icon: 'zap', title: 'Get stronger', sub: 'Push the big lifts heavier' },
  { value: 'fat_loss', icon: 'wind', title: 'Lose fat', sub: 'Cut weight, keep the muscle' },
  { value: 'endurance', icon: 'repeat', title: 'Build endurance', sub: 'Higher reps, shorter rest' },
  { value: 'general', icon: 'compass', title: 'Overall fitness', sub: 'Balanced training that sticks' },
];

const EXPERIENCE_OPTIONS: { value: ExperienceLevel; icon: keyof typeof Feather.glyphMap; title: string; sub: string }[] = [
  { value: 'beginner', icon: 'sunrise', title: 'Just starting out', sub: 'Under a year of training' },
  { value: 'intermediate', icon: 'trending-up', title: 'Finding my groove', sub: 'One to three years in' },
  { value: 'advanced', icon: 'award', title: 'Been at this a while', sub: 'Three plus years under the bar' },
];

const PLAN_TITLES: Record<CoachGoal, string> = {
  hypertrophy: 'Built for growth.',
  strength: 'Built for strength.',
  fat_loss: 'Built to cut, not shrink.',
  endurance: 'Built to last.',
  general: 'Built around you.',
};

export default function OnboardingScreen() {
  const router = useRouter();
  const { C } = useTheme();
  const { user, isSignedIn, isLoaded } = useClerkUser();
  const { isGuest, isLoaded: guestLoaded } = useGuestMode();
  const { flushNow } = useSync();
  const supabaseClient = useSupabaseClient();
  const basicInfo = useBasicInfo();
  const toast = useToast();

  const [step, setStep] = useState<Step>('welcome');
  // Smart defaults (plan, psychology layer): every single-select step arrives
  // pre-answered with the most common choice, so Continue is always one tap and
  // the pre-selection reads as a recommendation.
  const [answers, setAnswers] = useState<OnboardingAnswers>({
    ...EMPTY_ANSWERS,
    goal: 'hypertrophy',
    experience: 'beginner',
    frequency: 3,
  });
  const [finishing, setFinishing] = useState(false);

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
  /** Chosen weekly rate (kg/week); null until a weight direction exists. */
  const [weeklyRate, setWeeklyRate] = useState<number | null>(null);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
  }, []);

  const toDisplay = useCallback(
    (kg: number) => (weightUnit === 'lbs' ? Math.round(kg * LBS_PER_KG) : Math.round(kg * 2) / 2),
    [weightUnit],
  );
  const toKg = useCallback(
    (v: number) => (weightUnit === 'lbs' ? Math.round((v / LBS_PER_KG) * 10) / 10 : v),
    [weightUnit],
  );

  const plan = useMemo(() => buildStarterRoutines(answers), [answers]);

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
  const identity = onboardingIdentity(isSignedIn ? user?.id ?? null : null);

  const goTo = useCallback((next: Step) => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    setStep(next);
  }, []);

  const stepIndex = STEP_ORDER.indexOf(step);
  const nextStep = STEP_ORDER[Math.min(stepIndex + 1, STEP_ORDER.length - 1)];
  const prevStep = STEP_ORDER[Math.max(stepIndex - 1, 0)];

  // Android hardware/gesture back mirrors the header chevron instead of
  // popping the (single-entry) root stack, which would exit the app mid-quiz.
  // Same convention as StartWorkoutModal in the (app) layout.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'welcome') return false; // let the OS handle it
      goTo(STEP_ORDER[Math.max(STEP_ORDER.indexOf(step) - 1, 0)]);
      return true;
    });
    return () => sub.remove();
  }, [step, goTo]);

  // Single-select answers advance on their own after a beat, so the user sees
  // the selected state land before the screen moves. One tap per question.
  const selectAndAdvance = useCallback(
    (patch: Partial<OnboardingAnswers>) => {
      setAnswers((a) => ({ ...a, ...patch }));
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      const next = nextStep;
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        setStep(next);
      }, 320);
    },
    [nextStep],
  );

  const toggleWeightUnit = useCallback(() => {
    const nextUnit = weightUnit === 'kg' ? 'lbs' : 'kg';
    const convert = (v: number) =>
      nextUnit === 'lbs' ? Math.round(v * LBS_PER_KG) : Math.round((v / LBS_PER_KG) * 2) / 2;
    setWeightVal(convert);
    setTargetVal(convert);
    setWeightUnit(nextUnit);
  }, [weightUnit]);

  const toggleHeightUnit = useCallback(() => {
    if (heightUnit === 'cm') {
      const totalInches = heightCm / 2.54;
      let feet = Math.floor(totalInches / 12);
      let inches = Math.round(totalInches - feet * 12);
      if (inches >= 12) {
        feet += 1;
        inches = 0;
      }
      setHeightFt(Math.min(7, Math.max(4, feet)));
      setHeightIn(inches);
      setHeightUnit('ft');
      return;
    }
    setHeightCm(Math.min(MAX_HEIGHT_CM, Math.max(MIN_HEIGHT_CM, Math.round(heightFt * 30.48 + heightIn * 2.54))));
    setHeightUnit('cm');
  }, [heightUnit, heightCm, heightFt, heightIn]);

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
    if (!targetTouched.current) setTargetVal(weightVal);
    goTo('target');
  }, [weightVal, toKg, goTo]);

  const commitTargetStep = useCallback(() => {
    const kg = toKg(targetVal);
    setAnswers((a) => ({
      ...a,
      goalWeightKg: inRange(kg, MIN_WEIGHT_KG, MAX_WEIGHT_KG) ? kg : null,
    }));
    goTo('plan');
  }, [targetVal, toKg, goTo]);

  // Live hint under the goal-weight ruler: name the direction so the number
  // feels read, not just stored.
  const targetHint = useMemo(() => {
    const diff = Math.round(Math.abs(targetVal - weightVal) * 10) / 10;
    if (diff < 1) return 'Holding steady at your current weight. Good.';
    return targetVal < weightVal
      ? `${diff} ${weightUnit} down. Your calorie budget will match.`
      : `${diff} ${weightUnit} up. We will eat for it.`;
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
        if (opts.createPlan) await createStarterRoutines(plan, target);
        await markOnboardingDone(identity);
        if (opts.createPlan) {
          void flushNow();
          toast.success('Your plan is ready. Your first session is on the dashboard.');
        }
        router.replace(opts.dest);
      } catch {
        // Never trap the user at the finish line, but say what happened;
        // everything here is recoverable from Profile and Routines later.
        toast.error("Couldn't save everything. You can finish setup in Profile.");
        await markOnboardingDone(identity);
        router.replace('/(app)');
      } finally {
        setFinishing(false);
      }
    },
    [answers, targets, plan, finishing, isSignedIn, user?.id, identity, router, toast, flushNow, supabaseClient, basicInfo, weightUnit],
  );

  const skipEverything = useCallback(async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await markOnboardingDone(identity);
      router.replace('/(app)');
    } finally {
      setFinishing(false);
    }
  }, [finishing, identity, router]);

  // Same guard class as the (app) layout: only signed-in users and explicit
  // guests belong here. Placed after every hook (rules of hooks).
  if (!isLoaded || !guestLoaded) return null;
  if (!isSignedIn && !isGuest) return <Redirect href="/(auth)" />;

  const showHeader = step !== 'welcome';
  const progressIndex = PROGRESS_STEPS.indexOf(step);

  return (
    <SafeAreaView style={[s.safeArea, { backgroundColor: C.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        {showHeader && (
          <OnboardingHeader
            onBack={() => goTo(prevStep)}
            progressIndex={progressIndex}
            progressTotal={PROGRESS_STEPS.length}
          />
        )}

        {step === 'welcome' && (
          <View style={s.stepFill}>
            <View style={s.welcomeCenter}>
              <Animated.View entering={FadeInUp.duration(500)}>
                <Text style={[s.logoText, { color: C.foreground }]}>
                  OVER<Text style={{ color: C.accentText }}>LOAD</Text>
                </Text>
              </Animated.View>
              <Animated.Text
                entering={FadeInDown.delay(120).duration(500)}
                style={[s.heroTitle, { color: C.foreground }]}
              >
                Strength is built one set at a time.
              </Animated.Text>
              <Animated.Text
                entering={FadeInDown.delay(220).duration(500)}
                style={[s.heroSub, { color: C.textSecondary }]}
              >
                A few quick questions, and I will build your training plan and daily fuel targets around you.
              </Animated.Text>

              <View style={s.valueRows}>
                {(
                  [
                    { icon: 'edit-3', text: 'Log sets in seconds, even offline' },
                    { icon: 'trending-up', text: 'See the strength curve on every lift' },
                    { icon: 'pie-chart', text: 'Calories and macros sized to your stats' },
                    { icon: 'message-circle', text: 'Coach Drona reads your training, not a script' },
                  ] as const
                ).map((row, idx) => (
                  <Animated.View
                    key={row.icon}
                    entering={FadeInDown.delay(340 + idx * 90).duration(450)}
                    style={s.valueRow}
                  >
                    <View style={[s.valueIcon, { backgroundColor: C.muted }]}>
                      <Feather name={row.icon} size={IconSize.xs} color={C.accentText} />
                    </View>
                    <Text style={[s.valueText, { color: C.textSecondary }]}>{row.text}</Text>
                  </Animated.View>
                ))}
              </View>
            </View>

            <Animated.View entering={FadeInDown.delay(700).duration(450)} style={s.footer}>
              <PrimaryCta
                label="Let's set you up"
                onPress={() => goTo('goal')}
                accessibilityLabel="Start setup"
              />
              <TouchableOpacity
                onPress={skipEverything}
                disabled={finishing}
                style={s.ghostLink}
                accessibilityRole="button"
                accessibilityLabel="Skip setup"
              >
                <Text style={[s.ghostLinkText, { color: C.textMuted }]}>I know my way around</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        )}

        {step === 'goal' && (
          <QuestionStep
            stepKey="goal"
            question="What are you training for?"
            sub="This decides your rep ranges, rest times, and which way your calories lean."
            caption="Most lifters start here. You can change it anytime."
          >
            <View style={s.options}>
              {GOAL_OPTIONS.map((opt, idx) => (
                <OptionCard
                  key={opt.value}
                  index={idx}
                  icon={opt.icon}
                  title={opt.title}
                  sub={opt.sub}
                  selected={answers.goal === opt.value}
                  onPress={() => selectAndAdvance({ goal: opt.value })}
                />
              ))}
            </View>
          </QuestionStep>
        )}

        {step === 'experience' && (
          <QuestionStep
            stepKey="experience"
            question="How long have you been lifting?"
            sub="Sets your starting volume. It grows as you do."
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
            sub="Be honest. A plan you keep beats a plan you admire."
            caption={`${splitNameFor(answers.frequency)} split`}
            footer={<PrimaryCta label="Continue" onPress={() => goTo('gender')} />}
          >
              <Animated.View entering={FadeInDown.delay(120).duration(400)} style={{ marginTop: Spacing.lg }}>
                <FrequencyStory
                  value={answers.frequency ?? 3}
                  onChange={(days) => setAnswers((a) => ({ ...a, frequency: days }))}
                />
              </Animated.View>
          </QuestionStep>
        )}

        {step === 'gender' && (
          <QuestionStep
            stepKey="gender"
            question="How should the math read you?"
            sub="Gender changes the calorie equation, nothing else."
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
            sub="Age tunes your calorie baseline."
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
            sub="Height anchors your calorie baseline."
            footer={<PrimaryCta label="Continue" onPress={commitHeightStep} />}
          >
              <View style={s.heroCenter}>
                <View style={s.fieldLabelRow}>
                  <Text style={[s.fieldLabel, { color: C.textMuted }]}>HEIGHT</Text>
                  <TouchableOpacity
                    onPress={toggleHeightUnit}
                    accessibilityRole="button"
                    accessibilityLabel={`Switch height unit, currently ${heightUnit === 'cm' ? 'centimeters' : 'feet and inches'}`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={[s.unitToggle, { color: C.accentText }]}>
                      {heightUnit === 'cm' ? 'cm' : 'ft, in'}
                    </Text>
                  </TouchableOpacity>
                </View>
                {heightUnit === 'cm' ? (
                  <NumberWheel
                    min={MIN_HEIGHT_CM}
                    max={220}
                    width={170}
                    value={heightCm}
                    onChange={setHeightCm}
                    accessibilityLabel="Height in centimeters"
                  />
                ) : (
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <NumberWheel
                      min={4}
                      max={7}
                      width={84}
                      value={heightFt}
                      onChange={setHeightFt}
                      accessibilityLabel="Height, feet"
                    />
                    <NumberWheel
                      min={0}
                      max={11}
                      width={84}
                      value={heightIn}
                      onChange={setHeightIn}
                      accessibilityLabel="Height, inches"
                    />
                  </View>
                )}
              </View>
          </QuestionStep>
        )}

        {step === 'weight' && (
          <QuestionStep
            stepKey="weight"
            question="What do you weigh today?"
            sub="Just a starting point. The trend is what we train."
            footer={<PrimaryCta label="Continue" onPress={commitWeightStep} />}
          >
              <Animated.View entering={FadeInDown.delay(120).duration(400)} style={{ flexGrow: 1, justifyContent: 'center' }}>
                <View style={s.fieldLabelRow}>
                  <Text style={[s.fieldLabel, { color: C.textMuted }]}>WEIGHT</Text>
                  <TouchableOpacity
                    onPress={toggleWeightUnit}
                    accessibilityRole="button"
                    accessibilityLabel={`Switch weight unit, currently ${weightUnit}`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={[s.unitToggle, { color: C.accentText }]}>{weightUnit}</Text>
                  </TouchableOpacity>
                </View>
                <RulerSlider
                  min={weightUnit === 'kg' ? 30 : 66}
                  max={weightUnit === 'kg' ? 200 : 440}
                  step={weightUnit === 'kg' ? 0.5 : 1}
                  value={weightVal}
                  onChange={setWeightVal}
                  unitLabel={weightUnit}
                  accessibilityLabel={`Weight in ${weightUnit === 'kg' ? 'kilograms' : 'pounds'}`}
                />
              </Animated.View>
          </QuestionStep>
        )}

        {step === 'target' && (
          <QuestionStep
            stepKey="target"
            question="Where are we heading?"
            sub="A goal weight points your calories the right way. You can change it anytime."
            footer={<PrimaryCta label="Continue" onPress={commitTargetStep} />}
          >
              <Animated.View entering={FadeInDown.delay(100).duration(400)} style={{ marginTop: Spacing.xl }}>
                <RulerSlider
                  min={weightUnit === 'kg' ? 30 : 66}
                  max={weightUnit === 'kg' ? 200 : 440}
                  step={weightUnit === 'kg' ? 0.5 : 1}
                  value={targetVal}
                  onChange={(v) => {
                    targetTouched.current = true;
                    setTargetVal(v);
                  }}
                  unitLabel={weightUnit}
                  accessibilityLabel={`Goal weight in ${weightUnit === 'kg' ? 'kilograms' : 'pounds'}`}
                />
                <Text style={[s.targetHint, { color: C.textDim, textAlign: 'center' }]}>{targetHint}</Text>

                {paceCtx && weeklyRate != null && (
                  <Animated.View entering={FadeInDown.duration(300)} style={{ marginTop: Spacing.xxl }}>
                    <View style={s.fieldLabelRow}>
                      <Text style={[s.fieldLabel, { color: C.textMuted }]}>PACE</Text>
                    </View>
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
                          Daily fuel: {pacedPreview.kcal.toLocaleString()} kcal · {pacedPreview.protein}g protein
                        </Text>
                      )}
                      <Text style={[s.paceCardLine, { color: C.textDim }]}>
                        {weeklyRate < paceCtx.bounds.recommended - 0.05
                          ? 'A gentler pace. Easier to hold on hard weeks.'
                          : weeklyRate > paceCtx.bounds.recommended + 0.05
                            ? 'Aggressive. Protein and sleep stop being optional.'
                            : 'The balanced pace most people can keep.'}
                      </Text>
                    </View>
                  </Animated.View>
                )}
              </Animated.View>
          </QuestionStep>
        )}

        {step === 'plan' && (
          <QuestionStep
            stepKey="plan"
            question={PLAN_TITLES[answers.goal ?? 'general']}
            sub={`${splitNameFor(answers.frequency)}, ${answers.frequency ?? 3} days a week${targets ? ', with daily fuel targets' : ''}. Every detail is editable.`}
            footer={
              <>
                <PrimaryCta
                  label="Create my plan"
                  onPress={() => completeOnboarding({ createPlan: true, dest: '/(app)' })}
                  loading={finishing}
                  accessibilityLabel="Create my plan"
                />
                <TouchableOpacity
                  onPress={() => completeOnboarding({ createPlan: false, dest: '/(app)/routines' })}
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
              {/* Week dots: the schedule at a glance */}
              <Animated.View entering={FadeInDown.delay(100).duration(400)} style={s.weekDots}>
                {Array.from({ length: 7 }, (_, idx) => (
                  <View
                    key={idx}
                    style={[
                      s.weekDot,
                      {
                        backgroundColor: idx < (answers.frequency ?? 3) ? C.accentText : C.muted,
                      },
                    ]}
                  />
                ))}
                <Text style={[s.weekDotsLabel, { color: C.textMuted }]}>
                  {answers.frequency ?? 3} training days
                </Text>
              </Animated.View>

              <View style={s.planCards}>
                {plan.map((r, idx) => {
                  const names = r.exercises.map((e) => e.name);
                  const preview =
                    names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
                  return (
                    <Animated.View
                      key={r.name}
                      entering={FadeInDown.delay(180 + idx * 80).duration(400)}
                      style={[s.planCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
                    >
                      <View style={[s.planDot, { backgroundColor: r.color }]} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[s.planName, { color: C.foreground }]}>{r.name}</Text>
                        <Text style={[s.planMeta, { color: C.textMuted }]} numberOfLines={1}>
                          {r.exercises.length} exercises · {preview}
                        </Text>
                      </View>
                    </Animated.View>
                  );
                })}
              </View>

              {/* Daily fuel targets: the diet half of the intake payoff */}
              {targets ? (
                <Animated.View
                  entering={FadeInDown.delay(320).duration(400)}
                  style={[s.fuelCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
                >
                  <Text style={[s.fuelEyebrow, { color: C.textMuted }]}>DAILY FUEL</Text>
                  <View style={s.fuelKcalRow}>
                    <Text style={[s.fuelKcal, { color: C.foreground }]}>{targets.kcal.toLocaleString()}</Text>
                    <Text style={[s.fuelKcalUnit, { color: C.textMuted }]}>kcal a day</Text>
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
                  <Feather name="message-circle" size={IconSize.xs} color={C.accentText} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.coachText, { color: C.foreground }]}>
                    Log every session, even the rough ones. I read your sets, watch the trend, and tell
                    you when to add weight. {targets ? 'Eat to your targets, show' : 'Show'} up{' '}
                    {answers.frequency ?? 3} days a week and the numbers take care of themselves.
                  </Text>
                  <Text style={[s.coachSig, { color: C.accentText }]}>COACH DRONA</Text>
                </View>
              </Animated.View>
          </QuestionStep>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safeArea: { flex: 1 },
  stepFill: { flex: 1 },

  // Welcome
  welcomeCenter: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
  },
  logoText: {
    fontSize: FontSize.xl,
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.caps,
    marginBottom: Spacing.xxl,
  },
  heroTitle: {
    fontSize: FontSize.display,
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.tight,
    lineHeight: 42,
  },
  heroSub: {
    fontSize: FontSize.lg,
    lineHeight: 24,
    marginTop: Spacing.lg,
  },
  valueRows: { marginTop: Spacing.xxxl, gap: Spacing.lg },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  valueIcon: {
    width: 24,
    height: 24,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  valueText: { fontSize: FontSize.base, flex: 1, lineHeight: 20 },

  // Question steps
  options: { gap: Spacing.md },


  // Body basics + target
  fieldLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: LetterSpacing.label,
    marginBottom: Spacing.sm,
  },
  genderCol: { gap: Spacing.md, marginTop: Spacing.lg },
  genderChip: {
    paddingVertical: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    alignItems: 'center',
  },
  genderChipText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  heroCenter: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    justifyContent: 'center',
  },
  unitToggle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
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
    fontFamily: FontFamily.display,
    fontSize: 22,
  },
  paceCardSub: { fontSize: FontSize.md },
  paceCardLine: { fontSize: FontSize.sm, textAlign: 'center', marginTop: 2 },

  // Plan
  weekDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: Spacing.xl,
  },
  weekDot: { width: 8, height: 8, borderRadius: 4 },
  weekDotsLabel: { fontSize: FontSize.sm, marginLeft: Spacing.sm },
  planCards: { gap: Spacing.md },
  planCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.xl,
    borderWidth: 1,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  planDot: { width: 8, height: 8, borderRadius: 4 },
  planName: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  planMeta: { fontSize: FontSize.sm, marginTop: 2 },
  fuelCard: {
    borderRadius: Radius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    marginTop: Spacing.md,
  },
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
  ghostLink: { alignItems: 'center', paddingVertical: Spacing.lg },
  ghostLinkText: { fontSize: FontSize.base },
});
