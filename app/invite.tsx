// Invite screen: enter a code, get a free month of Pro.
//
// Opened by overload://invite?code=CODE (the tryoverload.app/i/CODE page) or
// from Profile. A signed-out visitor keeps the code for after sign-up.
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import { useClerkUser } from '@/hooks/useClerkUser';
import { useSupabaseClient } from '@/lib/supabase';
import { invalidateCoachAccess } from '@/hooks/useCoachAccess';
import { PressableScale } from '@/components/ui/PressableScale';
import { track } from '@/lib/analytics';
import {
  clearPendingInvite,
  normalizeCode,
  readPendingInvite,
  readRedeemResult,
  redeemFailureCopy,
  appliedSummary,
  appleLinkedSummary,
  APPLE_FRIEND_OFFER_CODE,
  friendMonthFromStore,
  inviteIntroCopy,
  type AppliedSummary,
  savePendingInvite,
  storeRedeemUrl,
} from '@/lib/invite';

export default function InviteScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const { isLoaded, isSignedIn } = useClerkUser();
  const params = useLocalSearchParams<{ code?: string }>();
  const [code, setCode] = useState(normalizeCode(params.code ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // appleOffer: iPhone, where the month itself is redeemed through Apple next.
  const [success, setSuccess] = useState<(AppliedSummary & { appleOffer?: string }) | null>(null);
  const viaApple = friendMonthFromStore(Platform.OS);
  // Our server doesn't know the code: it may be an App Store or Play
  // discount code, which only the store can redeem.
  const [maybeStoreCode, setMaybeStoreCode] = useState<string | null>(null);

  useEffect(() => {
    track('invite_opened', { from_link: !!params.code });
    if (params.code) {
      // A new link while this screen is open replaces the code on screen.
      setCode(normalizeCode(params.code));
      setError(null);
      setMaybeStoreCode(null);
      setSuccess(null);
      savePendingInvite(params.code);
    } else {
      readPendingInvite().then((saved) => {
        if (saved) setCode((c) => c || saved);
      });
    }
  }, [params.code]);

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

  async function redeem() {
    const clean = normalizeCode(code);
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    setMaybeStoreCode(null);
    let result;
    try {
      // iPhone: only record the referral; Apple gives the month (rule 3.1.1).
      const { data, error: rpcError } = await supabase.rpc(viaApple ? 'link_referral' : 'redeem_invite', { p_code: clean });
      result = readRedeemResult(data, rpcError);
    } catch (e) {
      result = readRedeemResult(null, e);
    } finally {
      setBusy(false);
    }
    if (result.ok) {
      track('invite_redeemed', { days: result.days, is_owner: result.isOwner, via_apple: viaApple });
      clearPendingInvite();
      invalidateCoachAccess();
      setSuccess(viaApple
        ? { ...appleLinkedSummary(clean, result.ownerRewarded, { days: result.days, expiresAt: result.expiresAt }), appleOffer: APPLE_FRIEND_OFFER_CODE }
        : appliedSummary(result, clean));
    } else if (result.reason === 'store_only') {
      // iPhone, a campaign or old-app code: Apple redeems it, not us.
      track('invite_store_code', { platform: Platform.OS, reason: 'store_only' });
      clearPendingInvite();
      setError(redeemFailureCopy(result.reason));
      void Linking.openURL(storeRedeemUrl(clean, 'ios'));
    } else {
      track('invite_failed', { reason: result.reason });
      // Codes that will never work for this account are not kept for later.
      if (['already_redeemed', 'already_pro', 'own_code', 'expired', 'code_full'].includes(result.reason)) {
        clearPendingInvite();
      }
      setError(redeemFailureCopy(result.reason));
      if (result.reason === 'invalid_code' && (Platform.OS === 'ios' || Platform.OS === 'android')) {
        setMaybeStoreCode(clean);
      }
    }
  }

  const signedOut = isLoaded && !isSignedIn;

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

      <KeyboardAvoidingView
        style={s.body}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {success ? (
          // Code applied: say exactly what the person got, then one way on.
          <View style={s.main}>
            <View style={[s.doneMark, { backgroundColor: C.primaryMuted }]}>
              <Feather name="check" size={28} color={C.accentText} />
            </View>
            <Text style={[s.eyebrow, { color: C.accentText }]}>OVERLOAD PRO</Text>
            <Text style={[s.title, { color: C.foreground }]}>{success.title}</Text>
            <View style={[s.summary, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
              {success.rows.map((row, i) => (
                <View
                  key={row.label}
                  style={[s.summaryRow, i > 0 && { borderTopWidth: 1, borderTopColor: C.borderSubtle }]}
                >
                  <Text style={[s.summaryLabel, { color: C.textMuted }]}>{row.label}</Text>
                  <Text style={[s.summaryValue, { color: C.foreground }]}>{row.value}</Text>
                </View>
              ))}
            </View>
            {success.friendLine && (
              <Text style={[s.friendLine, { color: C.textSecondary }]}>{success.friendLine}</Text>
            )}
          </View>
        ) : (
        <View style={s.main}>
          <Text style={[s.eyebrow, { color: C.accentText }]}>INVITE</Text>
          <Text style={[s.title, { color: C.foreground }]}>Got a code?</Text>
          <Text style={[s.sub, { color: C.textSecondary }]}>
            {signedOut
              ? 'Make your free account first. Then open your invite link again, or enter the code here.'
              : inviteIntroCopy(Platform.OS)}
          </Text>

          {!signedOut && (
            <>
              <TextInput
                value={code}
                onChangeText={(t) => {
                  setCode(normalizeCode(t));
                  setError(null);
                }}
                placeholder="Your code"
                placeholderTextColor={C.textDim}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                maxLength={16}
                returnKeyType="go"
                onSubmitEditing={redeem}
                accessibilityLabel="Invite code"
                style={[s.input, { backgroundColor: C.inputBg, color: C.foreground, borderColor: error ? C.dangerText : C.borderSubtle }]}
              />
              {error && <Text style={[s.error, { color: C.dangerText }]}>{error}</Text>}
              {maybeStoreCode && (
                <TouchableOpacity
                  onPress={() => {
                    track('invite_store_code', { platform: Platform.OS });
                    void Linking.openURL(storeRedeemUrl(maybeStoreCode, Platform.OS === 'ios' ? 'ios' : 'android'));
                  }}
                  accessibilityRole="link"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[s.storeLink, { color: C.accentText }]}>
                    {Platform.OS === 'ios' ? 'Is it a discount code? Use it in the App Store' : 'Is it a discount code? Use it in Google Play'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
        )}

        <View style={s.footer}>
          <PressableScale
            onPress={
              success?.appleOffer
                ? () => {
                    track('invite_apple_offer_opened');
                    void Linking.openURL(storeRedeemUrl(success.appleOffer!, 'ios'));
                  }
                : success
                ? () => router.replace('/(app)')
                : signedOut
                  ? () => router.replace('/(auth)')
                  : redeem
            }
            disabled={busy || (!success && !signedOut && !normalizeCode(code))}
            style={[s.cta, Shadow.playBtn, (busy || (!success && !signedOut && !normalizeCode(code))) && { opacity: 0.5 }]}
            accessibilityRole="button"
          >
            <Text style={s.ctaText}>
              {success?.appleOffer
                ? 'Get my free month'
                : success
                ? 'Start training'
                : signedOut
                  ? 'Make my free account'
                  : busy
                    ? 'Applying…'
                    : 'Apply code'}
            </Text>
          </PressableScale>
          {success?.appleOffer && (
            <TouchableOpacity
              onPress={() => router.replace('/(app)')}
              accessibilityRole="button"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={s.doneLink}
            >
              <Text style={[s.storeLink, { color: C.textMuted, marginTop: 0 }]}>Done</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
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
  body: { flex: 1, paddingHorizontal: Spacing.xl },
  main: { flex: 1, justifyContent: 'center' },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginBottom: Spacing.sm,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: 32,
    letterSpacing: LetterSpacing.tight,
    lineHeight: 38,
  },
  sub: { fontSize: FontSize.base, lineHeight: 21, marginTop: Spacing.md },
  input: {
    marginTop: Spacing.xxl,
    height: 56,
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    fontSize: 20,
    fontWeight: FontWeight.bold,
    letterSpacing: 3,
    textAlign: 'center',
  },
  error: { fontSize: FontSize.sm, lineHeight: 18, marginTop: Spacing.sm, textAlign: 'center' },
  doneMark: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  summary: { marginTop: Spacing.xl, borderRadius: Radius.lg, borderWidth: 1, paddingHorizontal: Spacing.lg },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
  },
  summaryLabel: { fontSize: FontSize.sm },
  summaryValue: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, flexShrink: 1, textAlign: 'right' },
  friendLine: { fontSize: FontSize.sm, marginTop: Spacing.md, textAlign: 'center' },
  doneLink: { alignItems: 'center', marginTop: Spacing.md },
  storeLink: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, marginTop: Spacing.md, textAlign: 'center' },
  footer: { paddingBottom: Spacing.lg },
  cta: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    height: 56,
    borderRadius: Radius.full,
  },
  ctaText: { fontSize: 17, fontWeight: FontWeight.bold, color: Colors.primaryFg },
});
