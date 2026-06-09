import { Redirect } from 'expo-router';
import { useClerkUser } from '@/hooks/useClerkUser';
import { useGuestMode } from '@/lib/guestMode';

function AuthRedirect() {
  const { isSignedIn, isLoaded } = useClerkUser();
  const { isGuest, isLoaded: guestLoaded } = useGuestMode();
  if (!isLoaded || !guestLoaded) return null;
  // Guests stay in /(app) on cold start so they aren't forced through the
  // auth screen every time. The (app) layout still rejects everyone who is
  // neither signed-in nor an explicit guest. When hasClerkKey is false (no
  // Clerk publishable key in this build), useClerkUser returns
  // isSignedIn:false / isLoaded:true, so this resolves to /(app) for
  // explicit guests and /(auth) for everyone else — the auth screen then
  // renders its misconfigured-build error state.
  if (isSignedIn || isGuest) return <Redirect href="/(app)" />;
  return <Redirect href="/(auth)" />;
}

export default function Index() {
  // Previously short-circuited to /(app) when hasClerkKey was false. That
  // was the same silent-bypass class as the auth-screen bug we hit on
  // TestFlight: a misconfigured build (no EAS env vars) auto-routed every
  // visitor straight into the app with no real session. Now we always go
  // through AuthRedirect so explicit guests still pass and everyone else
  // sees the auth screen's misconfigured-build error state.
  return <AuthRedirect />;
}
