import { Redirect } from 'expo-router';
import { hasClerkKey, useClerkUser } from '@/hooks/useClerkUser';

function AuthRedirect() {
  const { isSignedIn, isLoaded } = useClerkUser();
  if (!isLoaded) return null;
  return <Redirect href={isSignedIn ? '/(app)' : '/(auth)'} />;
}

export default function Index() {
  if (!hasClerkKey) {
    return <Redirect href="/(app)" />;
  }
  return <AuthRedirect />;
}
