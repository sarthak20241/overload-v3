/**
 * "About this goal" from the Goal screen's ••• menu: the program's title and
 * the full objective Drona wrote. The main screen shows only what the
 * approved reference shows, so the objective lives here. Portal-based (never
 * RN <Modal>, per the project's Android edge-to-edge rule), sliding like the
 * other sheets.
 */
import { useEffect } from 'react';
import { View, Text, Pressable, TouchableOpacity, ScrollView, StyleSheet, BackHandler, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Spacing, Radius, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/ui/Portal';
import { useSheetSlide } from '@/hooks/useSheetSlide';
import { SectionLabel } from '@/components/program/finish';

interface Props {
  visible: boolean;
  title: string;
  objective: string;
  onClose: () => void;
}

export function AboutGoalSheet({ visible, title, objective, onClose }: Props) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const { mounted, slideStyle } = useSheetSlide(visible);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [visible, onClose]);

  if (!mounted) return null;

  return (
    <Portal>
      <View style={s.backdrop} pointerEvents={visible ? 'auto' : 'none'}>
        {visible && (
          <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={[StyleSheet.absoluteFill, { backgroundColor: C.overlay }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
          </Animated.View>
        )}
        <Animated.View
          style={[s.sheet, slideStyle, { backgroundColor: C.elevated, paddingBottom: insets.bottom + Spacing.md, maxHeight: winH * 0.7 }]}
        >
          <View style={[s.handle, { backgroundColor: C.handle }]} />
          <View style={s.header}>
            <View style={{ flex: 1 }}>
              <SectionLabel>About this goal</SectionLabel>
              <Text style={[s.title, { color: C.foreground }]}>{title}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={[s.closeBtn, { backgroundColor: C.closeBtn }]} accessibilityRole="button" accessibilityLabel="Close">
              <Feather name="x" size={15} color={C.foreground} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: Spacing.sm }}>
            <Text style={[s.body, { color: C.mutedFg }]}>{objective}</Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Portal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xxl, borderTopRightRadius: Radius.xxl, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.md },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.md, gap: Spacing.md },
  title: { fontSize: 20, lineHeight: 25, fontWeight: FontWeight.bold, marginTop: 4 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  body: { fontSize: 15, lineHeight: 22, fontWeight: FontWeight.regular },
});
