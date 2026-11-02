/**
 * The dashboard's floating log-food button: bottom right, above the tab bar
 * and clear of its centre play button. A salad bowl on the calorie blue (the
 * Fuel card's colour) says it is for food, so it needs no label, and the lime
 * play button stays the one lime circle on screen. A tap opens Drona's food
 * box on Nutrition with the keyboard up.
 *
 * Why it exists: new users mostly logged food by hand and never found the AI
 * food box on Nutrition (2026-10-31). The button puts that box one tap from
 * home.
 */
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { track } from '@/lib/analytics';
import { PressableScale } from '@/components/ui/PressableScale';
import { SaladIcon } from '@/components/program/LineIcons';
import { Colors, Spacing } from '@/constants/theme';

// components/ui/BottomNav.tsx draws the bar at 64 + the bottom inset.
const TAB_BAR_HEIGHT = 64;
const SIZE = 52;
/** Scroll room a screen leaves under its content so the button never covers
 *  the last card: the button plus its gap above the tab bar. */
export const HOME_LOG_BUTTON_ROOM = SIZE + Spacing.lg + Spacing.xs;

interface Props {
  /** Something else owns the screen (a popup, the coach, a live workout). */
  hidden: boolean;
  onLog: () => void;
}

export function HomeLogButton({ hidden, onLog }: Props) {
  const insets = useSafeAreaInsets();
  const { mode, C } = useTheme();

  if (hidden) return null;

  const press = () => {
    track('home_log_food_tapped', { mode: 'text' });
    onLog();
  };

  return (
    <PressableScale
      onPress={press}
      scaleTo={0.92}
      style={[s.btn, {
        bottom: TAB_BAR_HEIGHT + insets.bottom + Spacing.lg,
        backgroundColor: C.macro.calories,
        shadowColor: C.macro.calories,
      }]}
      accessibilityRole="button"
      accessibilityLabel="Log a meal"
      accessibilityHint="Opens the food box. Type what you ate."
    >
      {/* Dark ink on the light dark-theme blue; white on the deep light-theme blue. */}
      <SaladIcon size={24} strokeWidth={2} color={mode === 'dark' ? Colors.primaryFg : '#ffffff'} />
    </PressableScale>
  );
}

const s = StyleSheet.create({
  btn: {
    position: 'absolute',
    right: Spacing.xl,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    // Shadow.playBtn's shape, in the button's own blue.
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
});
