import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { ClerkProvider } from '@clerk/clerk-expo';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WorkoutProvider } from '@/hooks/useWorkout';
import { ThemeProvider, useTheme } from '@/hooks/useTheme';
import { hydrateGuestStore } from '@/lib/mockData';
import { ClerkSupabaseBridge } from '@/components/ClerkSupabaseBridge';

// Required for OAuth flows to complete when the auth session returns.
// Must run at app boot, before any auth screen mounts.
WebBrowser.maybeCompleteAuthSession();

const tokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {}
  },
};

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

function AppInner() {
  const { C } = useTheme();
  return (
    <WorkoutProvider>
      <StatusBar style={C.statusBar} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="sso-callback" options={{ headerShown: false }} />
        <Stack.Screen name="workout/[id]" options={{ headerShown: false, presentation: 'card', animation: 'slide_from_right' }} />
      </Stack>
    </WorkoutProvider>
  );
}

function AppContent() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    hydrateGuestStore().finally(() => setHydrated(true));
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          {hydrated ? <AppInner /> : null}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  if (!publishableKey) {
    return <AppContent />;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ClerkSupabaseBridge />
      <AppContent />
    </ClerkProvider>
  );
}
