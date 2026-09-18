/**
 * MessageSheet — what long-pressing a chat bubble opens.
 *
 * Two actions, the same two every chat app offers: Copy (the whole message,
 * one tap) and Select text (the message in a selectable view, for a phrase).
 * Selection is deliberately NOT enabled on the bubbles in the scrolling list:
 * a selectable Text takes the long press for itself, so the two gestures fight
 * and neither is reliable, and a selectable bubble inside a ScrollView steals
 * pans on Android. ChatGPT's mobile app splits it the same way.
 *
 * Portal sheet, not RN <Modal> (see components/ui/Portal.tsx). Mounted from
 * inside the coach sheet's own Portal, so it registers later and paints above
 * it. No keyboard here, so the plain SlideInDown idiom is enough.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, BackHandler } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontSize, FontWeight, LetterSpacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { useToast } from '@/components/ui/Toast';
import { haptics } from '@/lib/haptics';
import { copyToClipboard } from '@/lib/clipboard';
import { track } from '@/lib/analytics';

export interface MessageSheetTarget {
  role: 'user' | 'assistant';
  /** Plain text of the message: no markdown markers. */
  text: string;
  /** Which chat surface, for analytics only. */
  surface: string;
}

/**
 * The coach writes light markdown (**bold**, [n] citations) that MessageContent
 * renders. The clipboard gets readable text: bold markers dropped, the same
 * dash normalisation the renderer applies, citation numbers kept.
 */
export function coachPlainText(content: string): string {
  return content
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/–/g, '-')
    .trim();
}

export function MessageSheet({
  target,
  onClose,
}: {
  target: MessageSheetTarget | null;
  onClose: () => void;
}) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [selecting, setSelecting] = useState(false);
  const open = !!target;

  // Each open starts on the actions, never on a stale "Select text" view.
  useEffect(() => {
    if (open) setSelecting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  if (!target) return <Portal>{null}</Portal>;

  const copy = async () => {
    const ok = await copyToClipboard(target.text);
    track('coach_message_copied', { role: target.role, surface: target.surface, chars: target.text.length, ok });
    if (ok) {
      haptics.tick();
      toast.success('Copied');
      onClose();
    } else {
      // No clipboard module in this binary: the selectable view still lets the
      // OS copy menu do it.
      setSelecting(true);
    }
  };

  const who = target.role === 'user' ? 'Your message' : 'Coach Drona';

  return (
    <Portal>
      <Pressable style={[s.backdrop, { backgroundColor: C.overlay }]} onPress={onClose}>
        <Animated.View
          entering={SlideInDown.duration(280).easing(Easing.out(Easing.cubic))}
          exiting={SlideOutDown.duration(180)}
          style={[
            s.sheet,
            selecting && s.sheetTall,
            { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.lg },
          ]}
        >
          <Pressable style={selecting ? { flex: 1 } : undefined}>
            <View style={[s.handle, { backgroundColor: C.handle }]} />
            {selecting ? (
              <>
                <View style={s.selectHeader}>
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
              </>
            ) : (
              <>
                <Text style={[s.eyebrow, { color: C.textMuted }]}>{who.toUpperCase()}</Text>
                <Text numberOfLines={2} style={[s.preview, { color: C.textSecondary }]}>{target.text}</Text>
                <Pressable
                  onPress={copy}
                  accessibilityRole="button"
                  accessibilityLabel="Copy message"
                  style={({ pressed }) => [s.row, { borderColor: C.border, backgroundColor: pressed ? C.muted : C.card }]}
                >
                  <View style={[s.rowIcon, { backgroundColor: C.muted }]}>
                    <Feather name="copy" size={12} color={C.accentText} />
                  </View>
                  <View style={s.rowBody}>
                    <Text style={[s.rowTitle, { color: C.foreground }]}>Copy</Text>
                    <Text style={[s.rowSub, { color: C.textSecondary }]}>The whole message, ready to paste.</Text>
                  </View>
                </Pressable>
                <Pressable
                  onPress={() => { haptics.tick(); setSelecting(true); }}
                  accessibilityRole="button"
                  accessibilityLabel="Select text"
                  style={({ pressed }) => [s.row, { borderColor: C.border, backgroundColor: pressed ? C.muted : C.card }]}
                >
                  <View style={[s.rowIcon, { backgroundColor: C.muted }]}>
                    <Feather name="type" size={12} color={C.accentText} />
                  </View>
                  <View style={s.rowBody}>
                    <Text style={[s.rowTitle, { color: C.foreground }]}>Select text</Text>
                    <Text style={[s.rowSub, { color: C.textSecondary }]}>Pick out just the part you want.</Text>
                  </View>
                </Pressable>
              </>
            )}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm,
  },
  // Select mode needs room to read a long reply; cap it so the backdrop
  // (tap to dismiss) stays reachable above.
  sheetTall: { height: '72%' },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: Spacing.lg },
  eyebrow: { fontSize: 10, fontWeight: FontWeight.semibold, letterSpacing: LetterSpacing.eyebrow, marginBottom: 4 },
  preview: { fontSize: FontSize.sm, lineHeight: 18, marginBottom: Spacing.md },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    borderWidth: 1, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm,
  },
  rowIcon: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.sm, marginTop: 2, lineHeight: 17 },
  selectHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  doneBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: Radius.full, borderWidth: 1 },
  doneText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  hint: { fontSize: FontSize.xs, marginTop: 2, marginBottom: Spacing.sm },
  selectScroll: { flex: 1, borderWidth: 1, borderRadius: Radius.lg },
  selectContent: { padding: Spacing.md },
  selectText: { fontSize: FontSize.base, lineHeight: 22 },
});
