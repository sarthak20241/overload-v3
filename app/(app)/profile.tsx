import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, ActivityIndicator, Modal, Pressable, Keyboard, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useClerkUser } from '@/hooks/useClerkUser';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, {
  FadeInDown, useSharedValue, useAnimatedStyle, withTiming,
  SlideInDown, SlideOutDown, FadeIn, FadeOut, Easing,
} from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { mockProfile, getMockWorkouts } from '@/lib/mockData';
import { getLevelInfo, getTierForLevel } from '@/lib/xp';
import type { CoachGoal, ExperienceLevel } from '@/lib/types';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import {
  loadWeightLog, saveWeightLog, loadBodyFatLog, saveBodyFatLog,
  type WeightEntry, type BodyFatEntry,
} from '@/lib/bodyStats';
import { useBasicInfo } from '@/hooks/useBasicInfo';
import { setGuestMode } from '@/lib/guestMode';
import { useAdminCheck } from '@/hooks/useAdminCheck';

type Gender = 'M' | 'F' | 'O';
type WeightUnit = 'kg' | 'lbs';
type HeightUnit = 'cm' | 'ft';

const ROW_ICON_COLORS = {
  gender: '#a855f7',
  height: '#06b6d4',
  weight: '#10b981',
  goal: '#f59e0b',
  bodyFat: '#ef4444',
  bug: '#f97316',
  trainingGoal: '#84cc16',
  experience: '#3b82f6',
  frequency: '#8b5cf6',
  trainingAge: '#ec4899',
  dob: '#14b8a6',
};

const GOAL_OPTIONS: { value: CoachGoal; label: string }[] = [
  { value: 'hypertrophy', label: 'Hypertrophy' },
  { value: 'strength',    label: 'Strength' },
  { value: 'fat_loss',    label: 'Fat Loss' },
  { value: 'endurance',   label: 'Endurance' },
  { value: 'general',     label: 'General' },
];

const EXPERIENCE_OPTIONS: { value: ExperienceLevel; label: string }[] = [
  { value: 'beginner',     label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced',     label: 'Advanced' },
];

function withAlpha(hex: string, alpha: string) {
  return `${hex}${alpha}`;
}

// ─── Section header ──────────────────────────────────────────────────────────
function SectionLabel({
  icon, children,
}: { icon?: React.ComponentProps<typeof Feather>['name']; children: React.ReactNode }) {
  const { C } = useTheme();
  return (
    <View style={styles.sectionLabelRow}>
      {icon && <Feather name={icon} size={12} color={C.textMuted} />}
      <Text style={[styles.sectionLabelText, { color: C.textMuted }]}>{children}</Text>
    </View>
  );
}

// ─── Row icon tile ───────────────────────────────────────────────────────────
function RowIcon({
  name, color,
}: { name: React.ComponentProps<typeof Feather>['name']; color: string }) {
  return (
    <View style={[styles.rowIcon, { backgroundColor: withAlpha(color, '15') }]}>
      <Feather name={name} size={11} color={color} />
    </View>
  );
}

// ─── Mini segmented toggle (used for cm/ft, kg/lbs, dark/light) ──────────────
function MiniSegmented<T extends string>({
  options, value, onChange, renderOption,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  renderOption?: (opt: T, active: boolean) => React.ReactNode;
}) {
  const { C } = useTheme();
  return (
    <View style={[styles.segmented, { borderColor: C.border, backgroundColor: C.muted }]}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <TouchableOpacity
            key={opt}
            onPress={() => onChange(opt)}
            activeOpacity={0.85}
            style={[
              styles.segmentedOption,
              active && { backgroundColor: Colors.primary },
            ]}
          >
            {renderOption ? (
              renderOption(opt, active)
            ) : (
              <Text style={[
                styles.segmentedText,
                { color: active ? Colors.primaryFg : C.textMuted },
              ]}>
                {opt}
              </Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Compact pill for M/F/O ──────────────────────────────────────────────────
function GenderPills({
  value, onChange,
}: { value: Gender | ''; onChange: (v: Gender) => void }) {
  const { C } = useTheme();
  return (
    <View style={styles.genderRow}>
      {(['M', 'F', 'O'] as Gender[]).map((opt) => {
        const active = value === opt;
        return (
          <TouchableOpacity
            key={opt}
            onPress={() => onChange(opt)}
            activeOpacity={0.85}
            style={[
              styles.genderPill,
              {
                backgroundColor: active ? Colors.primary : 'transparent',
                borderColor: active ? Colors.primary : C.borderLight,
              },
            ]}
          >
            <Text style={[
              styles.genderPillText,
              { color: active ? Colors.primaryFg : C.textSecondary },
            ]}>
              {opt}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Inline number input used in info rows ───────────────────────────────────
function InlineNumberInput({
  value, onChangeText, placeholder, width = 70,
}: { value: string; onChangeText: (v: string) => void; placeholder?: string; width?: number }) {
  const { C } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={C.textDim}
      keyboardType="numeric"
      style={[
        styles.numberInput,
        {
          width,
          backgroundColor: C.glowBg,
          borderColor: C.borderSubtle,
          color: C.foreground,
        },
      ]}
    />
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { C, mode, toggleTheme } = useTheme();
  const { user, signOut: clerkSignOut } = useClerkUser();
  const supabase = useSupabaseClient();
  // Admin status determines whether the "Admin Tools" section renders.
  // The dashboard route itself re-checks via RLS, so this is a UX gate.
  const { isAdmin } = useAdminCheck();
  const signOut = async () => {
    try { await clerkSignOut(); } catch {}
    // Clear the guest flag too — sign-out should always land on /(auth),
    // regardless of how the user originally got into /(app).
    await setGuestMode(false);
    router.replace('/(auth)');
  };
  const [deletingAccount, setDeletingAccount] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gender, setGender] = useState<Gender | ''>('M');
  const [height, setHeight] = useState('178');
  const [weight, setWeight] = useState('78');
  const [goalWeight, setGoalWeight] = useState('75');
  const [bodyFat, setBodyFat] = useState('16');
  const {
    weightUnit,
    setWeightUnit,
    setGoalWeight: setCtxGoalWeight,
  } = useBasicInfo();
  const [heightUnit, setHeightUnit] = useState<HeightUnit>('cm');
  const [totalXP, setTotalXP] = useState(0);
  const [totalWorkouts, setTotalWorkouts] = useState(0);
  const [joinDate, setJoinDate] = useState('');
  const [weightLog, setWeightLog] = useState<WeightEntry[]>([]);
  const [bodyFatLog, setBodyFatLog] = useState<BodyFatEntry[]>([]);
  // Coach context (Phase 0). Empty string = unset / show placeholder.
  const [coachGoal, setCoachGoal] = useState<CoachGoal | ''>('');
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel | ''>('');
  const [weeklyTargetSessions, setWeeklyTargetSessions] = useState('');
  const [trainingAgeMonths, setTrainingAgeMonths] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [showSignOutAlert, setShowSignOutAlert] = useState(false);
  const [showErrorAlert, setShowErrorAlert] = useState('');
  const [showInfoAlert, setShowInfoAlert] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Bug report modal
  const [bugModalOpen, setBugModalOpen] = useState(false);
  const [bugTitle, setBugTitle] = useState('');
  const [bugDescription, setBugDescription] = useState('');
  const [bugCategory, setBugCategory] = useState<'ui' | 'data' | 'crash' | 'performance' | 'other'>('ui');
  const [bugSubmitting, setBugSubmitting] = useState(false);

  // Keyboard avoidance for the bug-report sheet. On iOS, KeyboardAvoidingView
  // nested inside a transparent <Modal> doesn't lift the sheet — the parent
  // Modal does not resize for the keyboard, so the inputs and Submit button
  // remain hidden behind it. We track keyboard height ourselves and apply
  // marginBottom to the sheet (the proven pattern from analytics.tsx).
  const [bugKbHeight, setBugKbHeight] = useState(0);
  useEffect(() => {
    if (!bugModalOpen) { setBugKbHeight(0); return; }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setBugKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setBugKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, [bugModalOpen]);

  const userName = user?.firstName || user?.fullName || 'Athlete';
  const isGuest = !user;
  const initials = userName
    .split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  const { level, xpInLevel, xpNeeded } = getLevelInfo(totalXP);
  const tier = getTierForLevel(level);
  const levelProgress = xpNeeded > 0 ? xpInLevel / xpNeeded : 0;

  // Goal progress derived from current weight, goal, and starting weight from log
  const goalProgress = (() => {
    const current = parseFloat(weight);
    const goal = parseFloat(goalWeight);
    if (isNaN(current) || isNaN(goal) || current <= 0 || goal <= 0) return null;
    const startWeight = weightLog.length > 0 ? weightLog[0].weight : current;
    const totalDelta = Math.abs(startWeight - goal);
    const currentDelta = Math.abs(current - goal);
    const pct = totalDelta > 0
      ? Math.max(0, Math.min(1, 1 - currentDelta / totalDelta))
      : (Math.abs(current - goal) < 0.5 ? 1 : 0);
    const diff = current - goal;
    let label = '';
    if (Math.abs(diff) < 0.5) label = 'At goal!';
    else if (diff > 0) label = `${diff.toFixed(1)} to lose`;
    else label = `${Math.abs(diff).toFixed(1)} to gain`;
    return { pct, label };
  })();

  useEffect(() => {
    loadProfile();
    loadLogs();
  }, []);

  const loadLogs = async () => {
    const [wl, bfl] = await Promise.all([loadWeightLog(), loadBodyFatLog()]);
    setWeightLog(wl);
    setBodyFatLog(bfl);
  };

  const loadProfile = async () => {
    try {
      if (!isSupabaseConfigured) {
        const p = mockProfile;
        setGender(p.gender as Gender);
        setHeight(String(p.height_cm));
        setWeight(String(p.weight_kg));
        setGoalWeight(String(p.goal_weight_kg));
        setCtxGoalWeight(p.goal_weight_kg);
        setBodyFat(String(p.body_fat_percent));
        setTotalXP(p.xp);
        setJoinDate(new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }));
        setTotalWorkouts(getMockWorkouts().length);
        return;
      }
      const clerkId = user?.id;
      const profileQuery = clerkId
        ? supabase.from('user_profiles').select('*').eq('clerk_user_id', clerkId).maybeSingle()
        : supabase.from('user_profiles').select('*').limit(1).maybeSingle();
      const countQuery = clerkId
        ? supabase.from('workouts').select('*', { count: 'exact', head: true }).eq('user_id', clerkId)
        : supabase.from('workouts').select('*', { count: 'exact', head: true });
      const [{ data: profile }, { count }] = await Promise.all([profileQuery, countQuery]);
      if (profile) {
        setGender((profile.gender || 'M') as Gender);
        setHeight(String(profile.height_cm || 178));
        setWeight(String(profile.weight_kg || 78));
        setGoalWeight(String(profile.goal_weight_kg || 75));
        // Propagate a cleared goal (null/0) to context too, else it stays stale.
        setCtxGoalWeight(profile.goal_weight_kg && profile.goal_weight_kg > 0 ? profile.goal_weight_kg : null);
        setBodyFat(String(profile.body_fat_percent || 16));
        setTotalXP(profile.xp || 0);
        setJoinDate(profile.created_at ? new Date(profile.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '');
        setCoachGoal((profile.goal as CoachGoal | null) || '');
        setExperienceLevel((profile.experience_level as ExperienceLevel | null) || '');
        setWeeklyTargetSessions(profile.weekly_target_sessions != null ? String(profile.weekly_target_sessions) : '');
        setTrainingAgeMonths(profile.training_age_months != null ? String(profile.training_age_months) : '');
        setBirthYear(profile.date_of_birth ? String(new Date(profile.date_of_birth).getFullYear()) : '');
      }
      setTotalWorkouts(count || 0);
    } catch (err: any) {
      setShowErrorAlert(err?.message || 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const persistField = async (patch: Record<string, unknown>) => {
    const clerkId = user?.id;
    if (!clerkId || !isSupabaseConfigured) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('user_profiles').upsert({
        clerk_user_id: clerkId,
        ...patch,
      }, { onConflict: 'clerk_user_id' });
      if (error) throw error;
    } catch (err: any) {
      setShowErrorAlert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const logWeight = async () => {
    const num = parseFloat(weight);
    if (isNaN(num) || num <= 0) {
      setShowErrorAlert('Enter a valid weight first');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const entry: WeightEntry = { date: new Date().toISOString(), weight: num };
    const latest = weightLog.length > 0 ? weightLog[weightLog.length - 1] : null;
    const updated = latest && latest.date.slice(0, 10) === today
      ? [...weightLog.slice(0, -1), entry]
      : [...weightLog, entry];
    setWeightLog(updated);
    await saveWeightLog(updated);
    setShowInfoAlert('Weight logged');
  };

  const logBodyFat = async () => {
    const num = parseFloat(bodyFat);
    if (isNaN(num) || num <= 0 || num > 60) {
      setShowErrorAlert('Enter a valid body fat %');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const entry: BodyFatEntry = { date: new Date().toISOString(), bodyFat: num };
    const latest = bodyFatLog.length > 0 ? bodyFatLog[bodyFatLog.length - 1] : null;
    const updated = latest && latest.date.slice(0, 10) === today
      ? [...bodyFatLog.slice(0, -1), entry]
      : [...bodyFatLog, entry];
    setBodyFatLog(updated);
    await saveBodyFatLog(updated);
    setShowInfoAlert('Body fat logged');
  };

  const handleSignOut = () => setShowSignOutAlert(true);

  const confirmSignOut = async () => {
    setShowSignOutAlert(false);
    await signOut();
    router.replace('/(auth)');
  };

  const confirmDeleteAccount = async () => {
    setDeleteConfirm(false);
    setDeletingAccount(true);
    try {
      if (isSupabaseConfigured && user?.id) {
        // Single transactional wipe on the server, plus Clerk user deletion.
        const { error } = await supabase.functions.invoke('delete-account');
        if (error) throw error;
      }
      // Clerk's user.delete() is no-op if the edge function already deleted it,
      // and required if we're in a no-Supabase configuration. Fall back to
      // sign-out if the SDK doesn't expose delete().
      if (user && (user as any).delete) {
        try { await (user as any).delete(); } catch { /* already deleted */ }
      } else {
        await clerkSignOut();
      }
      router.replace('/(auth)');
    } catch (err: any) {
      setDeletingAccount(false);
      setShowErrorAlert(err.errors?.[0]?.longMessage || err.message || 'Failed to delete account');
    }
  };

  const submitBugReport = async () => {
    if (!bugTitle.trim()) return;
    setBugSubmitting(true);
    try {
      if (isSupabaseConfigured) {
        const { error } = await supabase.from('bug_reports').insert({
          user_id: user?.id ?? null,
          title: bugTitle.trim(),
          description: bugDescription.trim() || null,
          category: bugCategory,
          app_version: Constants.expoConfig?.version ?? null,
          platform: Platform.OS,
          os_version: String(Platform.Version),
        });
        if (error) {
          setShowErrorAlert(`Couldn't send report: ${error.message}`);
          return;
        }
      }
      setBugTitle('');
      setBugDescription('');
      setBugCategory('ui');
      setBugModalOpen(false);
      setShowInfoAlert('Bug report submitted — thanks!');
    } catch (e) {
      // A rejected/throwing insert (network drop, etc.) skips the { error }
      // path above — surface it instead of silently swallowing the failure.
      setShowErrorAlert(`Couldn't send report: ${e instanceof Error ? e.message : 'please try again.'}`);
    } finally {
      setBugSubmitting(false);
    }
  };

  // Animated XP bar
  const progressWidth = useSharedValue(0);
  useEffect(() => { progressWidth.value = withTiming(levelProgress, { duration: 800 }); }, [levelProgress]);
  const progressStyle = useAnimatedStyle(() => ({ width: `${progressWidth.value * 100}%` as any }));

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
        <ActivityIndicator color={Colors.primary} style={{ marginTop: 100 }} />
      </SafeAreaView>
    );
  }

  return (
    <>
      <SafeAreaView style={[styles.safe, { backgroundColor: C.background }]} edges={['top']}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 120 }}
        >
          {/* ─── Hero / Avatar ─── */}
          <Animated.View entering={FadeInDown.duration(400)} style={styles.hero}>
            <View style={styles.avatarWrap}>
              <View style={[
                styles.avatar,
                {
                  backgroundColor: C.circleBg,
                  borderWidth: mode === 'light' ? 1 : 0,
                  borderColor: mode === 'light' ? withAlpha(C.accentText, '33') : 'transparent',
                },
              ]}>
                <Text style={[styles.avatarLetter, { color: C.circleFg }]}>{initials}</Text>
              </View>
              {isGuest ? (
                <View style={styles.guestBadge}>
                  <Text style={styles.guestBadgeText}>GUEST</Text>
                </View>
              ) : (
                <View style={[styles.levelBadge, { backgroundColor: tier.color }]}>
                  <Text style={styles.levelBadgeText}>{level}</Text>
                </View>
              )}
            </View>

            <Text style={[styles.heroName, { color: C.foreground }]}>{userName}</Text>
            <Text style={[styles.heroEmail, { color: C.textMuted }]} numberOfLines={1}>
              {isGuest ? 'Guest account' : user?.emailAddresses?.[0]?.emailAddress || '—'}
            </Text>

            <View style={styles.heroBadges}>
              {joinDate ? (
                <View style={[styles.heroBadge, {
                  backgroundColor: C.glowBg,
                  borderColor: C.borderLight,
                }]}>
                  <Text style={[styles.heroBadgeText, { color: C.textSecondary }]}>Since {joinDate}</Text>
                </View>
              ) : null}
              <View style={[styles.heroBadge, {
                backgroundColor: C.primaryMuted,
                borderColor: C.primaryBorder,
              }]}>
                <Text style={[styles.heroBadgeText, { color: C.accentText }]}>{totalWorkouts} workouts</Text>
              </View>
            </View>
          </Animated.View>

          {/* ─── XP Card ─── */}
          <View style={styles.section}>
            <View style={[styles.xpCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              <View style={styles.xpHeader}>
                <View style={[
                  styles.xpAvatar,
                  {
                    backgroundColor: withAlpha(tier.color, '20'),
                  },
                ]}>
                  <Text style={[styles.xpAvatarText, { color: tier.color }]}>{level}</Text>
                </View>
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <View style={styles.xpTitleRow}>
                    <Text style={styles.xpIcon}>{tier.icon}</Text>
                    <Text style={[styles.xpTitle, { color: tier.color }]}>{tier.title}</Text>
                  </View>
                  <Text style={[styles.xpTotal, { color: C.textMuted }]}>
                    {totalXP.toLocaleString()} total XP
                  </Text>
                </View>
              </View>
              <View style={styles.xpProgressRow}>
                <Text style={[styles.xpProgressLabel, { color: C.textMuted }]}>
                  Level {level} → {level + 1}
                </Text>
                <Text style={[styles.xpProgressValue, { color: C.textDim }]}>
                  {xpInLevel} / {xpNeeded} XP
                </Text>
              </View>
              <View style={[styles.xpTrack, { backgroundColor: withAlpha(tier.color, '12') }]}>
                <Animated.View style={[styles.xpFill, { backgroundColor: tier.color }, progressStyle]} />
              </View>
              <Text style={[styles.xpPercent, { color: C.textDim }]}>
                {Math.round(levelProgress * 100)}% to next level
              </Text>
            </View>
          </View>

          {/* ─── Basic Information ─── */}
          <View style={styles.section}>
            <SectionLabel icon="user">BASIC INFORMATION</SectionLabel>
            <View style={[styles.infoCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              {/* Gender */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="user" color={ROW_ICON_COLORS.gender} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Gender</Text>
                <View style={styles.infoRight}>
                  <GenderPills value={gender} onChange={(v) => {
                    setGender(v);
                    persistField({ gender: v });
                  }} />
                </View>
              </View>

              {/* Height */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="bar-chart-2" color={ROW_ICON_COLORS.height} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Height</Text>
                <View style={styles.infoRight}>
                  <InlineNumberInput
                    value={height}
                    onChangeText={(v) => {
                      setHeight(v);
                      persistField({ height_cm: parseFloat(v) || null });
                    }}
                    placeholder={heightUnit === 'cm' ? '175' : '5.9'}
                  />
                  <MiniSegmented
                    options={['cm', 'ft'] as HeightUnit[]}
                    value={heightUnit}
                    onChange={setHeightUnit}
                  />
                </View>
              </View>

              {/* Weight */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="anchor" color={ROW_ICON_COLORS.weight} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Weight</Text>
                <View style={styles.infoRight}>
                  <InlineNumberInput
                    value={weight}
                    onChangeText={(v) => {
                      setWeight(v);
                      persistField({ weight_kg: parseFloat(v) || null });
                    }}
                    placeholder={weightUnit === 'kg' ? '75' : '165'}
                  />
                  <MiniSegmented
                    options={['kg', 'lbs'] as WeightUnit[]}
                    value={weightUnit}
                    onChange={(v) => setWeightUnit(v)}
                  />
                  <TouchableOpacity
                    onPress={logWeight}
                    activeOpacity={0.85}
                    style={[styles.plusBtn, { backgroundColor: Colors.primary }]}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityRole="button"
                    accessibilityLabel="Log current weight"
                  >
                    <Feather name="plus" size={12} color={Colors.primaryFg} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Goal */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="target" color={ROW_ICON_COLORS.goal} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Goal</Text>
                <View style={styles.infoRight}>
                  <InlineNumberInput
                    value={goalWeight}
                    onChangeText={(v) => {
                      setGoalWeight(v);
                      persistField({ goal_weight_kg: parseFloat(v) || null });
                      const num = parseFloat(v);
                      // Clearing the field should clear context too, not keep the old goal.
                      setCtxGoalWeight(!isNaN(num) && num > 0 ? num : null);
                    }}
                    placeholder={weightUnit}
                  />
                  {goalProgress && (
                    <Text style={[styles.goalDiffText, { color: C.textMuted }]}>
                      {goalProgress.label}
                    </Text>
                  )}
                </View>
              </View>

              {/* Body Fat */}
              <View style={styles.infoRow}>
                <RowIcon name="percent" color={ROW_ICON_COLORS.bodyFat} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Body Fat</Text>
                <View style={styles.infoRight}>
                  <InlineNumberInput
                    value={bodyFat}
                    onChangeText={(v) => {
                      setBodyFat(v);
                      persistField({ body_fat_percent: parseFloat(v) || null });
                    }}
                    placeholder="%"
                    width={56}
                  />
                  <Text style={[styles.unitSuffix, { color: C.textDim }]}>%</Text>
                  <TouchableOpacity
                    onPress={logBodyFat}
                    activeOpacity={0.85}
                    style={[styles.plusBtn, { backgroundColor: Colors.primary }]}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityRole="button"
                    accessibilityLabel="Log body fat percentage"
                  >
                    <Feather name="plus" size={12} color={Colors.primaryFg} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* Goal progress bar */}
            {goalProgress && (
              <View style={{ marginTop: 8 }}>
                <View style={styles.goalLegendRow}>
                  <Text style={[styles.goalLegendText, { color: C.textDim }]}>
                    {Math.round(goalProgress.pct * 100)}% to goal
                  </Text>
                  <Text style={[styles.goalLegendText, { color: C.textDim }]}>
                    {weight} → {goalWeight} {weightUnit}
                  </Text>
                </View>
                <View style={[styles.goalTrack, { backgroundColor: withAlpha('#f59e0b', '15') }]}>
                  <View style={[styles.goalFill, {
                    backgroundColor: '#f59e0b',
                    width: `${goalProgress.pct * 100}%`,
                  }]} />
                </View>
              </View>
            )}
          </View>

          {/* ─── Training Profile (powers AI Coach context) ─── */}
          <View style={styles.section}>
            <SectionLabel icon="zap">TRAINING PROFILE</SectionLabel>
            <Text style={[styles.coachHint, { color: C.textMuted }]}>
              Helps Coach Drona tailor recommendations to your goals and experience.
            </Text>

            {/* Goal — horizontal scroll because 5 options */}
            <View style={[styles.infoCard, { backgroundColor: C.card, borderColor: C.borderSubtle, marginBottom: 8 }]}>
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="target" color={ROW_ICON_COLORS.trainingGoal} />
                <Text style={[styles.infoLabel, { color: C.foreground, flex: 1 }]}>Primary goal</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.choicePillsRow}
              >
                {GOAL_OPTIONS.map((opt) => {
                  const active = coachGoal === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      onPress={() => {
                        setCoachGoal(opt.value);
                        persistField({ goal: opt.value });
                      }}
                      activeOpacity={0.85}
                      style={[
                        styles.choicePill,
                        {
                          backgroundColor: active ? Colors.primary : 'transparent',
                          borderColor: active ? Colors.primary : C.borderLight,
                        },
                      ]}
                    >
                      <Text style={[
                        styles.choicePillText,
                        { color: active ? Colors.primaryFg : C.textSecondary },
                      ]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            <View style={[styles.infoCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              {/* Experience */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="award" color={ROW_ICON_COLORS.experience} />
                <Text style={[styles.infoLabel, { color: C.foreground, flex: 1 }]}>Experience</Text>
                <View style={{ flexDirection: 'row', gap: 4 }}>
                  {EXPERIENCE_OPTIONS.map((opt) => {
                    const active = experienceLevel === opt.value;
                    return (
                      <TouchableOpacity
                        key={opt.value}
                        onPress={() => {
                          setExperienceLevel(opt.value);
                          persistField({ experience_level: opt.value });
                        }}
                        activeOpacity={0.85}
                        style={[
                          styles.expPill,
                          {
                            backgroundColor: active ? Colors.primary : 'transparent',
                            borderColor: active ? Colors.primary : C.borderLight,
                          },
                        ]}
                      >
                        <Text style={[
                          styles.expPillText,
                          { color: active ? Colors.primaryFg : C.textSecondary },
                        ]}>
                          {opt.label.slice(0, 3)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Weekly target sessions */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="calendar" color={ROW_ICON_COLORS.frequency} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Sessions / week</Text>
                <View style={styles.infoRight}>
                  <InlineNumberInput
                    value={weeklyTargetSessions}
                    onChangeText={(v) => {
                      setWeeklyTargetSessions(v);
                      const n = parseInt(v, 10);
                      persistField({ weekly_target_sessions: Number.isFinite(n) && n > 0 ? n : null });
                    }}
                    placeholder="4"
                    width={56}
                  />
                </View>
              </View>

              {/* Training age (months) */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <RowIcon name="clock" color={ROW_ICON_COLORS.trainingAge} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Training age (mo)</Text>
                <View style={styles.infoRight}>
                  <InlineNumberInput
                    value={trainingAgeMonths}
                    onChangeText={(v) => {
                      setTrainingAgeMonths(v);
                      const n = parseInt(v, 10);
                      persistField({ training_age_months: Number.isFinite(n) && n >= 0 ? n : null });
                    }}
                    placeholder="24"
                    width={64}
                  />
                </View>
              </View>

              {/* Birth year (stored as Jan 1 of that year) */}
              <View style={styles.infoRow}>
                <RowIcon name="gift" color={ROW_ICON_COLORS.dob} />
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Birth year</Text>
                <View style={styles.infoRight}>
                  <InlineNumberInput
                    value={birthYear}
                    onChangeText={(v) => {
                      setBirthYear(v);
                      const y = parseInt(v, 10);
                      const valid = Number.isFinite(y) && y >= 1900 && y <= new Date().getFullYear();
                      persistField({ date_of_birth: valid ? `${y}-01-01` : null });
                    }}
                    placeholder="1995"
                    width={70}
                  />
                </View>
              </View>
            </View>
          </View>

          {/* ─── Preferences ─── */}
          <View style={styles.section}>
            <SectionLabel icon="shield">PREFERENCES</SectionLabel>
            <View style={[styles.infoCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              {/* Appearance */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <View style={[styles.rowIcon, { backgroundColor: C.glowBg }]}>
                  <Feather name={mode === 'dark' ? 'moon' : 'sun'} size={11} color={C.mutedFg} />
                </View>
                <Text style={[styles.infoLabel, { color: C.foreground, flex: 1 }]}>Appearance</Text>
                <MiniSegmented
                  options={['dark', 'light'] as const}
                  value={mode}
                  onChange={(v) => { if (v !== mode) toggleTheme(); }}
                  renderOption={(opt, active) => (
                    <Feather
                      name={opt === 'dark' ? 'moon' : 'sun'}
                      size={10}
                      color={active ? Colors.primaryFg : C.textMuted}
                    />
                  )}
                />
              </View>

              {/* Weight Unit */}
              <View style={[styles.infoRow, { borderBottomColor: C.borderSubtle }]}>
                <View style={[styles.rowIcon, { backgroundColor: C.glowBg }]}>
                  <Feather name="anchor" size={11} color={C.mutedFg} />
                </View>
                <Text style={[styles.infoLabel, { color: C.foreground, flex: 1 }]}>Weight Unit</Text>
                <MiniSegmented
                  options={['kg', 'lbs'] as WeightUnit[]}
                  value={weightUnit}
                  onChange={setWeightUnit}
                />
              </View>

              {/* Report a Bug */}
              <TouchableOpacity
                onPress={() => setBugModalOpen(true)}
                activeOpacity={0.7}
                style={styles.infoRow}
              >
                <RowIcon name="alert-triangle" color={ROW_ICON_COLORS.bug} />
                <Text style={[styles.infoLabel, { color: C.foreground, flex: 1 }]}>Report a Bug</Text>
                <Feather name="chevron-right" size={14} color={C.textDim} />
              </TouchableOpacity>
            </View>
          </View>

          {/* ─── Admin Tools (admin users only) ─── */}
          {isAdmin && (
            <View style={styles.section}>
              <SectionLabel>ADMIN TOOLS</SectionLabel>
              <View style={{ gap: 8 }}>
                <TouchableOpacity
                  // typed-routes hasn't regenerated for /admin/research yet
                  // — cast is fine, route exists at runtime.
                  onPress={() => router.push('/admin/research' as any)}
                  activeOpacity={0.85}
                  style={[styles.accountBtn, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
                >
                  <View style={[styles.rowIcon, { backgroundColor: `${Colors.primary}22` }]}>
                    <Feather name="book-open" size={11} color={C.accentText} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.infoLabel, { color: C.foreground }]}>Research Review</Text>
                    <Text style={{ fontSize: FontSize.xs, color: C.textMuted, marginTop: 2 }}>
                      Approve / reject papers from the ingest queue
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={14} color={C.textMuted} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ─── Account ─── */}
          <View style={styles.section}>
            <SectionLabel>ACCOUNT</SectionLabel>
            <View style={{ gap: 8 }}>
              <TouchableOpacity
                onPress={handleSignOut}
                activeOpacity={0.85}
                style={[styles.accountBtn, { backgroundColor: C.card, borderColor: C.borderSubtle }]}
              >
                <View style={[styles.rowIcon, { backgroundColor: C.glowBg }]}>
                  <Feather name="log-out" size={11} color={C.mutedFg} />
                </View>
                <Text style={[styles.infoLabel, { color: C.foreground }]}>Sign Out</Text>
              </TouchableOpacity>

              {!deleteConfirm ? (
                <TouchableOpacity
                  onPress={() => setDeleteConfirm(true)}
                  activeOpacity={0.85}
                  style={[styles.accountBtn, {
                    backgroundColor: 'rgba(239,68,68,0.08)',
                    borderColor: 'rgba(239,68,68,0.18)',
                  }]}
                >
                  <View style={[styles.rowIcon, { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
                    <Feather name="trash-2" size={11} color="#f87171" />
                  </View>
                  <Text style={[styles.infoLabel, { color: '#f87171' }]}>Delete Account</Text>
                </TouchableOpacity>
              ) : (
                <View style={[styles.deleteConfirm, {
                  backgroundColor: 'rgba(239,68,68,0.10)',
                  borderColor: 'rgba(239,68,68,0.25)',
                }]}>
                  <Text style={styles.deleteConfirmText}>
                    This permanently deletes your account and <Text style={{ fontWeight: FontWeight.bold }}>all data</Text>.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={() => setDeleteConfirm(false)}
                      style={[styles.deleteConfirmBtn, { backgroundColor: C.glowBg }]}
                    >
                      <Feather name="x" size={10} color={C.foreground} />
                      <Text style={[styles.deleteConfirmBtnText, { color: C.foreground }]}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={confirmDeleteAccount}
                      disabled={deletingAccount}
                      style={[styles.deleteConfirmBtn, { backgroundColor: '#ef4444', opacity: deletingAccount ? 0.6 : 1 }]}
                    >
                      {deletingAccount
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Feather name="trash-2" size={10} color="#fff" />}
                      <Text style={[styles.deleteConfirmBtnText, { color: '#fff' }]}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          </View>

          {/* ─── Footer ─── */}
          <View style={{ paddingHorizontal: Spacing.xl, alignItems: 'center', marginTop: 4 }}>
            <Text style={[styles.versionText, { color: C.textDim }]}>Overload v1.0</Text>
          </View>
        </ScrollView>
      </SafeAreaView>

      {/* ─── Bug Report Bottom Sheet ─── */}
      <Modal visible={bugModalOpen} transparent animationType="none" onRequestClose={() => setBugModalOpen(false)}>
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          style={[styles.modalBackdrop, { backgroundColor: C.overlay }]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setBugModalOpen(false)} />
          <Animated.View
            entering={SlideInDown.duration(300).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(200)}
            style={[styles.bugSheet, {
              backgroundColor: C.elevated,
              borderTopColor: C.borderSubtle,
              // Lift above the keyboard on iOS (Android's adjustResize handles
              // it on its own). See bugKbHeight tracking above for context.
              marginBottom: Platform.OS === 'ios' ? bugKbHeight : 0,
            }]}
          >
              <View style={styles.bugHandle}>
                <View style={[styles.bugHandleBar, { backgroundColor: C.handle }]} />
              </View>

              <View style={styles.bugHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                  <View style={[styles.bugIconWrap, { backgroundColor: withAlpha(ROW_ICON_COLORS.bug, '15') }]}>
                    <Feather name="alert-triangle" size={16} color={ROW_ICON_COLORS.bug} />
                  </View>
                  <View>
                    <Text style={[styles.bugTitle, { color: C.foreground }]}>Report a Bug</Text>
                    <Text style={[styles.bugSubtitle, { color: C.textMuted }]}>We'll look into it ASAP</Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => setBugModalOpen(false)}
                  style={[styles.bugCloseBtn, { backgroundColor: C.glowBg }]}
                >
                  <Feather name="x" size={16} color={C.mutedFg} />
                </TouchableOpacity>
              </View>

              {/* Category */}
              <Text style={[styles.bugSectionLabel, { color: C.textMuted }]}>CATEGORY</Text>
              <View style={styles.bugCategories}>
                {([
                  { v: 'ui', l: 'UI' },
                  { v: 'data', l: 'Data' },
                  { v: 'crash', l: 'Crash' },
                  { v: 'performance', l: 'Perf' },
                  { v: 'other', l: 'Other' },
                ] as const).map((cat) => {
                  const active = bugCategory === cat.v;
                  return (
                    <TouchableOpacity
                      key={cat.v}
                      onPress={() => setBugCategory(cat.v)}
                      style={[styles.bugCategoryBtn, {
                        backgroundColor: active ? Colors.primary : 'transparent',
                        borderColor: active ? Colors.primary : C.borderLight,
                      }]}
                    >
                      <Text style={[styles.bugCategoryText, {
                        color: active ? Colors.primaryFg : C.textSecondary,
                      }]}>{cat.l}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <TextInput
                value={bugTitle}
                onChangeText={setBugTitle}
                placeholder="Brief summary..."
                placeholderTextColor={C.textDim}
                maxLength={100}
                style={[styles.bugInput, {
                  backgroundColor: C.glowBg,
                  borderColor: C.borderSubtle,
                  color: C.foreground,
                }]}
              />

              <TextInput
                value={bugDescription}
                onChangeText={setBugDescription}
                placeholder="What happened?"
                placeholderTextColor={C.textDim}
                maxLength={1000}
                multiline
                numberOfLines={3}
                style={[styles.bugInput, styles.bugTextarea, {
                  backgroundColor: C.glowBg,
                  borderColor: C.borderSubtle,
                  color: C.foreground,
                }]}
              />

              <TouchableOpacity
                onPress={submitBugReport}
                disabled={!bugTitle.trim() || bugSubmitting}
                style={[styles.bugSubmit, {
                  backgroundColor: Colors.primary,
                  opacity: !bugTitle.trim() || bugSubmitting ? 0.4 : 1,
                }]}
              >
                {bugSubmitting ? (
                  <ActivityIndicator color={Colors.primaryFg} />
                ) : (
                  <>
                    <Feather name="send" size={14} color={Colors.primaryFg} />
                    <Text style={styles.bugSubmitText}>Submit</Text>
                  </>
                )}
              </TouchableOpacity>
          </Animated.View>
        </Animated.View>
      </Modal>

      <ThemedAlert
        visible={showSignOutAlert}
        icon="log-out"
        iconColor="#f97316"
        title="Sign Out"
        message="Are you sure you want to sign out?"
        buttons={[
          { text: 'Cancel', onPress: () => setShowSignOutAlert(false) },
          { text: 'Sign Out', style: 'destructive', onPress: confirmSignOut },
        ]}
        onClose={() => setShowSignOutAlert(false)}
      />

      <ThemedAlert
        visible={!!showErrorAlert}
        icon="alert-circle"
        iconColor="#ef4444"
        title="Error"
        message={showErrorAlert}
        buttons={[{ text: 'OK', style: 'primary', onPress: () => setShowErrorAlert('') }]}
        onClose={() => setShowErrorAlert('')}
      />

      <ThemedAlert
        visible={!!showInfoAlert}
        icon="check-circle"
        iconColor={Colors.success}
        title="Saved"
        message={showInfoAlert}
        buttons={[{ text: 'OK', style: 'primary', onPress: () => setShowInfoAlert('') }]}
        onClose={() => setShowInfoAlert('')}
      />
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  // Hero
  hero: { alignItems: 'center', paddingTop: 24, paddingBottom: 16, paddingHorizontal: Spacing.xl },
  avatarWrap: { position: 'relative', marginBottom: 12 },
  avatar: {
    width: 80, height: 80, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarLetter: { fontSize: 24, fontWeight: FontWeight.black },
  guestBadge: {
    position: 'absolute', bottom: -6, right: -6,
    backgroundColor: '#f59e0b',
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: Radius.full,
  },
  guestBadgeText: { color: '#0a0a0a', fontSize: 8, fontWeight: FontWeight.bold, letterSpacing: 0.4 },
  levelBadge: {
    position: 'absolute', bottom: -6, right: -6,
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: Radius.full,
    minWidth: 18, alignItems: 'center',
  },
  levelBadgeText: { color: '#0a0a0a', fontSize: 9, fontWeight: FontWeight.black },
  heroName: { fontSize: 20, fontWeight: FontWeight.black, letterSpacing: -0.5 },
  heroEmail: { fontSize: FontSize.sm, marginTop: 2 },
  heroBadges: { flexDirection: 'row', gap: 8, marginTop: 10 },
  heroBadge: {
    borderWidth: 1, borderRadius: Radius.full,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  heroBadgeText: { fontSize: 10, fontWeight: FontWeight.medium },

  // Sections
  section: { paddingHorizontal: Spacing.xl, marginBottom: 16 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  sectionLabelText: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1.5 },

  // XP Card
  xpCard: { borderRadius: Radius.lg, borderWidth: 1, padding: Spacing.xl },
  xpHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  xpAvatar: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  xpAvatarText: { fontSize: 18, fontWeight: FontWeight.black },
  xpTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  xpIcon: { fontSize: 14 },
  xpTitle: { fontSize: FontSize.base, fontWeight: FontWeight.bold },
  xpTotal: { fontSize: FontSize.sm, marginTop: 2 },
  xpProgressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  xpProgressLabel: { fontSize: 11, fontWeight: FontWeight.semibold },
  xpProgressValue: { fontSize: 11 },
  xpTrack: { height: 10, borderRadius: 5, overflow: 'hidden', marginBottom: 6 },
  xpFill: { height: '100%', borderRadius: 5 },
  xpPercent: { fontSize: 10, textAlign: 'right' },

  // Info card / rows
  infoCard: { borderRadius: Radius.lg, borderWidth: 1, overflow: 'hidden' },
  infoRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 24, height: 24, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  infoLabel: { fontSize: 12, fontWeight: FontWeight.medium },
  infoRight: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto' },

  // Inputs
  numberInput: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6,
    fontSize: FontSize.base, fontWeight: FontWeight.semibold,
    textAlign: 'right',
  },
  unitSuffix: { fontSize: 11 },
  goalDiffText: { fontSize: 10, fontWeight: FontWeight.semibold },

  // Segmented (cm/ft, kg/lbs, dark/light)
  segmented: { flexDirection: 'row', height: 24, borderWidth: 1, borderRadius: Radius.full, overflow: 'hidden' },
  segmentedOption: {
    paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center',
  },
  segmentedText: { fontSize: 10, fontWeight: FontWeight.bold },

  // Gender pills
  genderRow: { flexDirection: 'row', gap: 4 },
  genderPill: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 8, borderWidth: 1, minWidth: 30, alignItems: 'center',
  },
  genderPillText: { fontSize: 10, fontWeight: FontWeight.semibold },

  // Training profile (coach context)
  coachHint: { fontSize: 11, marginBottom: 8, lineHeight: 14 },
  choicePillsRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  choicePill: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: Radius.full, borderWidth: 1,
  },
  choicePillText: { fontSize: 11, fontWeight: FontWeight.semibold },
  expPill: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 8, borderWidth: 1, minWidth: 38, alignItems: 'center',
  },
  expPillText: { fontSize: 10, fontWeight: FontWeight.semibold },

  // Plus add button
  plusBtn: {
    width: 28, height: 28, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },

  // Goal progress
  goalLegendRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  goalLegendText: { fontSize: 9 },
  goalTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  goalFill: { height: '100%', borderRadius: 3 },

  // Account buttons
  accountBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: Radius.lg, borderWidth: 1,
  },
  deleteConfirm: { padding: 12, borderRadius: Radius.lg, borderWidth: 1 },
  deleteConfirmText: { fontSize: 11, color: '#f87171', marginBottom: 8 },
  deleteConfirmBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 8, borderRadius: 12,
  },
  deleteConfirmBtnText: { fontSize: 11, fontWeight: FontWeight.bold },

  // Version
  versionText: { fontSize: 9 },

  // Bug Modal
  modalBackdrop: { flex: 1, justifyContent: 'flex-end' },
  bugSheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 1, paddingHorizontal: Spacing.xl, paddingBottom: 32,
  },
  bugHandle: { alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  bugHandleBar: { width: 40, height: 4, borderRadius: 2 },
  bugHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, marginTop: 4 },
  bugIconWrap: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  bugTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  bugSubtitle: { fontSize: 11, marginTop: 1 },
  bugCloseBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  bugSectionLabel: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: 1.5, marginBottom: 8 },
  bugCategories: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  bugCategoryBtn: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: Radius.full, borderWidth: 1,
  },
  bugCategoryText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  bugInput: {
    borderWidth: 1, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: FontSize.base, marginBottom: 12,
  },
  bugTextarea: { minHeight: 80, textAlignVertical: 'top' },
  bugSubmit: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 12,
  },
  bugSubmitText: { color: Colors.primaryFg, fontSize: FontSize.base, fontWeight: FontWeight.bold },
});
