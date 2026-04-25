import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useClerkUser } from '@/hooks/useClerkUser';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown, useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Colors, Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { mockProfile, getMockWorkouts } from '@/lib/mockData';
import { getLevelInfo } from '@/lib/xp';
import { ThemedAlert } from '@/components/ui/ThemedAlert';

type Gender = 'M' | 'F' | 'O';
type WeightUnit = 'kg' | 'lbs';
type HeightUnit = 'cm' | 'ft';

function ToggleGroup<T extends string>({ options, value, onChange, color }: {
  options: T[]; value: T; onChange: (v: T) => void; color?: string;
}) {
  const { C } = useTheme();
  const accent = color || Colors.primary;
  return (
    <View style={styles.toggleGroup}>
      {options.map(opt => (
        <TouchableOpacity
          key={opt}
          onPress={() => onChange(opt)}
          style={[
            styles.toggleBtn,
            value === opt && { backgroundColor: accent },
          ]}
        >
          <Text style={[
            styles.toggleText,
            { color: value === opt ? Colors.primaryFg : C.mutedFg },
          ]}>
            {opt}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function ProfileRow({ icon, label, children }: {
  icon: React.ComponentProps<typeof Feather>['name']; label: string; children: React.ReactNode;
}) {
  const { C } = useTheme();
  return (
    <View style={styles.profileRow}>
      <View style={styles.profileRowLeft}>
        <Feather name={icon} size={16} color={C.mutedFg} />
        <Text style={[styles.profileRowLabel, { color: C.foreground }]}>{label}</Text>
      </View>
      <View style={styles.profileRowRight}>{children}</View>
    </View>
  );
}

function NumberInput({ value, onChangeText, suffix }: {
  value: string; onChangeText: (t: string) => void; suffix?: string;
}) {
  const { C } = useTheme();
  return (
    <View style={[styles.numberInput, { borderColor: C.border }]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType="numeric"
        style={[styles.numberText, { color: C.foreground }]}
        textAlign="center"
      />
      {suffix && <Text style={[styles.numberSuffix, { color: C.textMuted }]}>{suffix}</Text>}
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { C, mode, toggleTheme } = useTheme();
  const { user, signOut: clerkSignOut } = useClerkUser();
  const signOut = async () => {
    try { await clerkSignOut(); } catch {}
    router.replace('/(auth)');
  };

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gender, setGender] = useState<Gender>('M');
  const [height, setHeight] = useState('178');
  const [weight, setWeight] = useState('78');
  const [goalWeight, setGoalWeight] = useState('75');
  const [bodyFat, setBodyFat] = useState('16');
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('kg');
  const [heightUnit, setHeightUnit] = useState<HeightUnit>('cm');
  const [totalXP, setTotalXP] = useState(0);
  const [totalWorkouts, setTotalWorkouts] = useState(0);
  const [joinDate, setJoinDate] = useState('');
  const [showSignOutAlert, setShowSignOutAlert] = useState(false);
  const [showErrorAlert, setShowErrorAlert] = useState('');

  const userName = user?.firstName || user?.fullName || 'Guest';
  const isGuest = !user;
  const { level, xpInLevel, xpNeeded } = getLevelInfo(totalXP);
  const levelProgress = xpNeeded > 0 ? xpInLevel / xpNeeded : 0;

  const w = parseFloat(weight) || 0;
  const g = parseFloat(goalWeight) || 0;
  const diff = w - g;
  const goalProgress = g > 0 && w > g ? Math.min(((w - g) > 0 ? 1 - diff / w : 1), 1) : 0;

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      if (!isSupabaseConfigured) {
        const p = mockProfile;
        setGender(p.gender);
        setHeight(String(p.height_cm));
        setWeight(String(p.weight_kg));
        setGoalWeight(String(p.goal_weight_kg));
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
        setGender(profile.gender || 'M');
        setHeight(String(profile.height_cm || 178));
        setWeight(String(profile.weight_kg || 78));
        setGoalWeight(String(profile.goal_weight_kg || 75));
        setBodyFat(String(profile.body_fat_percent || 16));
        setTotalXP(profile.xp || 0);
        setJoinDate(profile.created_at ? new Date(profile.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '');
      }
      setTotalWorkouts(count || 0);
    } catch (err: any) {
      setShowErrorAlert(err?.message || 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const saveProfile = async () => {
    const clerkId = user?.id;
    if (!clerkId) {
      setShowErrorAlert('You must be signed in to save profile changes.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from('user_profiles').upsert({
        clerk_user_id: clerkId,
        gender,
        height_cm: parseFloat(height) || null,
        weight_kg: parseFloat(weight) || null,
        goal_weight_kg: parseFloat(goalWeight) || null,
        body_fat_percent: parseFloat(bodyFat) || null,
      }, { onConflict: 'clerk_user_id' });
      if (error) throw error;
    } catch (err: any) {
      setShowErrorAlert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = () => {
    setShowSignOutAlert(true);
  };

  const confirmSignOut = async () => {
    setShowSignOutAlert(false);
    await signOut();
    router.replace('/(auth)');
  };

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
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Avatar + Info */}
        <Animated.View entering={FadeInDown.duration(400)} style={styles.avatarSection}>
          <View style={[styles.avatarCircle, { backgroundColor: C.circleBg }]}>
            <Text style={[styles.avatarLetter, { color: C.circleFg }]}>{userName.charAt(0).toUpperCase()}</Text>
          </View>
          {isGuest && (
            <View style={styles.guestBadge}>
              <Text style={styles.guestBadgeText}>GUEST</Text>
            </View>
          )}
          <Text style={[styles.profileName, { color: C.foreground }]}>{userName}</Text>
          <Text style={[styles.profileSub, { color: C.mutedFg }]}>
            {isGuest ? 'Guest account' : user?.emailAddresses?.[0]?.emailAddress}
          </Text>
          <View style={styles.badges}>
            {joinDate ? (
              <View style={[styles.badge, { borderColor: C.border }]}>
                <Text style={[styles.badgeText, { color: C.mutedFg }]}>Since {joinDate}</Text>
              </View>
            ) : null}
            <View style={[styles.badge, { borderColor: C.border }]}>
              <Text style={[styles.badgeText, { color: C.mutedFg }]}>{totalWorkouts} workouts</Text>
            </View>
          </View>
        </Animated.View>

        {/* XP Card */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <View style={[styles.xpCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <View style={styles.xpHeader}>
              <View style={[styles.xpLevelCircle, { backgroundColor: Colors.primary }]}>
                <Text style={[styles.xpLevelNum, { color: Colors.primaryFg }]}>{level}</Text>
              </View>
              <View style={{ marginLeft: 12 }}>
                <Text style={[styles.xpTitle, { color: C.foreground }]}>Beginner</Text>
                <Text style={[styles.xpTotalText, { color: C.mutedFg }]}>{totalXP} total XP</Text>
              </View>
            </View>
            <View style={styles.xpProgressRow}>
              <Text style={[styles.xpProgressLabel, { color: C.mutedFg }]}>Level {level} → {level + 1}</Text>
              <Text style={[styles.xpProgressValue, { color: C.mutedFg }]}>{xpInLevel} / {xpNeeded} XP</Text>
            </View>
            <View style={[styles.xpTrack, { backgroundColor: `${Colors.primary}18` }]}>
              <Animated.View style={[styles.xpFill, { backgroundColor: Colors.primary }, progressStyle]} />
            </View>
            <Text style={[styles.xpPercent, { color: C.textMuted }]}>
              {Math.round(levelProgress * 100)}% to next level
            </Text>
          </View>
        </View>

        {/* Basic Information */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <View style={styles.sectionHeaderRow}>
            <Feather name="user" size={14} color={C.mutedFg} />
            <Text style={[styles.sectionLabel, { color: C.mutedFg }]}>BASIC INFORMATION</Text>
          </View>
          <View style={[styles.infoCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            <ProfileRow icon="users" label="Gender">
              <ToggleGroup options={['M', 'F', 'O'] as Gender[]} value={gender} onChange={setGender} />
            </ProfileRow>
            <View style={[styles.separator, { backgroundColor: C.border }]} />
            <ProfileRow icon="maximize" label="Height">
              <NumberInput value={height} onChangeText={setHeight} />
              <ToggleGroup options={['cm', 'ft'] as HeightUnit[]} value={heightUnit} onChange={setHeightUnit} />
            </ProfileRow>
            <View style={[styles.separator, { backgroundColor: C.border }]} />
            <ProfileRow icon="anchor" label="Weight">
              <NumberInput value={weight} onChangeText={setWeight} />
              <ToggleGroup options={['kg', 'lbs'] as WeightUnit[]} value={weightUnit} onChange={setWeightUnit} />
            </ProfileRow>
            <View style={[styles.separator, { backgroundColor: C.border }]} />
            <ProfileRow icon="target" label="Goal">
              <NumberInput value={goalWeight} onChangeText={setGoalWeight} />
              <Text style={[styles.goalDiff, { color: C.textMuted }]}>{diff > 0 ? `${diff.toFixed(1)} to lose` : ''}</Text>
            </ProfileRow>
            <View style={[styles.separator, { backgroundColor: C.border }]} />
            <ProfileRow icon="percent" label="Body Fat">
              <NumberInput value={bodyFat} onChangeText={setBodyFat} suffix="%" />
            </ProfileRow>
          </View>

          {/* Goal progress */}
          {diff > 0 && (
            <View style={{ marginTop: Spacing.md }}>
              <View style={styles.goalRow}>
                <Text style={[styles.goalLabel, { color: C.accentText }]}>
                  {Math.round(goalProgress * 100)}% to goal
                </Text>
                <Text style={[styles.goalLabel, { color: C.mutedFg }]}>
                  {weight} → {goalWeight} kg
                </Text>
              </View>
              <View style={[styles.goalTrack, { backgroundColor: `${Colors.stat.streak}20` }]}>
                <View style={[styles.goalFill, { backgroundColor: Colors.stat.streak, width: `${goalProgress * 100}%` }]} />
              </View>
            </View>
          )}
        </View>

        {/* Save button */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <TouchableOpacity
            onPress={saveProfile}
            disabled={saving}
            style={[styles.saveBtn, saving && { opacity: 0.6 }]}
          >
            {saving ? (
              <ActivityIndicator color={Colors.primaryFg} />
            ) : (
              <Text style={styles.saveBtnText}>Save Changes</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Settings */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xl }}>
          <View style={styles.sectionHeaderRow}>
            <Feather name="settings" size={14} color={C.mutedFg} />
            <Text style={[styles.sectionLabel, { color: C.mutedFg }]}>SETTINGS</Text>
          </View>
          <View style={[styles.infoCard, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
            {/* Appearance toggle */}
            <View style={styles.profileRow}>
              <View style={styles.profileRowLeft}>
                <Feather name={mode === 'dark' ? 'moon' : 'sun'} size={16} color={C.mutedFg} />
                <Text style={[styles.profileRowLabel, { color: C.foreground }]}>Appearance</Text>
              </View>
              <TouchableOpacity
                onPress={toggleTheme}
                style={[styles.themeToggle, { borderColor: C.border }]}
                activeOpacity={0.7}
              >
                <View style={[
                  styles.themeOption,
                  mode === 'dark' && { backgroundColor: Colors.primary },
                ]}>
                  <Feather name="moon" size={10} color={mode === 'dark' ? Colors.primaryFg : C.textMuted} />
                </View>
                <View style={[
                  styles.themeOption,
                  mode === 'light' && { backgroundColor: Colors.primary },
                ]}>
                  <Feather name="sun" size={10} color={mode === 'light' ? Colors.primaryFg : C.textMuted} />
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Sign Out */}
        <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.xxxl }}>
          <TouchableOpacity onPress={handleSignOut} style={[styles.signOutBtn, { backgroundColor: C.muted }]}>
            <Feather name="log-out" size={16} color={C.mutedFg} />
            <Text style={[styles.signOutText, { color: C.foreground }]}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>

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
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  avatarSection: { alignItems: 'center', paddingTop: 24, paddingBottom: 20 },
  avatarCircle: {
    width: 80, height: 80, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarLetter: { fontSize: 32, fontWeight: FontWeight.black },
  guestBadge: {
    backgroundColor: '#f97316',
    paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: Radius.full, marginTop: -8,
  },
  guestBadgeText: { color: '#fff', fontSize: 9, fontWeight: FontWeight.bold, letterSpacing: 0.5 },
  profileName: { fontSize: FontSize.xxl, fontWeight: FontWeight.black, marginTop: 12 },
  profileSub: { fontSize: FontSize.base, marginTop: 2 },
  badges: { flexDirection: 'row', gap: 8, marginTop: 12 },
  badge: { borderWidth: 1, borderRadius: Radius.full, paddingHorizontal: 12, paddingVertical: 5 },
  badgeText: { fontSize: FontSize.sm },
  // XP
  xpCard: { borderRadius: Radius.xl, borderWidth: 1, padding: Spacing.xl },
  xpHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  xpLevelCircle: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  xpLevelNum: { fontSize: FontSize.xl, fontWeight: FontWeight.black },
  xpTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  xpTotalText: { fontSize: FontSize.sm, marginTop: 2 },
  xpProgressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  xpProgressLabel: { fontSize: FontSize.sm },
  xpProgressValue: { fontSize: FontSize.sm },
  xpTrack: { height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 6 },
  xpFill: { height: '100%', borderRadius: 4 },
  xpPercent: { fontSize: FontSize.sm, textAlign: 'right' },
  // Section
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, letterSpacing: 1 },
  infoCard: { borderRadius: Radius.xl, borderWidth: 1, padding: Spacing.lg },
  profileRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 12,
  },
  profileRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  profileRowLabel: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  profileRowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  separator: { height: 1, marginHorizontal: -Spacing.lg },
  toggleGroup: { flexDirection: 'row', borderRadius: Radius.full, overflow: 'hidden' },
  toggleBtn: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: Radius.full, minWidth: 34, alignItems: 'center',
  },
  toggleText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  numberInput: {
    borderWidth: 1, borderRadius: Radius.sm,
    paddingHorizontal: 12, paddingVertical: 6,
    minWidth: 60, flexDirection: 'row', alignItems: 'center',
  },
  numberText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, minWidth: 30, textAlign: 'center' },
  numberSuffix: { fontSize: FontSize.sm, marginLeft: 2 },
  goalDiff: { fontSize: FontSize.sm },
  // Goal progress
  goalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  goalLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  goalTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  goalFill: { height: '100%', borderRadius: 3 },
  // Buttons
  saveBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 14, borderRadius: Radius.xl,
    alignItems: 'center',
  },
  saveBtnText: { color: Colors.primaryFg, fontSize: FontSize.base, fontWeight: FontWeight.bold },
  themeToggle: {
    flexDirection: 'row', borderRadius: Radius.full, borderWidth: 1, overflow: 'hidden',
  },
  themeOption: {
    paddingHorizontal: 10, paddingVertical: 5,
    alignItems: 'center', justifyContent: 'center',
  },
  signOutBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: Spacing.lg, borderRadius: Radius.xl,
  },
  signOutText: { fontSize: FontSize.base },
});
