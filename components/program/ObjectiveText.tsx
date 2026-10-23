/**
 * The program's objective (the plan Drona wrote) under the week line on the
 * Goal screen: one muted line (14pt), clamped with an inline
 * "More" that opens it in place, and "Less" to close it again. No box, no
 * label, no icon. Nothing at all when the objective is empty.
 *
 * React Native has no "clamp with an inline link", so an invisible copy of
 * the full text, laid out at the same width, reports its lines; when there
 * are more than `lines`, the visible text is those lines, the last cut short
 * enough to end in "… More".
 */
import { useState } from 'react';
import { View, Text, StyleSheet, type NativeSyntheticEvent, type TextLayoutEventData } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { haptics } from '@/lib/haptics';
import { FontWeight } from '@/constants/theme';

/** Room for "… More" at the end of the second line, in characters. */
const LINK_ROOM = 8;

export function ObjectiveText({ text, style, lines: maxLines = 2, color }: {
  text: string | null | undefined;
  style?: object;
  /** Lines shown before "More" (the Goal screen shows one). */
  lines?: number;
  /** The muted colour, when the screen has its own (the Goal palette). */
  color?: string;
}) {
  const { C } = useTheme();
  const MAX_LINES = maxLines;
  const [lines, setLines] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const body = (text ?? '').trim();
  if (!body) return null;

  const onLayout = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    const next = e.nativeEvent.lines.map((l) => l.text);
    setLines((prev) => (prev && prev.length === next.length && prev.every((l, i) => l === next[i]) ? prev : next));
  };
  const long = lines != null && lines.length > MAX_LINES;
  const toggle = () => { haptics.selection(); setOpen((o) => !o); };
  const link = (label: string) => (
    <Text
      onPress={toggle}
      style={[styles.link, { color: C.accentText }]}
      accessibilityRole="button"
      accessibilityLabel={open ? 'Show less of the plan' : 'Show all of the plan'}
      suppressHighlighting
    >
      {label}
    </Text>
  );

  // Collapsed: the first two lines, the second cut back to a word break with
  // room for the link.
  let shown = body;
  if (long && !open) {
    const head = lines!.slice(0, MAX_LINES - 1).join('');
    const last = lines![MAX_LINES - 1];
    const cut = last.slice(0, Math.max(0, last.length - LINK_ROOM));
    const atWord = cut.lastIndexOf(' ') > cut.length / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
    shown = `${head}${atWord.trimEnd()}… `;
  }

  return (
    <View style={style}>
      {/* The measurer: the full text at the same width, never seen or read. */}
      <Text
        style={[styles.body, styles.measure]}
        onTextLayout={onLayout}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        {body}
      </Text>
      <Text style={[styles.body, { color: color ?? C.mutedFg }]} accessibilityLabel={body}>
        {shown}
        {long ? (open ? <> {link('Less')}</> : link('More')) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 14, lineHeight: 19, fontWeight: FontWeight.regular },
  link: { fontSize: 14, lineHeight: 19, fontWeight: FontWeight.semibold },
  measure: { position: 'absolute', left: 0, right: 0, opacity: 0 },
});
