/**
 * CoachAccessGate — the "what does the user see when they tap Coach Drona?"
 * router.
 *
 * Sits between AICoachModal's chrome (slide-up sheet + header) and its
 * feature screens (chat / plan / workout). When the caller has paid or
 * trialing access, this component renders nothing and the modal proceeds to
 * its normal screen dispatch. Otherwise it takes over the modal body and
 * shows one of:
 *
 *   - loading            → spinner while we wait for get_coach_access_status
 *   - unauthenticated    → "sign in to continue" (no Clerk session)
 *   - eligible_for_trial → big CTA → calls start_coach_trial RPC → refresh()
 *   - trial_ended        → message + paywall stub (real paywall lands Phase 4)
 *   - unknown            → spinner (RPC error or unexpected state — safer to
 *                          wait than to lock the user out, since refresh()
 *                          will retry).
 *
 * Why a gate component and not a check inside each screen?
 *   - The chat, plan, and workout screens all need the same gate. Branching
 *     once at the modal level keeps the screens focused on their own job.
 *   - Server-side enforcement is the actual security boundary (ai-coach
 *     edge function re-checks every request). This component is UX only.
 *
 * Props are passed in from AICoachModal — the hook is called once at the
 * modal level so the access state is a single source of truth across the
 * close→reopen lifecycle.
 */
import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import type { CoachAccess } from '@/hooks/useCoachAccess';
import { Paywall } from './Paywall';

type GateScreen =
  | 'allow'                  // pass-through: caller renders the real content
  | 'loading'
  | 'sign_in'
  | 'start_trial'
  | 'trial_ended'
  | 'unknown';

function pickScreen(access: CoachAccess, loading: boolean): GateScreen {
  if (loading) return 'loading';
  switch (access.state) {
    case 'paid':
    case 'trialing':
      return 'allow';
    case 'unauthenticated':
      return 'sign_in';
    case 'eligible_for_trial':
      return 'start_trial';
    case 'trial_ended':
      return 'trial_ended';
    case 'unknown':
    default:
      return 'unknown';
  }
}

export interface CoachAccessGateProps {
  access: CoachAccess;
  loading: boolean;
  refresh: () => Promise<void>;
  supabase: SupabaseClient;
  onClose: () => void;
  // Routes the user to the auth screen from the unauthenticated state. When
  // omitted (e.g. Clerk isn't configured) the sign-in screen falls back to a
  // plain close so the card is never a hard dead end.
  onRequestSignIn?: () => void;
  // Phase 4 will pass an onOpenPaywall here; for now the stub renders inline.
}

/**
 * Returns the gate UI for blocked states, or `null` when the caller should
 * proceed to render real coach content. Render the result with
 * `{gate ?? <RealContent />}` from the parent.
 */
export function CoachAccessGate(props: CoachAccessGateProps): React.ReactElement | null {
  const screen = pickScreen(props.access, props.loading);
  if (screen === 'allow') return null;

  return <GateBody screen={screen} {...props} />;
}

function GateBody({
  screen,
  access,
  refresh,
  supabase,
  onClose,
  onRequestSignIn,
}: CoachAccessGateProps & { screen: Exclude<GateScreen, 'allow'> }) {
  const { C } = useTheme();
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Manual paywall open — used by the "See all plans" link on start_trial.
  // For trial_ended we short-circuit to the paywall below without this flag
  // (the trial-ended screen has no other useful content).
  const [showPaywallManual, setShowPaywallManual] = useState(false);

  // trial_ended → paywall IS the gate body. Close = close the whole modal.
  if (screen === 'trial_ended') {
    return (
      <Paywall
        supabase={supabase}
        onClose={onClose}
        onPurchased={refresh}
      />
    );
  }

  // Manual paywall (from "See all plans" link) → close returns to the
  // start_trial screen so the user can still grab the free trial.
  if (showPaywallManual) {
    return (
      <Paywall
        supabase={supabase}
        onClose={() => setShowPaywallManual(false)}
        onPurchased={refresh}
      />
    );
  }

  const handleStartTrial = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc('start_coach_trial');
      if (rpcErr) throw rpcErr;
      // RPC contract: { ok: boolean, reason?: string, ... }
      const ok = (data as any)?.ok === true;
      if (!ok) {
        const reason = (data as any)?.reason ?? 'unknown';
        // 'already_trialed' shouldn't be possible here (we only show the
        // start screen for eligible_for_trial), but if state got stale,
        // just refresh — get_coach_access_status will return the truth.
        if (reason === 'already_trialed') {
          await refresh();
          return;
        }
        if (reason === 'unauthorized') {
          setError('Sign in to start your trial.');
          return;
        }
        setError("Couldn't start your trial. Try again.");
        return;
      }
      await refresh();
    } catch {
      setError("Couldn't start your trial. Check your connection.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Header — minimal, matches the menu sheet's chrome. */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={onClose}
          style={[s.closeCircle, { backgroundColor: C.muted }]}
        >
          <Feather name="x" size={16} color={C.foreground} />
        </TouchableOpacity>
        <Text style={[s.title, { color: C.foreground }]}>Coach Drona</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.body}
        showsVerticalScrollIndicator={false}
      >
        {screen === 'loading' && (
          <View style={s.spinnerWrap}>
            <ActivityIndicator color={C.foreground} />
          </View>
        )}

        {screen === 'unknown' && (
          // Settled (not loading) but access couldn't be resolved — e.g. offline
          // cold-start with no cached state. Show a retry instead of a perpetual
          // "Reconnecting…" spinner the user can't escape from.
          <View style={s.card}>
            <View style={[s.iconWrap, { backgroundColor: C.muted }]}>
              <Feather name="wifi-off" size={28} color={C.foreground} />
            </View>
            <Text style={[s.cardTitle, { color: C.foreground }]}>
              Couldn't reach Coach Drona
            </Text>
            <Text style={[s.cardBody, { color: C.mutedFg }]}>
              Coach needs a connection. Check your network and try again.
            </Text>
            <TouchableOpacity
              style={[s.primaryBtn, { backgroundColor: Colors.primary, opacity: retrying ? 0.6 : 1 }]}
              disabled={retrying}
              onPress={async () => {
                if (retrying) return;
                setRetrying(true);
                try {
                  await refresh();
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? (
                <ActivityIndicator color={Colors.primaryFg} />
              ) : (
                <Text style={[s.primaryBtnText, { color: Colors.primaryFg }]}>Retry</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {screen === 'sign_in' && (
          <View style={s.card}>
            <View style={[s.iconWrap, { backgroundColor: C.muted }]}>
              <Feather name="user" size={28} color={C.foreground} />
            </View>
            <Text style={[s.cardTitle, { color: C.foreground }]}>
              Sign in to meet Coach Drona
            </Text>
            <Text style={[s.cardBody, { color: C.mutedFg }]}>
              Drona learns from your training history. Sign in to start a 7-day free trial.
            </Text>
            {onRequestSignIn ? (
              <>
                <TouchableOpacity
                  style={[s.primaryBtn, { backgroundColor: Colors.primary }]}
                  onPress={onRequestSignIn}
                >
                  <Text style={[s.primaryBtnText, { color: Colors.primaryFg }]}>Sign in</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.secondaryLink} onPress={onClose}>
                  <Text style={[s.secondaryLinkText, { color: C.mutedFg }]}>Not now</Text>
                </TouchableOpacity>
              </>
            ) : (
              // No auth screen reachable (e.g. Clerk unconfigured) — keep the
              // close affordance rather than a button that goes nowhere.
              <TouchableOpacity
                style={[s.primaryBtn, { backgroundColor: Colors.primary }]}
                onPress={onClose}
              >
                <Text style={[s.primaryBtnText, { color: Colors.primaryFg }]}>Close</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {screen === 'start_trial' && (
          <View style={s.card}>
            <View style={[s.iconWrap, { backgroundColor: C.primarySubtle }]}>
              <Feather name="zap" size={28} color={C.accentText} />
            </View>
            <Text style={[s.cardTitle, { color: C.foreground }]}>
              Try Coach Drona free for 7 days
            </Text>
            <Text style={[s.cardBody, { color: C.mutedFg }]}>
              Unlimited plan generation, workout templates, and one-on-one chat with the
              same coach paid members get. Cancel anytime — no card required.
            </Text>

            <TouchableOpacity
              style={[
                s.primaryBtn,
                { backgroundColor: Colors.primary, opacity: starting ? 0.6 : 1 },
              ]}
              onPress={handleStartTrial}
              disabled={starting}
            >
              {starting ? (
                <ActivityIndicator color={Colors.primaryFg} />
              ) : (
                <Text style={[s.primaryBtnText, { color: Colors.primaryFg }]}>
                  Start 7-day free trial
                </Text>
              )}
            </TouchableOpacity>

            {error && (
              <Text style={[s.errorText, { color: '#c53030' }]}>
                {error}
              </Text>
            )}

            {/* Skip-trial escape hatch for founding-deal hunters. Same paywall,
                opened via showPaywallManual so closing returns here. */}
            <TouchableOpacity
              style={s.secondaryLink}
              onPress={() => setShowPaywallManual(true)}
            >
              <Text style={[s.secondaryLinkText, { color: C.mutedFg }]}>
                See all plans →
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  closeCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  body: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xxxl,
    paddingBottom: Spacing.xl,
  },
  spinnerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
  },
  card: {
    alignItems: 'center',
    paddingTop: Spacing.lg,
  },
  iconWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  cardTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  cardBody: {
    fontSize: FontSize.base,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.xl,
    paddingHorizontal: Spacing.md,
  },
  primaryBtn: {
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 50,
  },
  primaryBtnText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  errorText: {
    marginTop: Spacing.md,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  helperText: {
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  secondaryLink: {
    marginTop: Spacing.lg,
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  secondaryLinkText: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
  },
});
