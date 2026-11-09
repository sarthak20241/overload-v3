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
  redeemSuccessCopy,
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
  const [success, setSuccess] = useState<string | null>(null);
  // Our server doesn't know the code: it may be an App Store or Play
  // discount code, which only the store can redeem.
  const [maybeStoreCode, setMaybeStoreCode] = useState<string | null>(null);

  useEffect(() => {
    track('invite_opened', { from_link: !!params.code });
    if (params.code) {
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
      const { data, error: rpcError } = await supabase.rpc('redeem_invite', { p_code: clean });
      result = readRedeemResult(data, rpcError);
    } catch (e) {
      result = readRedeemResult(null, e);
    } finally {
      setBusy(false);
    }
    if (result.ok) {
      track('invite_redeemed', { days: result.days, is_owner: result.isOwner });
      clearPendingInvite();
      invalidateCoachAccess();
      setSuccess(redeemSuccessCopy(result.days));
    } else {
      track('invite_failed', { reason: result.reason });
      if (result.reason === 'already_redeemed' || result.reason === 'already_pro') clearPendingInvite();
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
        <View style={s.main}>
          <Text style={[s.eyebrow, { color: C.accentText }]}>INVITE</Text>
          <Text style={[s.title, { color: C.foreground }]}>
            {success ? "You're in." : 'Got a code?'}
          </Text>
          <Text style={[s.sub, { color: C.textSecondary }]}>
            {success
              ?? (signedOut
                ? 'Make your free account first. Then open your invite link again, or enter the code here.'
                : 'A code from a friend gives you a month of Pro, free. No card needed.')}
          </Text>

          {!success && !signedOut && (
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

        <View style={s.footer}>
          <PressableScale
            onPress={
              success
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
              {success
                ? 'Start training'
                : signedOut
                  ? 'Make my free account'
                  : busy
                    ? 'Checking your code…'
                    : 'Use my code'}
            </Text>
          </PressableScale>
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
