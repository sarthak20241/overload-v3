import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { hasClerkKey, useClerkUser } from '@/hooks/useClerkUser';
import { useTheme } from '@/hooks/useTheme';

// Catches the OAuth deep link (exp://.../--/sso-callback in Expo Go,
// overload://sso-callback in dev/prod builds). On Android the deep link
// navigates Expo Router here *before* the originating screen can finish
// activating the new session, so this route activates whichever pending
// session Clerk has on signIn/signUp and then redirects.
function ClerkSSOCallback() {
  const { C } = useTheme();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useSignIn, useSignUp } = require('@clerk/clerk-expo');
  const signInState = useSignIn();
  const signUpState = useSignUp();
  const { isSignedIn, isLoaded: userLoaded } = useClerkUser();
  const [giveUp, setGiveUp] = useState(false);
  const activatedRef = useRef(false);

  useEffect(() => {
    WebBrowser.maybeCompleteAuthSession();
  }, []);

  // Watch for a pending OAuth session and activate it. We depend on the
  // session-id values directly because Clerk's resource refs may not change
  // when only the createdSessionId field updates.
  const signInSessionId: string | undefined = signInState?.signIn?.createdSessionId;
  const signUpSessionId: string | undefined = signUpState?.signUp?.createdSessionId;

  useEffect(() => {
    if (activatedRef.current) return;
    if (signInSessionId && signInState?.setActive) {
      activatedRef.current = true;
      signInState.setActive({ session: signInSessionId }).catch((e: any) => {
        console.warn('[sso-callback] setActive(signIn) failed', e);
      });
    } else if (signUpSessionId && signUpState?.setActive) {
      activatedRef.current = true;
      signUpState.setActive({ session: signUpSessionId }).catch((e: any) => {
        console.warn('[sso-callback] setActive(signUp) failed', e);
      });
    }
  }, [signInSessionId, signUpSessionId, signInState, signUpState]);

  // Generous bail-out: 12s. Most successful flows resolve in under a second
  // once Clerk processes the redirect, so this is just a guard against an
  // indefinite spinner if nothing ever arrives.
  useEffect(() => {
    const t = setTimeout(() => setGiveUp(true), 12000);
    return () => clearTimeout(t);
  }, []);

  if (userLoaded && isSignedIn) {
    return <Redirect href="/(app)" />;
  }

  if (giveUp && userLoaded && !isSignedIn) {
    return <Redirect href="/(auth)" />;
  }

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.background,
        gap: 16,
      }}
    >
      <ActivityIndicator size="large" color={C.accentText} />
    </View>
  );
}

export default function SSOCallback() {
  if (!hasClerkKey) {
    return <Redirect href="/(auth)" />;
  }
  return <ClerkSSOCallback />;
}
