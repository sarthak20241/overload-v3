import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, ScrollView, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Tabs, useRouter, Redirect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import Animated, {
  Easing,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Colors, Radius, FontSize, FontWeight, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useWorkout } from '@/hooks/useWorkout';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { getAllRoutines } from '@/lib/mockData';
import { BottomNav } from '@/components/ui/BottomNav';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useGuestMode } from '@/lib/guestMode';
import type { Routine } from '@/lib/types';

const ROUTINE_COLORS = Colors.routineColors;

function StartWorkoutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const workout = useWorkout();
  const { C } = useTheme();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  // Compute sheet height as absolute pixels rather than '80%' — the percentage
  // resolved unreliably inside the Reanimated entering animation on some devices,
  // collapsing the sheet to roughly half-screen.
  const { height: winH } = useWindowDimensions();
  const sheetHeight = Math.round(winH * 0.8);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(false);
  // `render` stays true through the exit animation so it can play before unmount.
  // Driven by parent's `visible` plus the slide-out animation's completion callback.
  const [render, setRender] = useState(false);
  const translateY = useSharedValue(sheetHeight);

  // Replaces the Reanimated `entering={SlideInDown}` + `onShow={() => setShown(true)}`
  // gate, which raced with React Native Modal's presentation timing on Android —
  // sometimes the Animated.View measured before the Modal was fully laid out,
  // leaving the sheet stuck at ~50% height with its X button clipped offscreen.
  // A manual shared-value translation is deterministic and immune to that race.
  useEffect(() => {
    let rafId: number | null = null;
    if (visible) {
      setRender(true);
      translateY.value = sheetHeight;
      // Defer one frame so the Modal's native window is on screen before the slide.
      rafId = requestAnimationFrame(() => {
        translateY.value = withTiming(0, {
          duration: 320,
          easing: Easing.out(Easing.cubic),
        });
      });
    } else if (render) {
      translateY.value = withTiming(
        sheetHeight,
        { duration: 200, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setRender)(false);
        }
      );
    }
    // Cancel the queued rAF if visible toggles before it fires — otherwise a
    // fast open→close→open could trigger an entry animation after the exit
    // animation has already started, making the sheet appear to bounce.
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [visible, sheetHeight]);

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  useEffect(() => {
    if (visible) {
      const clerkId = user?.id;
      if (!isSupabaseConfigured || !clerkId) {
        setRoutines(getAllRoutines() as any[]);
        return;
      }
      setLoading(true);
      supabase
        .from('routines')
        .select('*, routine_exercises(*, exercises(*))')
        .eq('user_id', clerkId)
        .order('created_at')
        .then(({ data }) => {
          setRoutines((data as any[]) || []);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [visible, user?.id]);

  const startRoutine = (routine: Routine) => {
    onClose();
    router.push(`/workout/${routine.id}`);
  };

  const startBlank = () => {
    onClose();
    router.push('/workout/new');
  };

  return (
    <Modal
      visible={render}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Pressable style={[styles.modalBackdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          style={[
            styles.modalSheet,
            { backgroundColor: C.elevated, borderColor: C.border, height: sheetHeight },
            sheetAnimatedStyle,
          ]}
        >
          <Pressable style={{ flex: 1 }}>
            <View style={[styles.handle, { backgroundColor: C.handle }]} />
            <View style={styles.modalHeader}>
              <View>
                <Text style={[styles.modalTitle, { color: C.foreground }]}>Start Workout</Text>
                <Text style={[styles.modalSub, { color: C.mutedFg }]}>Choose a routine or start blank</Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}
                hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              >
                <Feather name="x" size={15} color={C.foreground} />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: Spacing.xl, marginBottom: Spacing.lg }}>
              <TouchableOpacity
                onPress={startBlank}
                style={[styles.blankBtn, { backgroundColor: C.primarySubtle, borderColor: C.primaryBorder }]}
                activeOpacity={0.7}
              >
                <View style={[styles.blankIcon, { backgroundColor: C.primaryMuted }]}>
                  <Feather name="zap" size={18} color={C.accentText} />
                </View>
                <View>
                  <Text style={[styles.blankTitle, { color: C.accentText }]}>Blank Workout</Text>
                  <Text style={[styles.blankSub, { color: C.mutedFg }]}>Add exercises as you go</Text>
                </View>
              </TouchableOpacity>
            </View>

            <View style={[styles.divider, { paddingHorizontal: Spacing.xl, marginBottom: Spacing.lg }]}>
              <View style={[styles.divLine, { backgroundColor: C.border }]} />
              <Text style={[styles.divText, { color: C.textMuted }]}>or from routine</Text>
              <View style={[styles.divLine, { backgroundColor: C.border }]} />
            </View>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: Spacing.xl, paddingBottom: 40, gap: 8 }}
              showsVerticalScrollIndicator={false}
            >
              {loading ? (
                <ActivityIndicator color={Colors.primary} style={{ marginTop: 24 }} />
              ) : routines.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 24 }}>
                  <Text style={{ color: C.textMuted, fontSize: FontSize.base }}>No routines yet.</Text>
                </View>
              ) : (
                routines.map((routine, idx) => (
                  <TouchableOpacity
                    key={routine.id}
                    onPress={() => startRoutine(routine)}
                    style={[styles.routineItem, { backgroundColor: C.muted, borderColor: C.border }]}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.routineDotWrap, { backgroundColor: `${ROUTINE_COLORS[idx % ROUTINE_COLORS.length]}20` }]}>
                      <View style={[styles.routineDot, { backgroundColor: ROUTINE_COLORS[idx % ROUTINE_COLORS.length] }]} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.routineName, { color: C.foreground }]}>{routine.name}</Text>
                      <Text style={[styles.routineSub, { color: C.mutedFg }]}>
                        {(routine as any).routine_exercises?.length || 0} exercises
                      </Text>
                    </View>
                    <Feather name="play" size={14} color={C.textMuted} />
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

export default function AppLayout() {
  const [modalOpen, setModalOpen] = useState(false);
  const { isSignedIn, isLoaded } = useClerkUser();
  const { isGuest, isLoaded: guestLoaded } = useGuestMode();

  // Wait for both auth and guest-flag reads on cold start; otherwise we may
  // briefly redirect a signed-in user (Clerk hasn't restored from SecureStore
  // yet) or a returning guest (AsyncStorage flag hasn't loaded yet). The
  // original `hasClerkKey &&` short-circuit here treated a missing Clerk key
  // as auto-passthrough — the same silent-bypass class as the auth screen
  // bug. useClerkUser already returns isLoaded:true when no key is present,
  // so this just waits on the guest flag in that case.
  if (!isLoaded || !guestLoaded) return null;

  // Reject everyone who isn't signed in and isn't an explicit guest. Catches
  // deep links, mid-session sign-out, and stale state restoration. With no
  // Clerk key configured, isSignedIn is always false, so only callers who
  // explicitly opted into guest mode via setGuestMode(true) pass — a
  // misconfigured build (e.g. EAS env vars missing on a TestFlight build)
  // now bounces to /(auth) where the error screen renders, instead of
  // silently handing out access.
  if (!isSignedIn && !isGuest) {
    return <Redirect href="/(auth)" />;
  }

  return (
    <>
      <Tabs
        screenOptions={{ headerShown: false, tabBarStyle: { display: 'none' } }}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="routines" />
        <Tabs.Screen name="history" />
        <Tabs.Screen name="analytics" />
        <Tabs.Screen name="profile" />
        {/*
          Admin dashboard for research-kb review (Phase 3).
          Hidden from the bottom nav — only reachable via deep-link
          (`/admin/research`) or the "Admin Tools" button rendered for
          admin users on the Profile screen. The route itself enforces
          the admin check via useAdminCheck + Postgres RLS.
        */}
        <Tabs.Screen name="admin/research" options={{ href: null }} />
      </Tabs>

      <BottomNav onOpenModal={() => setModalOpen(true)} />
      <StartWorkoutModal visible={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    // height is set inline via useWindowDimensions to get an absolute pixel value;
    // the percentage version of this style resolved unreliably under Reanimated.
  },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  modalSub: { fontSize: FontSize.sm, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  blankBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  blankIcon: { width: 40, height: 40, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  blankTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  blankSub: { fontSize: FontSize.sm, marginTop: 2 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  divLine: { flex: 1, height: 1 },
  divText: { fontSize: FontSize.sm },
  routineItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: Spacing.lg,
    borderRadius: Radius.xl,
    borderWidth: 1,
    marginBottom: 8,
  },
  routineDotWrap: { width: 40, height: 40, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  routineDot: { width: 12, height: 12, borderRadius: 6 },
  routineName: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  routineSub: { fontSize: FontSize.sm, marginTop: 2 },
});
