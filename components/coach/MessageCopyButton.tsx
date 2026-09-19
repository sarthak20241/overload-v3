/**
 * MessageCopyButton — the small copy icon under a chat bubble.
 *
 * One tap copies the whole message. The icon becomes a tick for a moment
 * rather than raising a toast: the confirmation belongs next to the thing that
 * was copied, and a toast on every copy would cover the conversation.
 *
 * It sits UNDER the bubble on the bubble's own side, so it reads as belonging
 * to that message and never shifts the text. Long press on the bubble is a
 * different job (select part of it) and lives in SelectTextSheet.
 *
 * On a binary with no clipboard at all, `onFallback` opens that sheet, where
 * the OS selection menu can still copy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { copyToClipboard } from '@/lib/clipboard';
import { track } from '@/lib/analytics';

const CONFIRM_MS = 2000;

export function MessageCopyButton({
  text,
  role,
  surface,
  onFallback,
}: {
  text: string;
  role: 'user' | 'assistant';
  /** Which chat this is, for analytics only. */
  surface: string;
  /** Called when this device has no clipboard at all. */
  onFallback?: () => void;
}) {
  const { C } = useTheme();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const onPress = useCallback(async () => {
    const ok = await copyToClipboard(text);
    track('coach_message_copied', { role, surface, chars: text.length, ok });
    if (!ok) {
      onFallback?.();
      return;
    }
    haptics.tick();
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), CONFIRM_MS);
  }, [text, role, surface, onFallback]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied' : 'Copy message'}
      style={({ pressed }) => [s.btn, { backgroundColor: pressed ? C.muted : 'transparent' }]}
    >
      {/* Fixed box so swapping the glyph can never nudge the layout. */}
      <View style={s.glyph}>
        <Feather
          name={copied ? 'check' : 'copy'}
          size={12}
          color={copied ? C.accentText : C.textMuted}
        />
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: { width: 26, height: 26, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  glyph: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
});
