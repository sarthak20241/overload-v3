// Use Overload in ChatGPT or Claude. Redesigned 2026-11-14 to match the
// paywall's glass (components/paywall/PaywallParts.tsx): a strong-glass chat
// card shows what it does, three short quiet-glass step cards show how, and
// one button does the next step (Copy link, then Open ChatGPT / Claude). The
// long steps and the fine print sit behind one row, closed by default.
//
// The connector itself is supabase/functions/mcp. It serves Pro, trial and
// Connect accounts (hasConnectorAccess in supabase/functions/mcp/access.ts),
// so an account with none of those sees the way to a plan instead.
import { useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { FontFamily, IconSize, Shadow } from '@/constants/theme';
import { useCoachAccess } from '@/hooks/useCoachAccess';
import { useClerkUser } from '@/hooks/useClerkUser';
import { setConnectNudge } from '@/lib/connectNudge';
import { PressableScale } from '@/components/ui/PressableScale';
import { useToast } from '@/components/ui/Toast';
import { Bubble, GlassCaption, GlassCard, useGlass } from '@/components/paywall/PaywallParts';
import { track } from '@/lib/analytics';
import { copyToClipboard } from '@/lib/clipboard';
import {
  AI_APPS,
  APP_SETTINGS_URL,
  CONNECT_STEPS,
  MCP_URL,
  SHORT_STEPS,
  stepMarks,
  TRY_ASKING,
  type AiApp,
} from '@/lib/aiConnect';

// ChatGPT first: more people already use it.
const APP_ORDER: AiApp[] = ['chatgpt', 'claude'];
const APP_LABEL: Record<AiApp, string> = Object.fromEntries(AI_APPS.map((a) => [a.id, a.label])) as Record<AiApp, string>;

export default function ConnectAiScreen() {
  const g = useGlass();
  const { C } = g;
  const router = useRouter();
  const toast = useToast();
  const { access, loading } = useCoachAccess();
  const { user } = useClerkUser();
  const [app, setApp] = useState<AiApp>('chatgpt');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [details, setDetails] = useState(false);
  const [opened, setOpened] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Copy failed: scroll to the selectable link at the top of Full steps. Its
  // y comes from that block's onLayout; if Full steps is closed, the scroll
  // waits until it has opened and laid out.
  const linkY = useRef<number | null>(null);
  const scrollToLink = useRef(false);

  // Same rule as the server (mcp/access.ts hasConnectorAccess): a paid plan,
  // a live trial, or an active Overload Connect plan.
  const known = !loading && access.state !== 'unknown';
  const hasPlan = access.state === 'paid' || access.state === 'trialing' || access.connect === true;
  const needsPlan = known && !hasPlan;

  useEffect(() => {
    track('ai_connect_opened');
  }, []);

  // From the paywall's success screen (a new Connect buyer) there is nothing
  // to go back to: close to the dashboard. From Profile, go back to Profile.
  const { from } = useLocalSearchParams<{ from?: string }>();
  const leave = () => {
    if (from === 'paywall') router.replace('/(app)');
    else if (router.canGoBack()) router.back();
    else router.replace('/(app)/profile' as any);
  };

  const copy = async () => {
    const ok = await copyToClipboard(MCP_URL);
    track('ai_connect_link_copied', { ok, app });
    if (ok) {
      setCopied(true);
      toast.success('Link copied');
    } else {
      // The link is selectable in "Full steps", so open that.
      setCopyFailed(true);
      if (details && linkY.current != null) {
        scrollRef.current?.scrollTo({ y: Math.max(0, linkY.current - 16), animated: true });
      } else {
        scrollToLink.current = true;
        setDetails(true);
      }
      toast.error('Could not copy. Press and hold the link below to copy it.');
    }
  };

  const openApp = () => {
    track('ai_connect_app_opened', { app });
    setOpened(true);
    Linking.openURL(APP_SETTINGS_URL[app])
      // Only once it really opened: the best sign this app has that they
      // connected, so the dashboard's "Connect your AI" reminder goes away.
      .then(() => { if (user?.id) void setConnectNudge(user.id, 'done'); })
      .catch(() => toast.error(`Could not open ${APP_LABEL[app]}.`));
  };

  // Step looks: lib/aiConnect.ts stepMarks (tested). The button is "Open"
  // once the link is copied (or copying failed and they copy it by hand).
  const marks = stepMarks({ copied, copyFailed, opened, needsPlan });
  const canOpen = copied || copyFailed;

  return (
    <SafeAreaView style={[s.root, { backgroundColor: C.background }]} edges={['top', 'bottom']}>
      <View style={s.topBar}>
        <TouchableOpacity
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={s.closeHit}
        >
          <View style={[s.closeBtn, { backgroundColor: g.quietFill }]}>
            <Feather name="x" size={IconSize.md} color={C.textSecondary} />
          </View>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={s.body}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[s.title, { color: C.foreground }]} accessibilityRole="header">Overload, inside your AI</Text>
        <Text style={[s.sub, { color: C.textSecondary }]}>Log and ask from the chat you already use.</Text>

        {/* Which app */}
        <View
          accessibilityRole="tablist"
          style={[s.switch, { backgroundColor: g.quietFill, borderColor: g.quietEdge, borderTopColor: g.quietTop }]}
        >
          {APP_ORDER.map((id) => {
            const on = id === app;
            return (
              <TouchableOpacity
                key={id}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => { if (!on) { setApp(id); setOpened(false); track('ai_connect_app_switched', { app: id }); } }}
                style={[s.switchItem, on && { backgroundColor: g.selectedPill }]}
              >
                <Text
                  style={[
                    s.switchText,
                    { color: on ? C.foreground : C.textSecondary },
                    on && { fontFamily: FontFamily.onboardingHeading },
                  ]}
                >
                  {APP_LABEL[id]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* What it does: the hero */}
        <View style={s.heroGap}>
          <GlassCard>
            <GlassCaption text={`In your ${APP_LABEL[app]}`} />
            <Bubble mine text="I ate 2 eggs and toast" />
            <Bubble text="Saved to Overload. 310 calories." />
            <Bubble mine text="How was my protein this week?" />
            <Bubble text="Low on 4 of 7 days." />
          </GlassCard>
        </View>

        {/* How: three short steps */}
        <View style={s.steps}>
          {SHORT_STEPS[app].map((step, i) => {
            const done = marks[i] === 'done';
            const next = marks[i] === 'next';
            return (
              <TouchableOpacity
                key={step.title}
                // Step 1 copies the link (again, once the button says Open).
                disabled={i !== 0 || needsPlan}
                onPress={copy}
                activeOpacity={0.7}
                accessible
                accessibilityRole={i === 0 && !needsPlan ? 'button' : undefined}
                accessibilityLabel={`Step ${i + 1}${done ? ', done' : ''}. ${step.title}. ${step.detail}`}
                accessibilityHint={i === 0 && !needsPlan ? 'Copies the link' : undefined}
                style={[s.step, { backgroundColor: g.quietFill, borderColor: g.quietEdge, borderTopColor: g.quietTop }]}
              >
                <View style={[s.stepDot, { backgroundColor: next || done ? g.lime : g.selectedPill }]}>
                  {done ? (
                    <Feather name="check" size={14} color={g.onLime} />
                  ) : (
                    <Text style={[s.stepNum, { color: next ? g.onLime : C.foreground }]}>{i + 1}</Text>
                  )}
                </View>
                <View style={s.stepTextWrap}>
                  <Text style={[s.stepTitle, { color: C.foreground }]}>{step.title}</Text>
                  <Text style={[s.stepDetail, { color: C.textSecondary }]}>{step.detail}</Text>
                </View>
                {i === 0 && copied && !needsPlan && (
                  <Feather name="copy" size={IconSize.sm} color={C.textSecondary} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* The long version, closed by default */}
        <TouchableOpacity
          onPress={() => { if (details) linkY.current = null; setDetails((d) => !d); track('ai_connect_details_toggled', { open: !details, app }); }}
          accessibilityRole="button"
          accessibilityState={{ expanded: details }}
          style={[s.moreRow, { borderColor: g.quietEdge }]}
        >
          <Text style={[s.moreText, { color: C.foreground }]}>Full steps and what it can change</Text>
          <Feather name={details ? 'chevron-up' : 'chevron-down'} size={IconSize.md} color={C.textSecondary} />
        </TouchableOpacity>

        {details && (
          <View
            style={s.details}
            onLayout={(e) => {
              // The link is the first thing in Full steps, so its top is the link.
              // This y is only right while this View is a direct child of the
              // ScrollView content; keep it there.
              linkY.current = e.nativeEvent.layout.y;
              if (scrollToLink.current) {
                scrollToLink.current = false;
                scrollRef.current?.scrollTo({ y: Math.max(0, linkY.current - 16), animated: true });
              }
            }}
          >
            <Text style={[s.detailHead, { color: C.textSecondary }]}>Your link</Text>
            <Text selectable style={[s.link, { color: C.foreground }]}>{MCP_URL}</Text>

            <Text style={[s.detailHead, { color: C.textSecondary }]}>{APP_LABEL[app]}, step by step</Text>
            {CONNECT_STEPS[app].map((step, i) => (
              <Text key={i} style={[s.detailText, { color: C.foreground }]}>{i + 1}. {step}</Text>
            ))}

            <Text style={[s.detailHead, { color: C.textSecondary }]}>Then try</Text>
            {TRY_ASKING.map((q) => (
              <Text key={q} style={[s.detailText, { color: C.foreground }]}>“{q}”</Text>
            ))}

            <Text style={[s.detailHead, { color: C.textSecondary }]}>What it can change</Text>
            <Text style={[s.detailText, { color: C.foreground }]}>
              It logs and edits food and workouts, and saves routines and plans it writes. It can
              delete only food and workouts it logged, never your own routines. It asks before it
              changes, ends or deletes your plan. Workouts it logs earn no XP. Disconnect any time
              in your assistant’s settings. ChatGPT setup depends on your plan and workspace.
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={s.footer}>
        {needsPlan ? (
          <>
            <PressableScale
              onPress={() => { track('upgrade_prompt_tapped', { from: 'ai_connect' }); router.push('/upgrade?context=connect' as any); }}
              style={[s.cta, Shadow.playBtn, { backgroundColor: g.lime }]}
              accessibilityRole="button"
              accessibilityLabel="See plans to connect"
            >
              <Text style={[s.ctaText, { color: g.onLime }]}>See plans to connect</Text>
            </PressableScale>
            <Text style={[s.footNote, { color: C.textSecondary }]}>Part of Overload Connect and Overload Pro.</Text>
          </>
        ) : (
          <PressableScale
            onPress={canOpen ? openApp : copy}
            style={[s.cta, Shadow.playBtn, { backgroundColor: g.lime }]}
            accessibilityRole="button"
            accessibilityLabel={canOpen ? `Open ${APP_LABEL[app]}` : 'Copy link'}
          >
            <Text style={[s.ctaText, { color: g.onLime }]}>
              {canOpen ? `Open ${APP_LABEL[app]}` : 'Copy link'}
            </Text>
          </PressableScale>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12 },
  closeHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 20 },
  title: { fontFamily: FontFamily.onboardingHeading, fontSize: 28, lineHeight: 34 },
  sub: { fontFamily: FontFamily.onboardingBody, fontSize: 15, lineHeight: 21, marginTop: 6 },
  switch: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, padding: 3, marginTop: 20 },
  switchItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  switchText: { fontSize: 15, fontFamily: FontFamily.onboardingBody },
  heroGap: { marginTop: 16 },
  steps: { marginTop: 18, gap: 8 },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 60,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  stepDot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  stepNum: { fontSize: 14, fontFamily: FontFamily.onboardingHeading },
  stepTextWrap: { flex: 1 },
  stepTitle: { fontSize: 15, fontFamily: FontFamily.onboardingHeading },
  stepDetail: { fontSize: 13, lineHeight: 18, marginTop: 2, fontFamily: FontFamily.onboardingBody },
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    marginTop: 16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  moreText: { fontSize: 15, fontFamily: FontFamily.onboardingBody },
  details: { paddingTop: 4 },
  detailHead: { fontSize: 13, fontFamily: FontFamily.onboardingHeading, marginTop: 16, marginBottom: 6 },
  detailText: { fontSize: 14, lineHeight: 21, fontFamily: FontFamily.onboardingBody, marginBottom: 4 },
  link: { fontSize: 16, fontFamily: FontFamily.onboardingHeading },
  footer: { paddingHorizontal: 20, paddingBottom: 12, paddingTop: 8 },
  cta: { alignItems: 'center', justifyContent: 'center', height: 56, borderRadius: 999 },
  ctaText: { fontSize: 17, fontFamily: FontFamily.onboardingHeading },
  footNote: { fontSize: 13, textAlign: 'center', marginTop: 8, fontFamily: FontFamily.onboardingBody },
});
