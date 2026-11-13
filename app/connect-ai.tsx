// Use Overload in ChatGPT or Claude: the connector link, a Copy button, and
// three setup steps for each app (lib/aiConnect.ts). The connector itself is
// supabase/functions/mcp; it serves Pro (and trial) accounts, the same rule
// as hasPro in supabase/functions/mcp/access.ts, so a free account sees the
// way to Pro instead of a link that would refuse it.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import {
  Colors,
  FontFamily,
  FontSize,
  FontWeight,
  IconSize,
  LetterSpacing,
  Radius,
  Shadow,
  Spacing,
} from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useCoachAccess } from '@/hooks/useCoachAccess';
import { PressableScale } from '@/components/ui/PressableScale';
import { useToast } from '@/components/ui/Toast';
import { track } from '@/lib/analytics';
import { copyToClipboard } from '@/lib/clipboard';
import { AI_APPS, CONNECT_STEPS, MCP_URL, TRY_ASKING, type AiApp } from '@/lib/aiConnect';

export default function ConnectAiScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { access, loading } = useCoachAccess();
  const [app, setApp] = useState<AiApp>('claude');
  const [copied, setCopied] = useState(false);

  // Same rule as the server: a paid plan or a live trial.
  const known = !loading && access.state !== 'unknown';
  const hasPlan = access.state === 'paid' || access.state === 'trialing';

  useEffect(() => {
    track('ai_connect_opened');
  }, []);

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/(app)/profile' as any));

  const copy = async () => {
    const ok = await copyToClipboard(MCP_URL);
    track('ai_connect_link_copied', { ok, app });
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Could not copy. Press and hold the link to copy it.');
    }
  };

  return (
    <SafeAreaView style={[s.root, { backgroundColor: C.background }]} edges={['top', 'bottom']}>
      <View style={s.topBar}>
        <TouchableOpacity
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={[s.closeBtn, { backgroundColor: C.card }]}
        >
          <Feather name="x" size={IconSize.md} color={C.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <Text style={[s.eyebrow, { color: C.accentText }]}>CHATGPT AND CLAUDE</Text>
        <Text style={[s.title, { color: C.foreground }]}>Talk to your training where you already chat.</Text>
        <Text style={[s.sub, { color: C.textSecondary }]}>
          Connect Overload to ChatGPT or Claude. Log food and workouts there, ask about your
          progress and your plan, and save the workouts it writes as routines. It all lands in
          your Overload app.
        </Text>

        {/* The link: shown to everyone, so the steps make sense before paying. */}
        <View style={[s.linkBox, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
          <Text style={[s.label, { color: C.textMuted }]}>YOUR CONNECTOR LINK</Text>
          <Text selectable style={[s.link, { color: C.foreground }]}>{MCP_URL}</Text>
        </View>

        {/* Which app */}
        <View style={[s.tabs, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
          {AI_APPS.map((a) => {
            const active = a.id === app;
            return (
              <TouchableOpacity
                key={a.id}
                onPress={() => { if (!active) { setApp(a.id); track('ai_connect_app_switched', { app: a.id }); } }}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={[s.tab, active && { backgroundColor: Colors.primary }]}
              >
                <Text style={[s.tabText, { color: active ? Colors.primaryFg : C.textSecondary }]}>{a.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={s.steps}>
          {CONNECT_STEPS[app].map((step, i) => (
            <View key={i} style={s.step}>
              <View style={[s.stepNum, { backgroundColor: C.glowBg }]}>
                <Text style={[s.stepNumText, { color: C.foreground }]}>{i + 1}</Text>
              </View>
              <Text style={[s.stepText, { color: C.foreground }]}>{step}</Text>
            </View>
          ))}
        </View>

        <Text style={[s.label, s.tryLabel, { color: C.textMuted }]}>THEN TRY</Text>
        {TRY_ASKING.map((q) => (
          <Text key={q} style={[s.try, { color: C.textSecondary }]}>“{q}”</Text>
        ))}

        <Text style={[s.note, { color: C.textMuted }]}>
          ChatGPT setup and available actions depend on your plan and workspace settings. Either
          assistant can delete only entries logged through the connector, and it never changes
          or removes your own routines. Disconnect any time in
          your assistant’s settings. Workouts logged through the connector earn no XP.
        </Text>
      </ScrollView>

      <View style={s.footer}>
        {known && !hasPlan ? (
          <>
            <PressableScale
              onPress={() => { track('upgrade_prompt_tapped', { from: 'ai_connect' }); router.push('/upgrade' as any); }}
              style={[s.cta, Shadow.playBtn]}
              accessibilityRole="button"
              accessibilityLabel="Get Pro to connect"
            >
              <Text style={s.ctaText}>Get Pro to connect</Text>
            </PressableScale>
            <Text style={[s.footNote, { color: C.textMuted }]}>The connector is part of Overload Pro.</Text>
          </>
        ) : (
          <PressableScale
            onPress={copy}
            style={[s.cta, Shadow.playBtn]}
            accessibilityRole="button"
            accessibilityLabel="Copy link"
          >
            <Text style={s.ctaText}>{copied ? 'Copied' : 'Copy link'}</Text>
          </PressableScale>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.xl },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginBottom: Spacing.sm,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: 30,
    letterSpacing: LetterSpacing.tight,
    lineHeight: 36,
  },
  sub: { fontSize: FontSize.base, lineHeight: 21, marginTop: Spacing.md },
  linkBox: {
    marginTop: Spacing.xl,
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  label: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.eyebrow },
  link: { fontSize: FontSize.lg, fontWeight: FontWeight.semibold, marginTop: Spacing.xs },
  tabs: {
    flexDirection: 'row',
    marginTop: Spacing.xl,
    borderRadius: Radius.full,
    borderWidth: 1,
    padding: 3,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: Spacing.sm, borderRadius: Radius.full },
  tabText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  steps: { marginTop: Spacing.lg, gap: Spacing.md },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  stepNum: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  stepText: { flex: 1, fontSize: FontSize.base, lineHeight: 21 },
  tryLabel: { marginTop: Spacing.xl, marginBottom: Spacing.sm },
  try: { fontSize: FontSize.base, lineHeight: 22 },
  note: { fontSize: FontSize.sm, lineHeight: 18, marginTop: Spacing.xl },
  footer: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.lg, paddingTop: Spacing.sm },
  cta: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    height: 56,
    borderRadius: Radius.full,
  },
  ctaText: { fontSize: 17, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  footNote: { fontSize: FontSize.sm, textAlign: 'center', marginTop: Spacing.sm },
});
