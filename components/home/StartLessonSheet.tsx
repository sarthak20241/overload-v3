/**
 * The short lesson behind a getting-started step: one to three cards, each a
 * moving sketch of the real screen (LessonDemos) with a title and a line or
 * two in Drona's voice. Swipe or tap Next; the last card's button opens the
 * screen where the step is done. "Skip" goes straight there, for anyone who
 * already knows their way around.
 *
 * Portal sheet like the other bottom sheets (flush on Android edge-to-edge).
 * Copy lives in lib/startLessons.ts.
 */
import { useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, { Easing, SlideInDown, SlideOutDown, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Colors, FontFamily, FontSize, FontWeight, LetterSpacing, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { PressableScale } from '@/components/ui/PressableScale';
import { LessonDemoView } from '@/components/home/LessonDemos';
import { haptics } from '@/lib/haptics';
import { track } from '@/lib/analytics';
import { START_LESSONS } from '@/lib/startLessons';
import type { StartStepId } from '@/lib/startGuide';

interface Props {
  /** The step whose lesson is open, or null when closed. */
  stepId: StartStepId | null;
  /** 1-based place of the step in the path, for the eyebrow. */
  stepNumber: number;
  stepTotal: number;
  onClose: () => void;
  /** Open the step's screen (the sheet closes itself first). */
  onGo: (id: StartStepId) => void;
}

const SHEET_PAD = Spacing.xl;

export function StartLessonSheet({ stepId, stepNumber, stepTotal, onClose, onGo }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // Each page is the full sheet width with its own gutter, so native paging
  // lands exactly and no neighbour peeks in at the edge.
  const pageW = width;
  const [page, setPage] = useState(0);
  const pager = useRef<ScrollView>(null);

  useEffect(() => {
    if (!stepId) return;
    setPage(0);
    track('start_guide_lesson_opened', { step: stepId });
  }, [stepId]);

  useEffect(() => {
    if (!stepId) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [stepId, onClose]);

  if (!stepId) return <Portal>{null}</Portal>;

  const lesson = START_LESSONS[stepId];
  const pages = lesson.pages;
  const last = page === pages.length - 1;

  const goToPage = (i: number) => {
    pager.current?.scrollTo({ x: i * pageW, animated: true });
    setPage(i);
    track('start_guide_lesson_page', { step: stepId, page: i });
  };

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / pageW);
    if (i !== page) {
      haptics.selection();
      setPage(i);
      track('start_guide_lesson_page', { step: stepId, page: i });
    }
  };

  const go = (via: 'cta' | 'skip') => {
    track('start_guide_lesson_go', { step: stepId, via, page });
    onClose();
    onGo(stepId);
  };

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose} accessibilityLabel="Close the lesson">
        <Animated.View
          entering={SlideInDown.duration(340).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(200)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.lg }]}
        >
          <Pressable>
            <View style={[s.handle, { backgroundColor: C.handle }]} />

            <View style={s.head}>
              <Text style={[s.eyebrow, { color: C.textDim }]}>
                STEP {stepNumber} OF {stepTotal}
              </Text>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => go('skip')}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Skip the lesson and go there now"
                style={s.skip}
              >
                <Text style={[s.skipText, { color: C.mutedFg }]}>Skip</Text>
              </Pressable>
              <Pressable
                onPress={onClose}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={[s.close, { backgroundColor: C.muted }]}
              >
                <Feather name="x" size={14} color={C.mutedFg} />
              </Pressable>
            </View>

            <ScrollView
              ref={pager}
              horizontal
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={onScrollEnd}
              pagingEnabled
              scrollEnabled={pages.length > 1}
              style={{ marginHorizontal: -SHEET_PAD }}
            >
              {pages.map((p, i) => (
                <View key={p.demo} style={{ width: pageW, paddingHorizontal: SHEET_PAD }}>
                  <LessonDemoView demo={p.demo} active={i === page} />
                  <Text style={[s.title, { color: C.foreground }]} accessibilityRole="header">{p.title}</Text>
                  <Text style={[s.body, { color: C.mutedFg }]}>{p.body}</Text>
                </View>
              ))}
            </ScrollView>

            {pages.length > 1 && (
              <View style={s.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {pages.map((p, i) => <Dot key={p.demo} on={i === page} />)}
              </View>
            )}

            <PressableScale
              onPress={() => (last ? go('cta') : goToPage(page + 1))}
              haptic={last ? 'tap' : 'selection'}
              style={[s.cta, last ? { backgroundColor: Colors.primary } : { backgroundColor: C.muted }]}
              accessibilityRole="button"
              accessibilityLabel={last ? lesson.cta : 'Next'}
            >
              <Text style={[s.ctaText, { color: last ? Colors.primaryFg : C.foreground }]}>
                {last ? lesson.cta : 'Next'}
              </Text>
              <Feather name="arrow-right" size={15} color={last ? Colors.primaryFg : C.foreground} />
            </PressableScale>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

/** A page dot: the current one stretches into a pill (scaleX, no relayout). */
function Dot({ on }: { on: boolean }) {
  const { C } = useTheme();
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleX: withSpring(on ? 3 : 1, { damping: 18, stiffness: 220 }) }],
  }), [on]);
  return (
    <View style={s.dotSlot}>
      <Animated.View style={[s.dot, { backgroundColor: on ? C.foreground : C.border }, style]} />
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, paddingHorizontal: SHEET_PAD, paddingTop: 10 },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: Spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.md, minHeight: 32 },
  eyebrow: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow },
  skip: { paddingHorizontal: 4, paddingVertical: 6 },
  skipText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  close: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: FontFamily.display, fontSize: FontSize.xxl, letterSpacing: LetterSpacing.tight, marginTop: Spacing.lg },
  body: { fontSize: FontSize.base, lineHeight: 21, marginTop: 6, minHeight: 42 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 4, marginTop: Spacing.lg },
  dotSlot: { width: 18, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cta: {
    marginTop: Spacing.lg,
    height: 52,
    borderRadius: Radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  ctaText: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
});
