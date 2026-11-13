/**
 * The parts of the two-sided paywall (app/upgrade.tsx). Design approved by the
 * owner 2026-11-12, see .planning/connect-plan-paywall.md section 3:
 *
 *   - flat background, no glow
 *   - STRONG glass on the example chat card only (sheen, bright top and left
 *     edges, soft shadow): it is the hero
 *   - QUIET glass on the switch, the feature tiles or icon circles, and the
 *     price boxes (light fill, thin edge, faint top highlight)
 *   - white icons; the softer lime only on the goal bar, the selected price
 *     outline and the button
 *
 * No live blur: there is nothing behind the cards to blur. Every colour comes
 * from the theme mode, so the light theme gets the same look with dark ink.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import {
  PERIOD_LABEL,
  SIDE_LABEL,
  sideFeatures,
  type PaywallLayout,
  type PaywallPeriod,
  type PaywallSide,
} from '@/lib/paywallPlans';

/** The softer lime of this screen (the app lime is #c8ff00). */
export const PAYWALL_LIME = '#bfe84a';

/** Glass tones for the current theme: white tints on dark, ink tints on light. */
export function useGlass() {
  const { mode, C } = useTheme();
  const dark = mode === 'dark';
  const tint = (a: number) => (dark ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);
  return {
    dark,
    C,
    quietFill: tint(dark ? 0.055 : 0.035),
    quietEdge: tint(dark ? 0.11 : 0.08),
    quietTop: tint(dark ? 0.08 : 0.04),
    strongFrom: tint(dark ? 0.15 : 0.06),
    strongTo: tint(dark ? 0.04 : 0.015),
    strongEdge: tint(dark ? 0.16 : 0.1),
    strongEdgeLit: tint(dark ? 0.34 : 0.16),
    selectedPill: tint(dark ? 0.12 : 0.07),
    bubbleMine: tint(dark ? 0.2 : 0.08),
    bubbleTheirs: dark ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.9)',
    track: dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.08)',
    lime: dark ? PAYWALL_LIME : '#4d7a00',
    dashed: tint(dark ? 0.14 : 0.14),
  };
}

// ── Switch ──────────────────────────────────────────────────────────────────

export function PlanSwitch({ side, onChange, disabled }: {
  side: PaywallSide;
  onChange: (s: PaywallSide) => void;
  disabled?: boolean;
}) {
  const g = useGlass();
  return (
    <View
      accessibilityRole="tablist"
      style={[s.switch, { backgroundColor: g.quietFill, borderColor: g.quietEdge, borderTopColor: g.quietTop }]}
    >
      {(['drona', 'own_ai'] as PaywallSide[]).map((k) => {
        const on = side === k;
        return (
          <TouchableOpacity
            key={k}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => onChange(k)}
            style={[s.switchItem, on && { backgroundColor: g.selectedPill }]}
          >
            <Text
              style={[
                s.switchText,
                { color: on ? g.C.foreground : g.C.textSecondary },
                on && { fontFamily: FontFamily.onboardingHeading },
              ]}
            >
              {SIDE_LABEL[k]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ── Example chat card (the hero, strong glass) ──────────────────────────────

function Bubble({ text, mine }: { text: string; mine?: boolean }) {
  const g = useGlass();
  return (
    <View style={[s.bubbleRow, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
      <View style={[s.bubble, { backgroundColor: mine ? g.bubbleMine : g.bubbleTheirs }]}>
        <Text style={[s.bubbleText, { color: g.C.foreground }]}>{text}</Text>
      </View>
    </View>
  );
}

export function ExampleCard({ side }: { side: PaywallSide }) {
  const g = useGlass();
  return (
    <View style={[s.heroShadow, !g.dark && s.heroShadowLight]}>
      <LinearGradient
        colors={[g.strongFrom, g.strongTo]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[
          s.hero,
          {
            borderColor: g.strongEdge,
            borderTopColor: g.strongEdgeLit,
            borderLeftColor: g.strongEdgeLit,
          },
        ]}
      >
        {side === 'drona' ? (
          <>
            {/* PLACEHOLDER words until a real over-week Drona card replaces
                them (plan file, section 7 phase F). */}
            <View style={s.goalRow}>
              <Text style={[s.goalLabel, { color: g.C.textSecondary }]}>Your goal</Text>
              <Text style={[s.goalValue, { color: g.C.foreground }]}>72 kg by Mar 3</Text>
            </View>
            <View style={[s.goalTrack, { backgroundColor: g.track }]}>
              <View style={[s.goalFill, { backgroundColor: g.lime }]} />
            </View>
            <Text style={[s.caption, { color: g.C.textMuted }]}>Drona</Text>
            <Bubble text="You ate 900 calories extra this week. I changed next week. You still reach 72 kg by Mar 3." />
          </>
        ) : (
          <>
            <Text style={[s.caption, { color: g.C.textMuted }]}>In your ChatGPT</Text>
            <Bubble mine text="I ate 2 eggs and toast" />
            <Bubble text="Saved to Overload. 310 calories." />
            <Bubble mine text="How was my protein this week?" />
            <Bubble text="Low on 4 of 7 days." />
          </>
        )}
      </LinearGradient>
    </View>
  );
}

// ── Features: A = tiles, B = icon list ──────────────────────────────────────

export function Features({ side, layout }: { side: PaywallSide; layout: PaywallLayout }) {
  const g = useGlass();
  const items = sideFeatures(side);
  if (layout === 'list') {
    return (
      <View style={s.list}>
        {items.map((f, i) => (
          <View
            key={f.label}
            style={[s.listRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: g.quietEdge }]}
            accessibilityLabel={f.included ? f.label : `${f.label}, not included`}
          >
            <View
              style={[
                s.listMark,
                f.included
                  ? { backgroundColor: g.quietFill, borderColor: g.quietEdge, borderTopColor: g.quietTop }
                  : { borderColor: g.dashed, borderStyle: 'dashed' },
              ]}
            >
              <Feather name={f.included ? f.icon : 'lock'} size={13} color={f.included ? g.C.foreground : g.C.textMuted} />
            </View>
            <Text style={[s.listText, { color: f.included ? g.C.foreground : g.C.textMuted }]}>{f.label}</Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={s.tiles}>
      {items.map((f) => (
        <View
          key={f.label}
          accessibilityLabel={f.included ? f.label : `${f.label}, not included`}
          style={[
            s.tile,
            f.included
              ? { backgroundColor: g.quietFill, borderColor: g.quietEdge, borderTopColor: g.quietTop }
              : { borderColor: g.dashed, borderStyle: 'dashed' },
          ]}
        >
          <Feather name={f.included ? f.icon : 'lock'} size={16} color={f.included ? g.C.foreground : g.C.textMuted} />
          <Text
            numberOfLines={3}
            style={[s.tileText, { color: f.included ? g.C.foreground : g.C.textMuted }]}
          >
            {f.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── Price boxes ─────────────────────────────────────────────────────────────

export function PriceBoxes({ periods, prices, selected, onSelect, disabled }: {
  periods: readonly PaywallPeriod[];
  /** Store price string per period; a missing one hides that box. */
  prices: Partial<Record<PaywallPeriod, string>>;
  selected: PaywallPeriod;
  onSelect: (p: PaywallPeriod) => void;
  disabled?: boolean;
}) {
  const g = useGlass();
  const shown = periods.filter((p) => !!prices[p]);
  return (
    <View style={s.prices} accessibilityRole="radiogroup">
      {shown.map((p) => {
        const on = selected === p;
        return (
          <TouchableOpacity
            key={p}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled }}
            accessibilityLabel={`${PERIOD_LABEL[p]}, ${prices[p]}`}
            disabled={disabled}
            onPress={() => onSelect(p)}
            style={[
              s.price,
              { backgroundColor: g.quietFill, borderColor: on ? g.lime : g.quietEdge },
              on && s.priceOn,
            ]}
          >
            <Text style={[s.priceLabel, { color: g.C.textSecondary }]}>{PERIOD_LABEL[p]}</Text>
            <Text style={[s.priceValue, { color: g.C.foreground }]} numberOfLines={1} adjustsFontSizeToFit>
              {prices[p]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  switch: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, padding: 3 },
  switchItem: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  switchText: { fontSize: 14, fontFamily: FontFamily.onboardingBody },

  heroShadow: {
    borderRadius: 20,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  heroShadowLight: { shadowOpacity: 0.12 },
  hero: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8, overflow: 'hidden' },
  goalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  goalLabel: { fontSize: 13, fontFamily: FontFamily.onboardingBody },
  goalValue: { fontSize: 13, fontFamily: FontFamily.onboardingHeading },
  goalTrack: { height: 6, borderRadius: 3, marginBottom: 14, overflow: 'hidden' },
  goalFill: { width: '62%', height: 6, borderRadius: 3 },
  caption: { fontSize: 12, marginBottom: 8, fontFamily: FontFamily.onboardingBody },
  bubbleRow: { flexDirection: 'row', marginBottom: 6 },
  bubble: { maxWidth: '86%', borderRadius: 14, paddingHorizontal: 11, paddingVertical: 8 },
  bubbleText: { fontSize: 14, lineHeight: 20, fontFamily: FontFamily.onboardingBody },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8 },
  tile: {
    width: '31.5%',
    height: 84,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    gap: 6,
  },
  tileText: { fontSize: 12, lineHeight: 16, textAlign: 'center', fontFamily: FontFamily.onboardingBody },

  list: { paddingHorizontal: 2 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  listMark: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  listText: { fontSize: 14, fontFamily: FontFamily.onboardingBody, flexShrink: 1 },

  prices: { flexDirection: 'row', gap: 8 },
  price: { flex: 1, minHeight: 56, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  priceOn: { borderWidth: 1.5 },
  priceLabel: { fontSize: 12, fontFamily: FontFamily.onboardingBody },
  priceValue: { fontSize: 16, marginTop: 2, fontFamily: FontFamily.onboardingHeading },
});
