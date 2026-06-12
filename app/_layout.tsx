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
import { BasicInfoProvider } from '@/hooks/useBasicInfo';
import { hydrateGuestStore } from '@/lib/guestStore';
import { ClerkSupabaseBridge } from '@/components/ClerkSupabaseBridge';
import { RevenueCatBridge } from '@/components/RevenueCatBridge';
import { ToastProvider } from '@/components/ui/Toast';
import { PortalProvider } from '@/components/ui/Portal';

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
    <ToastProvider>
      <BasicInfoProvider>
        <WorkoutProvider>
          {/*
            PortalProvider sits inside every context provider our overlays need
            (Theme, Workout, Toast, SafeArea, Clerk) but wraps the navigator, so
            portalled sheets render ON TOP of the tabs in the app's own window —
            flush to the bottom on Android, unlike a separate-window <Modal>.
          */}
          <PortalProvider>
            <StatusBar style={C.statusBar} />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="(app)" options={{ headerShown: false }} />
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="sso-callback" options={{ headerShown: false }} />
              <Stack.Screen name="workout/[id]" options={{ headerShown: false, presentation: 'card', animation: 'slide_from_right' }} />
            </Stack>
          </PortalProvider>
        </WorkoutProvider>
      </BasicInfoProvider>
    </ToastProvider>
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
      <RevenueCatBridge />
      <AppContent />
    </ClerkProvider>
  );
}
