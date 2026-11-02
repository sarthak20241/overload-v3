/**
 * The dashboard's floating log-food button: bottom right, above the tab bar
 * and clear of its centre play button. A fork-and-knife glyph (the same one
 * the Goal screen's Eat row draws) says what it is for, so it needs no label.
 * A tap opens Drona's food box on Nutrition with the keyboard up.
 *
 * Why it exists: new users mostly logged food by hand and never found the AI
 * food box on Nutrition (2026-10-31). The button puts that box one tap from
 * home.
 */
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { track } from '@/lib/analytics';
import { PressableScale } from '@/components/ui/PressableScale';
import { UtensilsIcon } from '@/components/program/LineIcons';
import { Colors, Spacing, Shadow } from '@/constants/theme';

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

  if (hidden) return null;

  const press = () => {
    track('home_log_food_tapped', { mode: 'text' });
    onLog();
  };

  return (
    <PressableScale
      onPress={press}
      scaleTo={0.92}
      style={[s.btn, Shadow.playBtn, { bottom: TAB_BAR_HEIGHT + insets.bottom + Spacing.lg }]}
      accessibilityRole="button"
      accessibilityLabel="Log a meal"
      accessibilityHint="Opens the food box. Type what you ate."
    >
      <UtensilsIcon size={22} strokeWidth={2} color={Colors.primaryFg} />
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
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
