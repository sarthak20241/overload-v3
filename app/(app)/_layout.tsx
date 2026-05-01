import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import Animated, {
  SlideInDown, SlideOutDown, Easing,
} from 'react-native-reanimated';
import { Colors, Radius, FontSize, FontWeight, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useWorkout } from '@/hooks/useWorkout';
import { isSupabaseConfigured, useSupabaseClient } from '@/lib/supabase';
import { getAllRoutines } from '@/lib/mockData';
import { BottomNav } from '@/components/ui/BottomNav';
import { useClerkUser } from '@/hooks/useClerkUser';
import type { Routine } from '@/lib/types';

const ROUTINE_COLORS = Colors.routineColors;

function StartWorkoutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const workout = useWorkout();
  const { C } = useTheme();
  const { user } = useClerkUser();
  const supabase = useSupabaseClient();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!visible) setShown(false);
  }, [visible]);

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
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      onShow={() => setShown(true)}
    >
      <Pressable style={[styles.modalBackdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        {shown && (
        <Animated.View
          entering={SlideInDown.duration(350).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[styles.modalSheet, { backgroundColor: C.elevated, borderColor: C.border }]}
        >
          <Pressable>
            <View style={[styles.handle, { backgroundColor: C.handle }]} />
            <View style={styles.modalHeader}>
              <View>
                <Text style={[styles.modalTitle, { color: C.foreground }]}>Start Workout</Text>
                <Text style={[styles.modalSub, { color: C.mutedFg }]}>Choose a routine or start blank</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: C.closeBtn }]}>
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
              style={{ maxHeight: 320 }}
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
        )}
      </Pressable>
    </Modal>
  );
}

export default function AppLayout() {
  const [modalOpen, setModalOpen] = useState(false);

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
    maxHeight: '80%',
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
