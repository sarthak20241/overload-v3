import { Redirect } from 'expo-router';
import { hasClerkKey, useClerkUser } from '@/hooks/useClerkUser';
import { useGuestMode } from '@/lib/guestMode';

function AuthRedirect() {
  const { isSignedIn, isLoaded } = useClerkUser();
  const { isGuest, isLoaded: guestLoaded } = useGuestMode();
  if (!isLoaded || !guestLoaded) return null;
  // Guests stay in /(app) on cold start so they aren't forced through the
  // auth screen every time. The (app) layout still rejects everyone who is
  // neither signed-in nor an explicit guest.
  if (isSignedIn || isGuest) return <Redirect href="/(app)" />;
  return <Redirect href="/(auth)" />;
}

export default function Index() {
  if (!hasClerkKey) {
    return <Redirect href="/(app)" />;
  }
  return <AuthRedirect />;
}
