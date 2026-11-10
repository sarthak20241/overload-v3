/**
 * Goal intake: one question per screen before Drona plans a new program.
 * Goal, target, timeline, days, session length, where, what to work around,
 * then a review screen where any answer can be changed. Drona speaks above
 * every question (lib/goalIntake dronaLead) and the answers so far stay in a
 * row under the header, each one tap from being changed. A weight goal gets
 * a weight wheel; each timeline shows its end date and the weekly pace. "Ask Drona" hands the
 * answers up (lib/goalIntake goalIntakeMessage); the program chat sends them
 * as its first message, Drona proposes the phases and asks to confirm.
 *
 * Rendered inside the coach sheet (AICoachModal, a Portal). The answers live
 * in this component's own state, inside the portal, so a plain TextInput is
 * safe here (see components/ui/SheetTextInput for the case that is not).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useClerkUser } from '@/hooks/useClerkUser';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { track } from '@/lib/analytics';
import { OptionCard, PrimaryCta } from '@/components/onboarding/OnboardingKit';
import { UnitWheel, WeightWheel } from '@/components/onboarding/BodyPickers';
import { DronaMark } from '@/components/coach/DronaMark';
import { useBasicInfo } from '@/hooks/useBasicInfo';
import { WEIGHT_WHEEL, displayFromKg, kgFromDisplay } from '@/lib/weightWheel';
import { PaceSlider } from '@/components/onboarding/PaceSlider';
import { paceBounds } from '@/lib/onboarding';
import { weightLog as serverWeightLog } from '@/lib/bodyLogSync';
import { useToast } from '@/components/ui/Toast';
import { Colors, FontFamily, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import {
  DAY_CHOICES, INTAKE_STEPS, MINUTE_CHOICES, PLACE_LABELS, TIMELINE_CHOICES, TIMELINE_LABELS,
  afterEdit, dronaLead, formatWeight, toggleIntakeGoal, paceDateText, paceDirection, paceLine, paceWeeks, usesPace, intakeFromProfile, isWeightGoal, reviewRows, stepDone, suggestedTargetKg, targetPrompt,
  timelineDetail, wheelStartKg,
  type GoalIntakeAnswers, type IntakeGoal, type IntakePlace, type IntakeStep, type IntakeTimeline,
} from '@/lib/goalIntake';

const GOAL_OPTIONS: { value: IntakeGoal; title: string; icon: keyof typeof Feather.glyphMap }[] = [
  { value: 'fat_loss', title: 'Lose fat', icon: 'trending-down' },
  { value: 'hypertrophy', title: 'Build muscle', icon: 'trending-up' },
  { value: 'strength', title: 'Get stronger', icon: 'anchor' },
  { value: 'endurance', title: 'Build endurance', icon: 'wind' },
  { value: 'general', title: 'Get fit overall', icon: 'heart' },
  { value: 'other', title: 'Something else', icon: 'edit-3' },
];

const WEIGHT_UNITS = [{ value: 'kg', label: 'kg' }, { value: 'lbs', label: 'lbs' }] as const;

const PLACE_OPTIONS: { value: IntakePlace; icon: keyof typeof Feather.glyphMap }[] = [
  { value: 'gym', icon: 'home' },
  { value: 'home', icon: 'box' },
  { value: 'bodyweight', icon: 'user' },
];

const QUESTION_STEPS: IntakeStep[] = INTAKE_STEPS.filter((s) => s !== 'review');

// A one-tap answer moves on by itself after this long, so the pick is seen.
const AUTO_NEXT_MS = 220;

export function GoalIntake({
  initial,
  onBack,
  onDone,
  onSkip,
}: {
  /** Answers from an earlier pass (back from the chat): opens on review. */
  initial?: GoalIntakeAnswers;
  onBack: () => void;
  onDone: (answers: GoalIntakeAnswers) => void;
  /** Straight to the open chat, no questions. */
  onSkip: () => void;
}) {
  const { C } = useTheme();
  const supabase = useSupabaseClient();
  const { user } = useClerkUser();
  const clerkId = user?.id ?? null;
  const { weightUnit, goalWeight } = useBasicInfo();
  const [a, setA] = useState<GoalIntakeAnswers>(
    () => initial ?? { ...intakeFromProfile(null, weightUnit), targetKg: goalWeight ?? null },
  );
  const [step, setStep] = useState<IntakeStep>(initial ? 'review' : 'goal');
  // Set when an answer chip or a review row opened this step: Continue goes
  // back to the step the user came from (lib/goalIntake afterEdit).
  const [returnTo, setReturnTo] = useState<IntakeStep | null>(null);
  const editing = returnTo != null;
  const openToEdit = (target: IntakeStep) => {
    haptics.tap();
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    setReturnTo(returnTo ?? step);
    setStep(target);
  };
  const touched = useRef(!!initial);
  // The target step's "today's weight" wheel is open in place of the goal wheel.
  const [todayOpen, setTodayOpen] = useState(false);
  // Today's weight when the wheel opened, so an unchanged Save logs nothing.
  const todayBefore = useRef<number | null>(null);
  const toast = useToast();

  // Save on the today wheel: back to the goal wheel, and a changed number is
  // logged as today's weigh-in (the same queued log as Analytics: offline-safe,
  // a later one the same day replaces it, the server copies it to the profile).
  const saveToday = () => {
    setTodayOpen(false);
    const kg = aRef.current.currentKg;
    if (kg == null || kg === todayBefore.current) return;
    if (!clerkId || !isSupabaseConfigured) return;
    serverWeightLog(supabase, clerkId, 'kg').log(kg).then((next) => {
      if (!next) { toast.error('That weight looks off. Check the number.'); return; }
      track('weight_logged', { source: 'goal_intake', entry_count_after: next.length });
      toast.success(`Weigh-in logged: ${formatWeight(kg, aRef.current.unit)}`);
    }, () => toast.error("Couldn't log that weigh-in. Try again from Analytics."));
  };
  // The newest answers, for the auto-advance timer that fires after a render.
  const aRef = useRef(a);
  aRef.current = a;
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pick what the profile already knows (goal, days a week, today's weight,
  // the saved goal weight), unless the user has started answering.
  useEffect(() => {
    if (!clerkId || !isSupabaseConfigured) return;
    let live = true;
    supabase
      .from('user_profiles')
      .select('goal, weekly_target_sessions, weight_kg, goal_weight_kg')
      .eq('clerk_user_id', clerkId)
      .maybeSingle()
      .then(({ data }) => {
        if (!live || touched.current || !data) return;
        const next = intakeFromProfile(data, weightUnit);
        setA({ ...next, targetKg: next.targetKg ?? goalWeight ?? null });
      }, () => {});
    return () => { live = false; };
  }, [clerkId, supabase, weightUnit, goalWeight]);

  // The pace slider's bounds and recommended pace: the same as onboarding.
  const bounds = useMemo(
    () => (usesPace(a) ? paceBounds(paceDirection(a), a.currentKg!) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.goal, a.hasTarget, a.targetKg, a.currentKg],
  );

  // The slider sits on the recommended pace until the user moves it. A new
  // direction (a cut turned into a gain, or back) is a new scale: it starts
  // again on that direction's recommended pace, even after a drag.
  const rateTouched = useRef(false);
  const rateDirection = useRef<'loss' | 'gain' | null>(null);
  useEffect(() => {
    if (!bounds) return;
    const dir = paceDirection(a);
    if (rateDirection.current !== dir) { rateTouched.current = false; rateDirection.current = dir; }
    const r = a.weeklyRateKg;
    const out = r == null || r < bounds.min || r > bounds.max;
    if ((out || !rateTouched.current) && r !== bounds.recommended) {
      setA((prev) => ({ ...prev, weeklyRateKg: bounds.recommended }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, a.weeklyRateKg]);

  // A weight goal opens its wheel already on a number: the saved goal, a
  // first target, or today. Continue keeps it; "Skip" says no number.
  useEffect(() => {
    if (step !== 'target' || !isWeightGoal(a.goal) || a.hasTarget === false) return;
    if (a.hasTarget === true && a.targetKg != null) return;
    setA((prev) => ({ ...prev, hasTarget: true, targetKg: prev.targetKg ?? wheelStartKg(prev) }));
  }, [step, a.goal, a.hasTarget, a.targetKg]);

  useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current); }, []);

  useEffect(() => {
    track('goal_intake_step_viewed', { step });
  }, [step]);

  const set = (patch: Partial<GoalIntakeAnswers>) => {
    touched.current = true;
    setA((prev) => ({ ...prev, ...patch }));
  };

  const goNext = () => {
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    if (returnTo) { setReturnTo(null); setStep(afterEdit(aRef.current, returnTo)); return; }
    const i = INTAKE_STEPS.indexOf(step);
    setStep(INTAKE_STEPS[Math.min(i + 1, INTAKE_STEPS.length - 1)]);
  };

  const goBack = () => {
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    // Back from today's weight cancels: the old number comes back, nothing is logged.
    if (todayOpen) { setTodayOpen(false); set({ currentKg: todayBefore.current }); return; }
    if (returnTo) { setReturnTo(null); setStep(afterEdit(aRef.current, returnTo)); return; }
    const i = INTAKE_STEPS.indexOf(step);
    if (i <= 0) onBack();
    else setStep(INTAKE_STEPS[i - 1]);
  };

  // A single tap that fully answers the step moves on.
  const pickAndNext = (patch: Partial<GoalIntakeAnswers>) => {
    set(patch);
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => { autoTimer.current = null; goNext(); }, AUTO_NEXT_MS);
  };

  const qIndex = QUESTION_STEPS.indexOf(step);
  const progress = step === 'review' ? 1 : (qIndex + 1) / (QUESTION_STEPS.length + 1);
  const canGo = stepDone(step, a);
  // The answers so far, in question order: every step before this one.
  const answered = reviewRows(a).filter(
    (r) => INTAKE_STEPS.indexOf(r.step) < INTAKE_STEPS.indexOf(step) && !!r.value,
  );

  const renderStep = () => {
    switch (step) {
      case 'goal':
        return (
          <Question title="What are you working toward?" sub="Pick all that apply. Drona plans the phases around them.">
            <View style={st.list}>
              {GOAL_OPTIONS.map((o, i) => (
                <OptionCard
                  key={o.value}
                  index={i}
                  compact
                  icon={o.icon}
                  title={o.title}
                  multiple
                  selected={a.goals.includes(o.value)}
                  onPress={() => set(toggleIntakeGoal(a, o.value))}
                />
              ))}
            </View>
            {a.goals.includes('other') && (
              <Field
                value={a.goalNote}
                onChangeText={(t) => set({ goalNote: t })}
                placeholder="e.g. a handstand, or ready for a hiking trip"
                label="Your goal in your words"
                maxLength={200}
                autoFocus
              />
            )}
          </Question>
        );
      case 'target': {
        const p = targetPrompt(a.goal);
        if (isWeightGoal(a.goal)) {
          const shown = a.targetKg ?? wheelStartKg(a);
          const first = suggestedTargetKg(a.goal, a.currentKg);
          if (todayOpen) {
            // Today's weight, set right here: the first target and the pace
            // both start from it, and Save logs it as today's weigh-in.
            const todayShown = a.currentKg ?? a.targetKg ?? 70;
            return (
              <Question title="What do you weigh today?" sub="Saved as today's weigh-in. Your first target and your pace start from it.">
                <View style={st.wheelRow}>
                  <WeightWheel
                    key={a.unit}
                    min={WEIGHT_WHEEL[a.unit].min}
                    max={WEIGHT_WHEEL[a.unit].max}
                    value={displayFromKg(todayShown, a.unit)}
                    onChange={(v) => set({ currentKg: kgFromDisplay(v, a.unit) })}
                    accessibilityLabel={`Today's weight in ${a.unit === 'kg' ? 'kilograms' : 'pounds'}`}
                  />
                  <UnitWheel
                    options={WEIGHT_UNITS}
                    value={a.unit}
                    onChange={(u) => set({ unit: u })}
                    width={72}
                    accessibilityLabel={`Weight unit, now ${a.unit}`}
                  />
                </View>
              </Question>
            );
          }
          return (
            <Question title={p.question} sub="Each phase gets its own checkpoint on the way. You can change it anytime.">
              <Pressable
                onPress={() => {
                  haptics.tap();
                  todayBefore.current = a.currentKg;
                  if (a.currentKg == null) set({ currentKg: a.targetKg ?? 70 });
                  setTodayOpen(true);
                }}
                hitSlop={8}
                style={st.todayRow}
                accessibilityRole="button"
                accessibilityLabel={a.currentKg != null ? `Today: ${formatWeight(a.currentKg, a.unit)}. Change it` : "Add today's weight"}
              >
                <Text style={[st.today, { color: C.mutedFg }]}>
                  {a.currentKg != null ? `Today: ${formatWeight(a.currentKg, a.unit)}` : "Add today's weight"}
                </Text>
                <Feather name="edit-2" size={12} color={C.mutedFg} />
              </Pressable>
              <View style={st.wheelRow}>
                <WeightWheel
                  // A new unit is a new scale: start the wheels fresh on it.
                  key={a.unit}
                  min={WEIGHT_WHEEL[a.unit].min}
                  max={WEIGHT_WHEEL[a.unit].max}
                  value={displayFromKg(shown, a.unit)}
                  onChange={(v) => set({ hasTarget: true, targetKg: kgFromDisplay(v, a.unit) })}
                  accessibilityLabel={`Goal weight in ${a.unit === 'kg' ? 'kilograms' : 'pounds'}`}
                />
                <UnitWheel
                  options={WEIGHT_UNITS}
                  value={a.unit}
                  onChange={(u) => set({ unit: u })}
                  width={72}
                  accessibilityLabel={`Weight unit, now ${a.unit}`}
                />
              </View>
              {first != null && Math.abs(first - shown) >= 0.05 && (
                <Pressable
                  onPress={() => { haptics.selection(); set({ hasTarget: true, targetKg: first }); }}
                  style={({ pressed }) => [st.suggest, { backgroundColor: C.card, borderColor: C.borderSubtle, opacity: pressed ? 0.7 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${formatWeight(first, a.unit)} as a first target`}
                >
                  <Feather name="target" size={13} color={C.accentText} />
                  <Text style={[st.suggestText, { color: C.foreground }]}>
                    A good first target: {formatWeight(first, a.unit)}
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => pickAndNext({ hasTarget: false })}
                hitSlop={8}
                style={st.skipTarget}
                accessibilityRole="button"
                accessibilityLabel="No set number"
              >
                <Text style={[st.skipTargetText, { color: C.mutedFg }]}>
                  {a.hasTarget === false ? 'No set number, picked' : 'No set number? Skip this'}
                </Text>
              </Pressable>
            </Question>
          );
        }
        return (
          <Question title={p.question} sub="A number gives each phase something to aim at. No number is fine too.">
            <View style={st.list}>
              <OptionCard index={0} compact icon="crosshair" title="Yes, I have a number" selected={a.hasTarget === true} onPress={() => set({ hasTarget: true })} />
              <OptionCard index={1} compact icon="minus" title="No set number" selected={a.hasTarget === false} onPress={() => pickAndNext({ hasTarget: false })} />
            </View>
            {a.hasTarget === true && (
              <Field
                value={a.target}
                onChangeText={(t) => set({ target: t })}
                placeholder={p.placeholder}
                label="Your target"
                maxLength={120}
                autoFocus
              />
            )}
          </Question>
        );
      }
      case 'timeline': {
        const today = new Date();
        if (bounds && a.weeklyRateKg != null) {
          // A weight to move: the onboarding pace slider. Faster pace, sooner
          // date; the card under it is the trade-off in one line.
          return (
            <Question title="How fast do we go?" sub="Pick a pace you can hold. The date follows the math.">
              <PaceSlider
                min={bounds.min}
                max={bounds.max}
                recommended={bounds.recommended}
                value={a.weeklyRateKg}
                unitLabel="kg"
                onChange={(rate) => { rateTouched.current = true; set({ weeklyRateKg: rate }); }}
              />
              <View style={[st.paceCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                <Text style={[st.paceCardTitle, { color: C.foreground }]}>
                  {formatWeight(a.targetKg!, a.unit)} by <Text style={{ color: C.accentText }}>{paceDateText(a, today) ?? '...'}</Text>
                </Text>
                <Text style={[st.paceCardSub, { color: C.textMuted }]}>About {paceWeeks(a)} weeks</Text>
                <Text style={[st.paceCardLine, { color: C.textDim }]}>{paceLine(a.weeklyRateKg, bounds.recommended)}</Text>
              </View>
            </Question>
          );
        }
        return (
          <Question title="How long should this block run?" sub="Not sure? Let Drona pick a length that fits your goal.">
            <View style={st.list}>
              {TIMELINE_CHOICES.map((t, i) => (
                <OptionCard
                  key={t}
                  index={i}
                  icon={t === 'none' ? 'compass' : 'calendar'}
                  title={TIMELINE_LABELS[t]}
                  sub={timelineDetail(t, today)}
                  selected={a.timeline === t}
                  onPress={() => pickAndNext({ timeline: t })}
                />
              ))}
            </View>
          </Question>
        );
      }
      case 'days':
        return (
          <Question title="How many days a week can you train?" sub="Pick what you can keep up on a busy week, not your best week.">
            <ChipRow
              items={DAY_CHOICES.map((d) => ({ key: String(d), label: String(d), selected: a.days === d, onPress: () => pickAndNext({ days: d }) }))}
            />
          </Question>
        );
      case 'minutes':
        return (
          <Question title="How long is a session?" sub="Warm-up included.">
            <ChipRow
              items={MINUTE_CHOICES.map((m) => ({ key: String(m), label: `${m} min`, selected: a.minutes === m, onPress: () => pickAndNext({ minutes: m }) }))}
            />
          </Question>
        );
      case 'place':
        return (
          <Question title="Where do you train?" sub="Drona picks exercises you can do there.">
            <View style={st.list}>
              {PLACE_OPTIONS.map((o, i) => (
                <OptionCard key={o.value} index={i} compact icon={o.icon} title={PLACE_LABELS[o.value]} selected={a.place === o.value} onPress={() => pickAndNext({ place: o.value })} />
              ))}
            </View>
          </Question>
        );
      case 'constraints':
        return (
          <Question title="Anything to work around?" sub="An injury, a busy day, a long run or a match on a set day. Leave it empty if not.">
            <Field
              value={a.constraints}
              onChangeText={(t) => set({ constraints: t })}
              placeholder="e.g. sore left knee, long run every Sunday"
              label="What to work around"
              maxLength={300}
              tall
            />
          </Question>
        );
      case 'review':
        return (
          <Question title="Here's what you told me" sub="Tap a line to change it. Next, Drona lays out the phases and checks with you before building.">
            <View style={[st.reviewCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              {reviewRows(a).map((r, i) => (
                <Pressable
                  key={r.step}
                  onPress={() => openToEdit(r.step)}
                  style={({ pressed }) => [st.reviewRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.borderSubtle }, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Change ${r.label}: ${r.value}`}
                >
                  <Text style={[st.reviewLabel, { color: C.mutedFg }]}>{r.label}</Text>
                  <Text style={[st.reviewValue, { color: C.foreground }]} numberOfLines={2}>{r.value}</Text>
                  <Feather name="chevron-right" size={14} color={C.textDim} />
                </Pressable>
              ))}
            </View>
          </Question>
        );
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={st.header}>
        <TouchableOpacity onPress={goBack} style={[st.backBtn, { backgroundColor: C.muted }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="arrow-left" size={16} color={C.foreground} />
        </TouchableOpacity>
        <View style={[st.track, { backgroundColor: C.muted }]}>
          <View style={[st.fill, { width: `${Math.round(progress * 100)}%`, backgroundColor: Colors.primary }]} />
        </View>
        <TouchableOpacity
          onPress={() => { track('goal_intake_skipped', { step }); onSkip(); }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Skip the questions and chat with Drona"
        >
          <Text style={[st.skip, { color: C.mutedFg }]}>Just chat</Text>
        </TouchableOpacity>
      </View>

      {answered.length > 0 && step !== 'review' && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={st.answersBar}
          contentContainerStyle={st.answers}
          keyboardShouldPersistTaps="handled"
        >
          {answered.map((r) => (
            <Pressable
              key={r.step}
              onPress={() => openToEdit(r.step)}
              style={({ pressed }) => [st.answer, { backgroundColor: C.card, borderColor: C.borderSubtle, opacity: pressed ? 0.7 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={`Change ${r.label}: ${r.value}`}
            >
              <Text style={[st.answerText, { color: C.foreground }]} numberOfLines={1}>{r.value}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <Animated.View key={step} entering={FadeIn.duration(200)} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={st.lead}>
            <DronaMark size={16} state="static" />
            <Text style={[st.leadText, { color: C.accentText }]}>{dronaLead(step, a)}</Text>
          </View>
          {renderStep()}
        </ScrollView>
      </Animated.View>

      <View style={st.footer}>
        {step === 'review' ? (
          <PrimaryCta
            label="Ask Drona to plan it"
            onPress={() => { track('goal_intake_sent', { goal: a.goal, timeline: a.timeline, days: a.days }); onDone(a); }}
          />
        ) : (
          todayOpen ? (
            <PrimaryCta label="Save today's weight" onPress={saveToday} />
          ) : (
            <PrimaryCta label={editing ? 'Done' : 'Continue'} onPress={goNext} disabled={!canGo} />
          )
        )}
      </View>
    </View>
  );
}

function Question({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  const { C } = useTheme();
  return (
    <View>
      <Text style={[st.title, { color: C.foreground }]}>{title}</Text>
      <Text style={[st.sub, { color: C.textMuted }]}>{sub}</Text>
      {children}
    </View>
  );
}

function ChipRow({ items }: { items: { key: string; label: string; selected: boolean; onPress: () => void }[] }) {
  const { C } = useTheme();
  return (
    <View style={st.chips}>
      {items.map((it) => (
        <Pressable
          key={it.key}
          onPress={() => { haptics.selection(); it.onPress(); }}
          style={({ pressed }) => [
            st.chip,
            {
              backgroundColor: it.selected ? C.primaryMuted : C.card,
              borderColor: it.selected ? C.primaryBorder : C.borderSubtle,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
          accessibilityRole="button"
          accessibilityState={{ selected: it.selected }}
          accessibilityLabel={it.label}
        >
          <Text style={[st.chipText, { color: it.selected ? C.accentText : C.foreground }]} numberOfLines={1} adjustsFontSizeToFit>{it.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Field({
  value, onChangeText, placeholder, label, maxLength, autoFocus = false, tall = false,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  label: string;
  maxLength: number;
  autoFocus?: boolean;
  tall?: boolean;
}) {
  const { C } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={C.textDim}
      maxLength={maxLength}
      autoFocus={autoFocus}
      multiline={tall}
      textAlignVertical={tall ? 'top' : 'center'}
      style={[st.field, tall && st.fieldTall, { backgroundColor: C.card, borderColor: C.borderSubtle, color: C.foreground }]}
      accessibilityLabel={label}
    />
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg },
  backBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  track: { flex: 1, height: 4, borderRadius: Radius.full, overflow: 'hidden' },
  fill: { height: 4, borderRadius: Radius.full },
  skip: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  body: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, paddingBottom: Spacing.xl },
  title: { fontSize: 24, lineHeight: 30, fontWeight: FontWeight.bold, letterSpacing: -0.3 },
  sub: { fontSize: FontSize.md, lineHeight: 21, marginTop: Spacing.sm, marginBottom: Spacing.xl },
  list: { gap: Spacing.sm },
  // One row, chips share the width: 5 day chips or 4 minute chips fit a phone.
  chips: { flexDirection: 'row', gap: Spacing.sm },
  chip: { flex: 1, height: 52, paddingHorizontal: Spacing.xs, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontSize: 17, fontWeight: FontWeight.semibold },
  field: { marginTop: Spacing.md, minHeight: 52, borderRadius: 16, borderWidth: 1, paddingHorizontal: Spacing.lg, fontSize: 16 },
  fieldTall: { minHeight: 120, paddingTop: Spacing.md, paddingBottom: Spacing.md, lineHeight: 22 },
  reviewCard: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  reviewRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingVertical: 14 },
  reviewLabel: { width: 104, fontSize: FontSize.sm },
  lead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm },
  leadText: { flex: 1, fontSize: FontSize.sm, fontWeight: FontWeight.semibold, lineHeight: 18 },
  answersBar: { flexGrow: 0 },
  answers: { gap: 6, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.sm },
  answer: { height: 30, paddingHorizontal: 12, borderRadius: Radius.full, borderWidth: 1, justifyContent: 'center', maxWidth: 280 },
  answerText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  today: { fontSize: FontSize.md, textAlign: 'center' },
  todayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: 'center', marginBottom: Spacing.sm },
  wheelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  suggest: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', marginTop: Spacing.md, height: 36, paddingHorizontal: 14, borderRadius: Radius.full, borderWidth: 1 },
  suggestText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  skipTarget: { alignSelf: 'center', marginTop: Spacing.lg },
  paceCard: { borderRadius: 20, borderWidth: 1, padding: Spacing.lg, marginTop: Spacing.xl, alignItems: 'center', gap: 4 },
  paceCardTitle: { fontFamily: FontFamily.display, fontSize: 22 },
  paceCardSub: { fontSize: FontSize.md },
  paceCardLine: { fontSize: FontSize.sm, textAlign: 'center', marginTop: 2 },
  skipTargetText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textDecorationLine: 'underline' },
  reviewValue: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  footer: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, paddingBottom: Spacing.lg },
});
