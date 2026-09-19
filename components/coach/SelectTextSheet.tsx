/**
 * SelectTextSheet — what long-pressing a chat bubble opens.
 *
 * Long press means one thing: "let me pick out part of this." So the press
 * goes straight into a selectable copy of the message, no menu in between.
 * Copying the WHOLE message is a separate, one-tap affordance: the small copy
 * icon under each bubble (components/coach/MessageCopyButton).
 *
 * Why a sheet rather than making the bubble itself selectable: a selectable
 * Text takes the long press for itself and steals ScrollView pans on Android,
 * and the bubble is not one Text but nested runs (bold, citation pills), so a
 * selection could never span a bold word. One flat Text here selects cleanly.
 *
 * Portal sheet, not RN <Modal> (see components/ui/Portal.tsx). Mounted from
 * inside the coach sheet's own Portal, so it registers later and paints above
 * it. No keyboard here, so the plain SlideInDown idiom is enough.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';

export interface MessageSheetTarget {
  role: 'user' | 'assistant';
  /** Plain text of the message: no markdown markers. */
  text: string;
  /** Which chat surface, for analytics only. */
  surface: string;
}

/**
 * The coach writes light markdown (**bold**, ## headings, *italic*, [n]
 * citations) that MessageContent renders. What gets copied or selected is what
 * the eye reads: markers dropped, the same dash normalisation the renderer
 * applies, citation numbers kept.
 */
export function coachPlainText(content: string): string {
  return content
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, ''))
    .join('\n')
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,;:!?)]|$)/g, '$1$2')
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/–/g, '-')
    .trim();
}

export function SelectTextSheet({
  target,
  onClose,
}: {
  target: MessageSheetTarget | null;
  onClose: () => void;
}) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const open = !!target;

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!target) return <Portal>{null}</Portal>;

  const who = target.role === 'user' ? 'Your message' : 'Coach Drona';

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          entering={SlideInDown.duration(280).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(180)}
          style={[s.sheet, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.lg }]}
        >
          <Pressable style={{ flex: 1 }}>
            <View style={[s.handle, { backgroundColor: C.handle }]} />
            <View style={s.header}>
              <Text style={[s.eyebrow, { color: C.textMuted }]}>{who.toUpperCase()}</Text>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Done"
                style={({ pressed }) => [s.doneBtn, { backgroundColor: pressed ? C.muted : C.card, borderColor: C.border }]}
              >
                <Text style={[s.doneText, { color: C.foreground }]}>Done</Text>
              </Pressable>
            </View>
            <Text style={[s.hint, { color: C.textSecondary }]}>Press and hold a word to start selecting.</Text>
            <ScrollView
              style={[s.selectScroll, { backgroundColor: C.card, borderColor: C.border }]}
              contentContainerStyle={s.selectContent}
              showsVerticalScrollIndicator
            >
              <Text selectable style={[s.selectText, { color: C.foreground }]}>{target.text}</Text>
            </ScrollView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  // Tall enough to read a long reply, short enough that the backdrop (tap to
  // dismiss) stays reachable above it.
  sheet: {
    height: '72%',
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: Spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow },
  doneBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: Radius.full, borderWidth: 1 },
  doneText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  hint: { fontSize: FontSize.xs, marginTop: 4, marginBottom: Spacing.sm },
  selectScroll: { flex: 1, borderWidth: 1, borderRadius: Radius.lg },
  selectContent: { padding: Spacing.md },
  selectText: { fontSize: FontSize.base, lineHeight: 22 },
});
