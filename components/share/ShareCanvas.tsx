import { forwardRef, ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';

const FONT_BOLD = 'SpaceGrotesk_700Bold';
const FONT_MEDIUM = 'SpaceGrotesk_500Medium';
const FG = '#ffffff';
const MUTED = '#8a8a93';
const BG = '#0a0a0a';
const LIME = '#c8ff00';

interface Props {
  eyebrow: string;
  headline: string;
  subline?: string;
  footer: string;
  children: ReactNode;
  statRow?: { label: string; value: string; dotColor?: string }[];
  coachLine?: string;
}

export const ShareCanvas = forwardRef<View, Props>(function ShareCanvas(
  { eyebrow, headline, subline, footer, children, statRow, coachLine },
  ref,
) {
  return (
    <View ref={ref} style={styles.canvas} collapsable={false}>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.headline} numberOfLines={2}>{headline}</Text>
        {subline ? <Text style={styles.subline}>{subline}</Text> : null}

        <View style={styles.hero}>{children}</View>

        {statRow && statRow.length > 0 && (
          <View style={styles.statRow}>
            {statRow.map((s) => (
              <View key={s.label} style={styles.statTile}>
                <View style={styles.statValueRow}>
                  {s.dotColor && <View style={[styles.statDot, { backgroundColor: s.dotColor }]} />}
                  <Text style={styles.statValue}>{s.value}</Text>
                </View>
                <Text style={styles.statLabel}>{s.label}</Text>
              </View>
            ))}
          </View>
        )}

        {coachLine ? <Text style={styles.coachLine}>{coachLine}</Text> : null}
      </View>

      <View style={styles.footer}>
        <View style={styles.footerLine} />
        <View style={styles.footerRow}>
          <View style={styles.wordmark}>
            <Text style={styles.wordmarkText}>Overload</Text>
            <View style={styles.limeDot} />
          </View>
          <Text style={styles.footerDate}>{footer}</Text>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  canvas: {
    width: 1080,
    height: 1920,
    backgroundColor: BG,
    paddingHorizontal: 80,
  },
  content: {
    flex: 1,
    paddingTop: 280,
  },
  eyebrow: {
    fontFamily: FONT_MEDIUM,
    fontSize: 34,
    letterSpacing: 2.5,
    color: MUTED,
    textTransform: 'uppercase',
  },
  headline: {
    fontFamily: FONT_BOLD,
    fontSize: 72,
    color: FG,
    marginTop: 16,
    lineHeight: 82,
  },
  subline: {
    fontFamily: FONT_MEDIUM,
    fontSize: 34,
    color: MUTED,
    marginTop: 12,
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 40,
  },
  statRow: {
    flexDirection: 'row',
    gap: 24,
    marginTop: 40,
  },
  statTile: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  statValue: {
    fontFamily: FONT_BOLD,
    fontSize: 56,
    color: FG,
  },
  statLabel: {
    fontFamily: FONT_MEDIUM,
    fontSize: 28,
    color: MUTED,
    marginTop: 6,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  coachLine: {
    fontFamily: FONT_MEDIUM,
    fontSize: 32,
    color: MUTED,
    textAlign: 'center',
    marginTop: 32,
  },
  footer: {
    paddingBottom: 80,
  },
  footerLine: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.10)',
    marginBottom: 24,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  wordmark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  wordmarkText: {
    fontFamily: FONT_BOLD,
    fontSize: 32,
    color: FG,
  },
  limeDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: LIME,
  },
  footerDate: {
    fontFamily: FONT_MEDIUM,
    fontSize: 30,
    color: MUTED,
  },
});
