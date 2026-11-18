/**
 * The swap list as a bottom sheet over a running workout. The list itself is
 * the same one the Today preview shows (ExerciseSwapList); here it sits in its
 * own sheet because the workout screen has no sheet to put it in.
 *
 * Rendered via the root <Portal>, not RN <Modal>: same reason as every other
 * sheet in the app (Android edge-to-edge, see components/ui/Portal.tsx).
 */
import { useEffect } from 'react';
import { View, Pressable, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Portal } from '@/components/ui/Portal';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { ExerciseSwapList } from '@/components/routines/ExerciseSwapList';
import type { SwapCatalogRow } from '@/hooks/useSwapCatalog';
import type { SwapExercise, SwapTier } from '@/lib/exerciseSwaps';

interface Props {
  visible: boolean;
  from: SwapExercise | null;
  original?: SwapExercise | null;
  exercises: SwapCatalogRow[];
  doneIds: ReadonlySet<string>;
  excludeIds: ReadonlySet<string>;
  onPick: (row: SwapCatalogRow, tier: SwapTier) => void;
  onRestore?: () => void;
  onClose: () => void;
}

export function ExerciseSwapSheet({ visible, from, original, exercises, doneIds, excludeIds, onPick, onRestore, onClose }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  if (!visible || !from) return null;

  return (
    <Portal>
      <View style={s.backdrop}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]} onPress={onClose} />
        <Animated.View
          entering={SlideInDown.duration(300).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[s.sheet, { backgroundColor: C.card, borderColor: C.border, paddingBottom: insets.bottom + Spacing.md }]}
        >
          <View style={[s.handle, { backgroundColor: C.handle }]} />
          <ExerciseSwapList
            from={from}
            original={original}
            exercises={exercises}
            doneIds={doneIds}
            excludeIds={excludeIds}
            onPick={onPick}
            onRestore={onRestore}
            onBack={onClose}
          />
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    borderTopWidth: 1,
    height: '80%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
});
