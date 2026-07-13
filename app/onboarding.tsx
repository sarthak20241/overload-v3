/**
 * First-run onboarding: the intake that makes the app worth opening on day
 * one. Seven beats, roughly a minute end to end:
 *
 *   welcome    orientation: what Overload is, in Drona's voice
 *   goal       what the user trains for (rep ranges, calorie direction)
 *   experience how long they've lifted (starting volume)
 *   frequency  days per week (split choice, activity factor)
 *   body       gender, age, height, weight (coach context + BMR math)
 *   target     goal weight (diet direction)
 *   plan       the payoff: starter routines + daily calorie/macro targets
 *              generated from the answers, expectation-setting from the
 *              coach, and the activation CTA
 *
 * Every answer visibly feeds the generated plan (that's what earns the
 * questions), single-select steps auto-advance to cut taps, every step can be
 * skipped, and the flow ends by creating real routines and fuel targets so
 * the dashboard and nutrition screens are personalized from the first open.
 * Permissions are deliberately not requested here (see lib/onboarding.ts).
 */
import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
  BackHandler,
} from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import {
  Colors,
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
  EMPTY_ANSWERS,
  type OnboardingAnswers,
  buildStarterRoutines,
  computeDailyTargets,
  createStarterRoutines,
  saveOnboardingProfile,
  markOnboardingDone,
  onboardingIdentity,
  splitNameFor,
} from '@/lib/onboarding';
import type { CoachGoal, ExperienceLevel } from '@/lib/types';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const LBS_PER_KG = 2.20462;

type Step = 'welcome' | 'goal' | 'experience' | 'frequency' | 'body' | 'target' | 'plan';
const STEP_ORDER: Step[] = ['welcome', 'goal', 'experience', 'frequency', 'body', 'target', 'plan'];
// Segments shown in the progress header (welcome has no header).
const PROGRESS_STEPS: Step[] = ['goal', 'experience', 'frequency', 'body', 'target', 'plan'];

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

const FREQUENCY_OPTIONS = [2, 3, 4, 5, 6];

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
  const [answers, setAnswers] = useState<OnboardingAnswers>(EMPTY_ANSWERS);
  const [finishing, setFinishing] = useState(false);

  // Body/target inputs live as strings until their step commits them.
  const [ageStr, setAgeStr] = useState('');
  const [weightStr, setWeightStr] = useState('');
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>('kg');
  const [heightUnit, setHeightUnit] = useState<'cm' | 'ft'>('cm');
  const [heightCmStr, setHeightCmStr] = useState('');
  const [heightFtStr, setHeightFtStr] = useState('');
  const [heightInStr, setHeightInStr] = useState('');
  const [targetStr, setTargetStr] = useState('');

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
  }, []);

  const plan = useMemo(() => buildStarterRoutines(answers), [answers]);
  const targets = useMemo(() => computeDailyTargets(answers), [answers]);
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

  const parsedWeightKg = useMemo(() => {
    const w = parseFloat(weightStr);
    if (isNaN(w) || w <= 0) return null;
    return weightUnit === 'lbs' ? Math.round((w / LBS_PER_KG) * 10) / 10 : w;
  }, [weightStr, weightUnit]);

  const commitBodyStep = useCallback(() => {
    const age = parseInt(ageStr, 10);
    let heightCm: number | null = null;
    if (heightUnit === 'cm') {
      const h = parseFloat(heightCmStr);
      if (!isNaN(h) && h > 0) heightCm = h;
    } else {
      const ft = parseFloat(heightFtStr);
      const inch = parseFloat(heightInStr) || 0;
      if (!isNaN(ft) && ft > 0) heightCm = Math.round((ft * 30.48 + inch * 2.54) * 10) / 10;
    }
    setAnswers((a) => ({
      ...a,
      ageYears: !isNaN(age) && age > 0 ? age : null,
      heightCm,
      weightKg: parsedWeightKg,
    }));
    goTo('target');
  }, [ageStr, heightUnit, heightCmStr, heightFtStr, heightInStr, parsedWeightKg, goTo]);

  const commitTargetStep = useCallback(() => {
    const t = parseFloat(targetStr);
    const kg = !isNaN(t) && t > 0 ? (weightUnit === 'lbs' ? Math.round((t / LBS_PER_KG) * 10) / 10 : t) : null;
    setAnswers((a) => ({ ...a, goalWeightKg: kg }));
    goTo('plan');
  }, [targetStr, weightUnit, goTo]);

  // Live hint under the goal-weight input: name the direction so the number
  // feels read, not just stored.
  const targetHint = useMemo(() => {
    const t = parseFloat(targetStr);
    const w = parseFloat(weightStr);
    if (isNaN(t) || t <= 0) return 'A number to aim at. Skip it if you train for the craft.';
    if (isNaN(w) || w <= 0) return 'Noted. Add your current weight and I can pace it.';
    const diff = Math.round(Math.abs(t - w) * 10) / 10;
    if (diff < 1) return 'Holding steady at your current weight. Good.';
    return t < w
      ? `A ${diff} ${weightUnit} cut. Your calorie budget will match.`
      : `A ${diff} ${weightUnit} build. We will eat for it.`;
  }, [targetStr, weightStr, weightUnit]);

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
  const showSkip = step !== 'welcome' && step !== 'plan';
  const progressIndex = PROGRESS_STEPS.indexOf(step);

  const skipStep = () => goTo(nextStep);

  return (
    <SafeAreaView style={[s.safeArea, { backgroundColor: C.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        {/* Background glow, same treatment as the auth screen */}
        <View style={[s.bgGlow, { backgroundColor: C.accentText, opacity: 0.04 }]} />

        {showHeader && (
          <View style={s.header}>
            <TouchableOpacity
              onPress={() => goTo(prevStep)}
              style={s.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="chevron-left" size={IconSize.lg} color={C.textMuted} />
            </TouchableOpacity>
            <View style={s.progressTrack}>
              {PROGRESS_STEPS.map((ps, idx) => (
                <View
                  key={ps}
                  style={[
                    s.progressSegment,
                    // accentText, not raw lime: identical in dark, readable on cream in light.
                    { backgroundColor: idx <= progressIndex ? C.accentText : C.muted },
                  ]}
                />
              ))}
            </View>
            {showSkip ? (
              <TouchableOpacity
                onPress={skipStep}
                accessibilityRole="button"
                accessibilityLabel="Skip this step"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[s.skipText, { color: C.textMuted }]}>Skip</Text>
              </TouchableOpacity>
            ) : (
              <View style={s.skipSpacer} />
            )}
          </View>
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
              <PressableScale
                onPress={() => goTo('goal')}
                style={[s.primaryBtn, Shadow.playBtn]}
                accessibilityRole="button"
                accessibilityLabel="Start setup"
              >
                <Text style={s.primaryBtnText}>Let's set you up</Text>
                <Feather name="arrow-right" size={IconSize.sm} color={Colors.primaryFg} />
              </PressableScale>
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
          <Animated.View key="goal" entering={FadeIn.duration(250)} style={s.stepFill}>
            <ScrollView contentContainerStyle={s.stepScroll} showsVerticalScrollIndicator={false}>
              <Text style={[s.eyebrow, { color: C.accentText }]}>THE GOAL</Text>
              <Text style={[s.question, { color: C.foreground }]}>What are you training for?</Text>
              <Text style={[s.questionSub, { color: C.textMuted }]}>
                This decides your rep ranges, rest times, and which way your calories lean.
              </Text>
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
            </ScrollView>
          </Animated.View>
        )}

        {step === 'experience' && (
          <Animated.View key="experience" entering={FadeIn.duration(250)} style={s.stepFill}>
            <ScrollView contentContainerStyle={s.stepScroll} showsVerticalScrollIndicator={false}>
              <Text style={[s.eyebrow, { color: C.accentText }]}>EXPERIENCE</Text>
              <Text style={[s.question, { color: C.foreground }]}>How long have you been lifting?</Text>
              <Text style={[s.questionSub, { color: C.textMuted }]}>
                Sets your starting volume. It grows as you do.
              </Text>
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
            </ScrollView>
          </Animated.View>
        )}

        {step === 'frequency' && (
          <Animated.View key="frequency" entering={FadeIn.duration(250)} style={s.stepFill}>
            <ScrollView contentContainerStyle={s.stepScroll} showsVerticalScrollIndicator={false}>
              <Text style={[s.eyebrow, { color: C.accentText }]}>SCHEDULE</Text>
              <Text style={[s.question, { color: C.foreground }]}>How many days a week?</Text>
              <Text style={[s.questionSub, { color: C.textMuted }]}>
                Be honest. It sets your split and your calorie budget, and a plan you keep beats a plan you admire.
              </Text>
              <Animated.View entering={FadeInDown.delay(120).duration(400)} style={s.freqRow}>
                {FREQUENCY_OPTIONS.map((n) => {
                  const selected = answers.frequency === n;
                  return (
                    <PressableScale
                      key={n}
                      onPress={() => selectAndAdvance({ frequency: n })}
                      style={[
                        s.freqChip,
                        {
                          backgroundColor: selected ? Colors.primary : C.card,
                          borderColor: selected ? Colors.primary : C.borderSubtle,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`${n} days a week`}
                      accessibilityState={{ selected }}
                    >
                      <Text
                        style={[
                          s.freqChipText,
                          { color: selected ? Colors.primaryFg : C.foreground },
                        ]}
                      >
                        {n}
                      </Text>
                    </PressableScale>
                  );
                })}
              </Animated.View>
              <Animated.Text
                entering={FadeInDown.delay(220).duration(400)}
                style={[s.freqHint, { color: C.textDim }]}
              >
                {answers.frequency
                  ? `${splitNameFor(answers.frequency)} split`
                  : 'Your split adapts to the answer'}
              </Animated.Text>
            </ScrollView>
          </Animated.View>
        )}

        {step === 'body' && (
          <Animated.View key="body" entering={FadeIn.duration(250)} style={s.stepFill}>
            <ScrollView
              contentContainerStyle={s.stepScroll}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={[s.eyebrow, { color: C.accentText }]}>ABOUT YOU</Text>
              <Text style={[s.question, { color: C.foreground }]}>The numbers behind the math</Text>
              <Text style={[s.questionSub, { color: C.textMuted }]}>
                These size your calorie and macro targets. Skip anything you'd rather not share.
              </Text>

              <Animated.View entering={FadeInDown.delay(100).duration(400)}>
                <Text style={[s.fieldLabel, { color: C.textMuted }]}>GENDER</Text>
                <View style={s.genderRow}>
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
                        onPress={() =>
                          setAnswers((a) => ({ ...a, gender: selected ? null : g.value }))
                        }
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
                </View>
              </Animated.View>

              <Animated.View entering={FadeInDown.delay(180).duration(400)} style={s.measureRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.fieldLabel, { color: C.textMuted }]}>AGE</Text>
                  <View style={[s.inputWrap, { backgroundColor: C.muted, borderColor: C.border }]}>
                    <TextInput
                      placeholder="24"
                      placeholderTextColor={C.textDim}
                      value={ageStr}
                      onChangeText={setAgeStr}
                      keyboardType="number-pad"
                      maxLength={3}
                      accessibilityLabel="Age in years"
                      style={[s.input, { color: C.foreground }]}
                    />
                    <Text style={[s.inputUnit, { color: C.textMuted }]}>yrs</Text>
                  </View>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.fieldLabel, { color: C.textMuted }]}>WEIGHT</Text>
                  <View style={[s.inputWrap, { backgroundColor: C.muted, borderColor: C.border }]}>
                    <TextInput
                      placeholder={weightUnit === 'kg' ? '72' : '160'}
                      placeholderTextColor={C.textDim}
                      value={weightStr}
                      onChangeText={setWeightStr}
                      keyboardType="numeric"
                      maxLength={6}
                      accessibilityLabel={`Weight in ${weightUnit === 'kg' ? 'kilograms' : 'pounds'}`}
                      style={[s.input, { color: C.foreground }]}
                    />
                    <TouchableOpacity
                      onPress={() => setWeightUnit((u) => (u === 'kg' ? 'lbs' : 'kg'))}
                      accessibilityRole="button"
                      accessibilityLabel={`Switch weight unit, currently ${weightUnit}`}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={[s.inputUnit, { color: C.accentText }]}>{weightUnit}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </Animated.View>

              <Animated.View entering={FadeInDown.delay(260).duration(400)} style={{ marginTop: Spacing.xl }}>
                <Text style={[s.fieldLabel, { color: C.textMuted }]}>HEIGHT</Text>
                {heightUnit === 'cm' ? (
                  <View style={[s.inputWrap, { backgroundColor: C.muted, borderColor: C.border }]}>
                    <TextInput
                      placeholder="175"
                      placeholderTextColor={C.textDim}
                      value={heightCmStr}
                      onChangeText={setHeightCmStr}
                      keyboardType="numeric"
                      maxLength={5}
                      accessibilityLabel="Height in centimeters"
                      style={[s.input, { color: C.foreground }]}
                    />
                    <TouchableOpacity
                      onPress={() => setHeightUnit('ft')}
                      accessibilityRole="button"
                      accessibilityLabel="Switch height unit, currently centimeters"
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={[s.inputUnit, { color: C.accentText }]}>cm</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={s.measureRow}>
                    <View style={[s.inputWrap, { flex: 1, backgroundColor: C.muted, borderColor: C.border }]}>
                      <TextInput
                        placeholder="5"
                        placeholderTextColor={C.textDim}
                        value={heightFtStr}
                        onChangeText={setHeightFtStr}
                        keyboardType="number-pad"
                        maxLength={1}
                        accessibilityLabel="Height, feet"
                        style={[s.input, { color: C.foreground }]}
                      />
                      <TouchableOpacity
                        onPress={() => setHeightUnit('cm')}
                        accessibilityRole="button"
                        accessibilityLabel="Switch height unit, currently feet and inches"
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={[s.inputUnit, { color: C.accentText }]}>ft</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={[s.inputWrap, { flex: 1, backgroundColor: C.muted, borderColor: C.border }]}>
                      <TextInput
                        placeholder="10"
                        placeholderTextColor={C.textDim}
                        value={heightInStr}
                        onChangeText={setHeightInStr}
                        keyboardType="number-pad"
                        maxLength={2}
                        accessibilityLabel="Height, inches"
                        style={[s.input, { color: C.foreground }]}
                      />
                      <Text style={[s.inputUnit, { color: C.textMuted }]}>in</Text>
                    </View>
                  </View>
                )}
              </Animated.View>
            </ScrollView>

            <View style={s.footer}>
              <PressableScale
                onPress={commitBodyStep}
                style={[s.primaryBtn, Shadow.playBtn]}
                accessibilityRole="button"
                accessibilityLabel="Continue"
              >
                <Text style={s.primaryBtnText}>Continue</Text>
                <Feather name="arrow-right" size={IconSize.sm} color={Colors.primaryFg} />
              </PressableScale>
            </View>
          </Animated.View>
        )}

        {step === 'target' && (
          <Animated.View key="target" entering={FadeIn.duration(250)} style={s.stepFill}>
            <ScrollView
              contentContainerStyle={s.stepScroll}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={[s.eyebrow, { color: C.accentText }]}>TARGET</Text>
              <Text style={[s.question, { color: C.foreground }]}>Where are we heading?</Text>
              <Text style={[s.questionSub, { color: C.textMuted }]}>
                A goal weight points your calories the right way. You can change it anytime.
              </Text>

              <Animated.View entering={FadeInDown.delay(100).duration(400)}>
                <Text style={[s.fieldLabel, { color: C.textMuted }]}>GOAL WEIGHT</Text>
                <View style={[s.inputWrap, { backgroundColor: C.muted, borderColor: C.border }]}>
                  <TextInput
                    placeholder={weightUnit === 'kg' ? '68' : '150'}
                    placeholderTextColor={C.textDim}
                    value={targetStr}
                    onChangeText={setTargetStr}
                    keyboardType="numeric"
                    maxLength={6}
                    accessibilityLabel={`Goal weight in ${weightUnit === 'kg' ? 'kilograms' : 'pounds'}`}
                    style={[s.input, { color: C.foreground }]}
                  />
                  <Text style={[s.inputUnit, { color: C.textMuted }]}>{weightUnit}</Text>
                </View>
                <Text style={[s.targetHint, { color: C.textDim }]}>{targetHint}</Text>
              </Animated.View>
            </ScrollView>

            <View style={s.footer}>
              <PressableScale
                onPress={commitTargetStep}
                style={[s.primaryBtn, Shadow.playBtn]}
                accessibilityRole="button"
                accessibilityLabel="Continue"
              >
                <Text style={s.primaryBtnText}>Continue</Text>
                <Feather name="arrow-right" size={IconSize.sm} color={Colors.primaryFg} />
              </PressableScale>
            </View>
          </Animated.View>
        )}

        {step === 'plan' && (
          <Animated.View key="plan" entering={FadeIn.duration(250)} style={s.stepFill}>
            <ScrollView contentContainerStyle={s.stepScroll} showsVerticalScrollIndicator={false}>
              <Text style={[s.eyebrow, { color: C.accentText }]}>YOUR STARTING PLAN</Text>
              <Text style={[s.question, { color: C.foreground }]}>
                {PLAN_TITLES[answers.goal ?? 'general']}
              </Text>
              <Text style={[s.questionSub, { color: C.textMuted }]}>
                {splitNameFor(answers.frequency)}, {answers.frequency ?? 3} days a week
                {targets ? ', with daily fuel targets' : ''}. Every detail is editable.
              </Text>

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
            </ScrollView>

            <View style={s.footer}>
              <PressableScale
                onPress={() => completeOnboarding({ createPlan: true, dest: '/(app)' })}
                disabled={finishing}
                style={[s.primaryBtn, Shadow.playBtn, finishing && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel="Create my plan"
              >
                {finishing ? (
                  <ActivityIndicator size="small" color={Colors.primaryFg} />
                ) : (
                  <>
                    <Text style={s.primaryBtnText}>Create my plan</Text>
                    <Feather name="arrow-right" size={IconSize.sm} color={Colors.primaryFg} />
                  </>
                )}
              </PressableScale>
              <TouchableOpacity
                onPress={() => completeOnboarding({ createPlan: false, dest: '/(app)/routines' })}
                disabled={finishing}
                style={s.ghostLink}
                accessibilityRole="button"
                accessibilityLabel="Build my own routines"
              >
                <Text style={[s.ghostLinkText, { color: C.textMuted }]}>I'll build my own routines</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function OptionCard({
  icon,
  title,
  sub,
  selected,
  onPress,
  index,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  sub: string;
  selected: boolean;
  onPress: () => void;
  index: number;
}) {
  const { C } = useTheme();
  return (
    <Animated.View entering={FadeInDown.delay(100 + index * 60).duration(400)}>
      <PressableScale
        onPress={onPress}
        style={[
          s.option,
          {
            backgroundColor: selected ? C.primaryMuted : C.card,
            borderColor: selected ? C.primaryBorder : C.borderSubtle,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected }}
      >
        <View style={[s.optionIcon, { backgroundColor: C.muted }]}>
          <Feather name={icon} size={IconSize.sm} color={selected ? C.accentText : C.textMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.optionTitle, { color: C.foreground }]}>{title}</Text>
          <Text style={[s.optionSub, { color: C.textMuted }]}>{sub}</Text>
        </View>
        {selected && <Feather name="check" size={IconSize.md} color={C.accentText} />}
      </PressableScale>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  safeArea: { flex: 1 },
  bgGlow: {
    position: 'absolute',
    top: -150,
    left: SCREEN_WIDTH / 2 - 192,
    width: 384,
    height: 384,
    borderRadius: 192,
  },
  stepFill: { flex: 1 },

  // Header: back + progress + skip
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
    gap: Spacing.md,
  },
  backBtn: { padding: 2 },
  progressTrack: { flex: 1, flexDirection: 'row', gap: 6 },
  progressSegment: { flex: 1, height: 3, borderRadius: Radius.full },
  skipText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  skipSpacer: { width: 28 },

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
  stepScroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xxl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xxxl,
  },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginBottom: Spacing.md,
  },
  question: {
    fontSize: FontSize.xxxl,
    fontWeight: FontWeight.black,
    letterSpacing: LetterSpacing.tight,
    lineHeight: 34,
  },
  questionSub: {
    fontSize: FontSize.base,
    lineHeight: 20,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xxl,
  },
  options: { gap: Spacing.md },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.xl,
    borderWidth: 1,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  optionIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  optionSub: { fontSize: FontSize.sm, marginTop: 2 },

  // Frequency
  freqRow: { flexDirection: 'row', gap: Spacing.md, justifyContent: 'center' },
  freqChip: {
    width: 52,
    height: 52,
    borderRadius: Radius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  freqChipText: { fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  freqHint: {
    fontSize: FontSize.sm,
    textAlign: 'center',
    marginTop: Spacing.xl,
  },

  // Body basics + target
  fieldLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    letterSpacing: LetterSpacing.label,
    marginBottom: Spacing.sm,
  },
  genderRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xxl },
  genderChip: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: Radius.xl,
    borderWidth: 1,
    alignItems: 'center',
  },
  genderChipText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  measureRow: { flexDirection: 'row', gap: Spacing.md },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.xl,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    height: 52,
  },
  input: { flex: 1, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  inputUnit: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  targetHint: {
    fontSize: FontSize.sm,
    lineHeight: 19,
    marginTop: Spacing.md,
  },

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
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.xl,
  },
  primaryBtnText: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.primaryFg,
  },
  ghostLink: { alignItems: 'center', paddingVertical: Spacing.lg },
  ghostLinkText: { fontSize: FontSize.base },
});
