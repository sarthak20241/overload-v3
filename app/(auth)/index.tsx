import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { Colors, Radius, FontSize, FontWeight, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { ThemedAlert } from '@/components/ui/ThemedAlert';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';

function useWarmUpBrowser() {
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => { void WebBrowser.coolDownAsync(); };
  }, []);
}

const hasClerkKey = !!process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const { width: SCREEN_WIDTH } = Dimensions.get('window');

type Mode = 'login' | 'register' | 'forgot';

function GoogleIcon() {
  return (
    <View style={googleStyles.wrap}>
      <View style={googleStyles.row}>
        <View style={[googleStyles.half, { backgroundColor: '#4285F4' }]} />
        <View style={[googleStyles.half, { backgroundColor: '#34A853' }]} />
      </View>
      <View style={googleStyles.row}>
        <View style={[googleStyles.half, { backgroundColor: '#FBBC05' }]} />
        <View style={[googleStyles.half, { backgroundColor: '#EA4335' }]} />
      </View>
      <View style={googleStyles.center}>
        <Text style={googleStyles.letter}>G</Text>
      </View>
    </View>
  );
}

const googleStyles = StyleSheet.create({
  wrap: { width: 18, height: 18, borderRadius: 9, overflow: 'hidden', position: 'relative' },
  row: { flexDirection: 'row', height: 9 },
  half: { flex: 1 },
  center: {
    position: 'absolute', top: 2, left: 2, right: 2, bottom: 2,
    backgroundColor: '#fff', borderRadius: 7,
    alignItems: 'center', justifyContent: 'center',
  },
  letter: { fontSize: 9, fontWeight: '700', color: '#4285F4', marginTop: -1 },
});

function useClerkAuth() {
  if (!hasClerkKey) {
    return { signIn: null, signUp: null, startSSOFlow: null, setSignInActive: null, setSignUpActive: null, signInLoaded: false, signUpLoaded: false };
  }
  const { useSignIn, useSignUp, useSSO } = require('@clerk/clerk-expo');
  const si = useSignIn();
  const su = useSignUp();
  const sso = useSSO();
  return {
    signIn: si.signIn, setSignInActive: si.setActive, signInLoaded: si.isLoaded,
    signUp: su.signUp, setSignUpActive: su.setActive, signUpLoaded: su.isLoaded,
    startSSOFlow: sso.startSSOFlow,
  };
}

export default function AuthScreen() {
  useWarmUpBrowser();
  const router = useRouter();
  const { C } = useTheme();
  const { signIn, setSignInActive, signInLoaded, signUp, setSignUpActive, signUpLoaded, startSSOFlow } = useClerkAuth();

  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showResetSent, setShowResetSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (hasClerkKey && (!signInLoaded || !signUpLoaded)) return;
    setError('');
    setLoading(true);

    try {
      if (mode === 'login') {
        if (hasClerkKey) {
          const result = await signIn!.create({ identifier: email, password });
          await setSignInActive!({ session: result.createdSessionId });
        }
        router.replace('/(app)');
      } else if (mode === 'register') {
        if (!name.trim()) throw new Error('Please enter your name');
        if (password.length < 6) throw new Error('Password must be at least 6 characters');
        if (hasClerkKey) {
          const result = await signUp!.create({ emailAddress: email, password, firstName: name.split(' ')[0], lastName: name.split(' ')[1] });
          await setSignUpActive!({ session: result.createdSessionId });
        }
        router.replace('/(app)');
      } else {
        if (hasClerkKey) {
          await signIn!.create({ strategy: 'reset_password_email_code', identifier: email });
        }
        setShowResetSent(true);
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage || err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    if (!hasClerkKey || !startSSOFlow) return;
    setGoogleLoading(true);
    setError('');
    try {
      const redirectUrl = AuthSession.makeRedirectUri({
        scheme: 'overload',
        path: 'sso-callback',
      });
      const { createdSessionId, setActive, authSessionResult, signUp: su } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl,
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        router.replace('/(app)');
        return;
      }
      if (authSessionResult?.type && authSessionResult.type !== 'success') {
        return;
      }
      if (su?.status === 'missing_requirements') {
        const missing = su.missingFields?.join(', ') || 'additional info';
        setError(`Sign-up needs ${missing}. Set those fields to optional in your Clerk Dashboard, or collect them in a follow-up screen.`);
        return;
      }
      setError('Google sign-in did not complete.');
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage || err.message || 'Google sign-in failed');
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <>
    <SafeAreaView style={[styles.safeArea, { backgroundColor: C.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Background glow */}
          <View
            style={[
              styles.bgGlow,
              { backgroundColor: C.accentText, opacity: 0.04 },
            ]}
          />

          {/* Logo */}
          <Animated.View entering={FadeInUp.delay(0).duration(500)} style={styles.logoContainer}>
            <Text style={[styles.logoText, { color: C.foreground }]}>
              OVER<Text style={{ color: C.accentText }}>LOAD</Text>
            </Text>
            <Text style={[styles.logoSub, { color: C.textMuted }]}>
              Progressive Overload Tracker
            </Text>
          </Animated.View>

          {/* Card */}
          <Animated.View
            entering={FadeInDown.delay(100).duration(500)}
            style={[
              styles.card,
              {
                backgroundColor: C.elevated,
                borderColor: C.borderLight,
              },
            ]}
          >
            {/* Mode tabs */}
            {mode !== 'forgot' && (
              <View style={[styles.tabs, { backgroundColor: C.muted }]}>
                {(['login', 'register'] as Mode[]).map((m) => (
                  <TouchableOpacity
                    key={m}
                    onPress={() => { setMode(m); setError(''); }}
                    style={[
                      styles.tab,
                      mode === m && { backgroundColor: Colors.primary },
                    ]}
                    activeOpacity={0.7}
                  >
                    <Text style={[
                      styles.tabText,
                      { color: mode === m ? Colors.primaryFg : C.textSecondary },
                    ]}>
                      {m === 'login' ? 'Sign In' : 'Register'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Forgot header */}
            {mode === 'forgot' && (
              <View style={{ marginBottom: Spacing.xxl }}>
                <Text style={[styles.sectionTitle, { color: C.foreground }]}>Reset Password</Text>
                <Text style={[styles.sectionSub, { color: C.mutedFg }]}>
                  We'll send a reset link to your email
                </Text>
              </View>
            )}

            {/* Google */}
            {mode !== 'forgot' && hasClerkKey && (
              <TouchableOpacity
                onPress={handleGoogle}
                disabled={googleLoading}
                style={[
                  styles.googleBtn,
                  {
                    borderColor: C.border,
                    backgroundColor: C.glowBg,
                  },
                ]}
                activeOpacity={0.7}
              >
                {googleLoading ? (
                  <ActivityIndicator size="small" color={C.textMuted} />
                ) : (
                  <>
                    <GoogleIcon />
                    <Text style={[styles.googleText, { color: C.foreground }]}>
                      Continue with Google
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}

            {/* Divider */}
            {mode !== 'forgot' && hasClerkKey && (
              <View style={styles.divider}>
                <View style={[styles.dividerLine, { backgroundColor: C.borderLight }]} />
                <Text style={[styles.dividerText, { color: C.textMuted }]}>OR</Text>
                <View style={[styles.dividerLine, { backgroundColor: C.borderLight }]} />
              </View>
            )}

            {/* Name input (register) */}
            {mode === 'register' && (
              <View style={[styles.inputWrap, { backgroundColor: C.muted, borderColor: C.border }]}>
                <Feather name="user" size={15} color={C.textMuted} style={styles.inputIcon} />
                <TextInput
                  placeholder="Your name"
                  placeholderTextColor={C.textMuted}
                  value={name}
                  onChangeText={setName}
                  style={[styles.input, { color: C.foreground }]}
                />
              </View>
            )}

            {/* Email */}
            <View style={[styles.inputWrap, { backgroundColor: C.muted, borderColor: C.border }]}>
              <Feather name="mail" size={15} color={C.textMuted} style={styles.inputIcon} />
              <TextInput
                placeholder="Email address"
                placeholderTextColor={C.textMuted}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                style={[styles.input, { color: C.foreground }]}
              />
            </View>

            {/* Password */}
            {mode !== 'forgot' && (
              <View style={[styles.inputWrap, { backgroundColor: C.muted, borderColor: C.border }]}>
                <Feather name="lock" size={15} color={C.textMuted} style={styles.inputIcon} />
                <TextInput
                  placeholder="Password"
                  placeholderTextColor={C.textMuted}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPass}
                  style={[styles.input, { color: C.foreground }]}
                />
                <TouchableOpacity onPress={() => setShowPass(!showPass)} style={styles.eyeBtn}>
                  <Feather name={showPass ? 'eye-off' : 'eye'} size={15} color={C.textMuted} />
                </TouchableOpacity>
              </View>
            )}

            {/* Error */}
            {!!error && (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={14} color="#f87171" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Forgot link */}
            {mode === 'login' && (
              <TouchableOpacity
                onPress={() => { setMode('forgot'); setError(''); }}
                style={{ alignSelf: 'flex-end', marginBottom: 4 }}
              >
                <Text style={[styles.forgotText, { color: C.mutedFg }]}>Forgot password?</Text>
              </TouchableOpacity>
            )}

            {/* Submit button */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={loading}
              style={[styles.submitBtn, loading && { opacity: 0.6 }]}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator size="small" color={Colors.primaryFg} />
              ) : (
                <>
                  <Text style={styles.submitText}>
                    {mode === 'login' ? 'Sign In' : mode === 'register' ? 'Create Account' : 'Send Reset Email'}
                  </Text>
                  <Feather name="arrow-right" size={15} color={Colors.primaryFg} />
                </>
              )}
            </TouchableOpacity>

            {/* Back to login */}
            {mode === 'forgot' && (
              <TouchableOpacity
                onPress={() => { setMode('login'); setError(''); }}
                style={{ alignItems: 'center', marginTop: Spacing.md }}
              >
                <Text style={[styles.forgotText, { color: C.mutedFg }]}>Back to Sign In</Text>
              </TouchableOpacity>
            )}
          </Animated.View>

          {/* Guest */}
          {mode !== 'forgot' && (
            <Animated.View entering={FadeInDown.delay(200).duration(500)} style={{ alignItems: 'center', marginTop: Spacing.lg }}>
              <TouchableOpacity onPress={() => router.replace('/(app)')}>
                <Text style={[styles.guestText, { color: C.textMuted }]}>Continue as guest</Text>
              </TouchableOpacity>
            </Animated.View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>

    <ThemedAlert
      visible={showResetSent}
      icon="mail"
      iconColor={Colors.primary}
      title="Reset Email Sent!"
      message="Check your inbox for a reset link."
      buttons={[{
        text: 'OK',
        style: 'primary',
        onPress: () => { setShowResetSent(false); setMode('login'); },
      }]}
      onClose={() => { setShowResetSent(false); setMode('login'); }}
    />
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.xxxl,
  },
  bgGlow: {
    position: 'absolute',
    top: -150,
    left: SCREEN_WIDTH / 2 - 192,
    width: 384,
    height: 384,
    borderRadius: 192,
  },
  logoContainer: { alignItems: 'center', marginBottom: 40 },
  logoText: {
    fontSize: 40,
    fontWeight: FontWeight.black,
    letterSpacing: -1,
  },
  logoSub: {
    fontSize: FontSize.sm,
    marginTop: 4,
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: Radius.xxl,
    borderWidth: 1,
    padding: Spacing.xxl,
  },
  tabs: {
    flexDirection: 'row',
    borderRadius: Radius.xl,
    padding: 4,
    marginBottom: Spacing.xxl,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    alignItems: 'center',
  },
  tabText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.semibold,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  sectionSub: { fontSize: FontSize.xs, marginTop: 4 },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    borderWidth: 1,
    marginBottom: Spacing.lg,
  },
  googleText: { fontSize: FontSize.base, fontWeight: FontWeight.medium },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: Spacing.lg,
  },
  dividerLine: { flex: 1, height: 1 },
  dividerText: { fontSize: 10, letterSpacing: 2, textTransform: 'uppercase' },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.xl,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    height: 52,
  },
  inputIcon: { marginRight: Spacing.md },
  input: { flex: 1, fontSize: FontSize.base },
  eyeBtn: { padding: 4 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.20)',
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  errorText: { color: '#f87171', fontSize: FontSize.sm, flex: 1 },
  forgotText: { fontSize: FontSize.sm },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingVertical: 14,
    borderRadius: Radius.xl,
    marginTop: 4,
  },
  submitText: {
    fontSize: FontSize.base,
    fontWeight: FontWeight.bold,
    color: Colors.primaryFg,
  },
  guestText: { fontSize: FontSize.base },
});
