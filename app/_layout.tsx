import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { ClerkProvider } from '@clerk/clerk-expo';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WorkoutProvider } from '@/hooks/useWorkout';
import { ThemeProvider, useTheme } from '@/hooks/useTheme';
import { BasicInfoProvider } from '@/hooks/useBasicInfo';
import { PreferencesProvider } from '@/hooks/usePreferences';
import { hydrateGuestStore } from '@/lib/guestStore';
import { hydrateActiveWorkout } from '@/lib/activeWorkoutPersistence';
import { ClerkSupabaseBridge } from '@/components/ClerkSupabaseBridge';
import { RevenueCatBridge } from '@/components/RevenueCatBridge';
import { SyncProvider } from '@/components/SyncProvider';
import { ToastProvider } from '@/components/ui/Toast';
import { AnalyticsBridge } from '@/components/AnalyticsBridge';
import { posthog } from '@/lib/analytics';
import { PortalProvider } from '@/components/ui/Portal';
import { PostHogProvider } from 'posthog-react-native';

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
        <PreferencesProvider>
        <WorkoutProvider>
          {/*
            SyncProvider owns the background flush loop for the offline workout
            queue; it sits below Clerk/Workout so screens and the OfflineBanner
            can read sync state.

            PortalProvider sits inside every context provider our overlays need
            (Theme, Workout, Toast, SafeArea, Clerk) but wraps the navigator, so
            portalled sheets render ON TOP of the tabs in the app's own window —
            flush to the bottom on Android, unlike a separate-window <Modal>.
          */}
          <SyncProvider>
            <PortalProvider>
              <AnalyticsBridge />
              <StatusBar style={C.statusBar} />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen name="(app)" options={{ headerShown: false }} />
                <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                <Stack.Screen name="onboarding" options={{ headerShown: false, animation: 'fade' }} />
                <Stack.Screen name="upgrade" options={{ headerShown: false, animation: 'fade' }} />
                <Stack.Screen name="sso-callback" options={{ headerShown: false }} />
                <Stack.Screen name="workout/[id]" options={{ headerShown: false, presentation: 'card', animation: 'slide_from_right' }} />
                <Stack.Screen name="workout/edit/[id]" options={{ headerShown: false, presentation: 'card', animation: 'slide_from_right' }} />
              </Stack>
            </PortalProvider>
          </SyncProvider>
        </WorkoutProvider>
        </PreferencesProvider>
      </BasicInfoProvider>
    </ToastProvider>
  );
}

function AppContent() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // Hydrate local stores before rendering: the guest store (data routing) and
    // the active-workout snapshot (so a crashed/killed session can be resumed on
    // first paint).
    Promise.all([hydrateGuestStore(), hydrateActiveWorkout()]).finally(() => setHydrated(true));
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
  // Display face (Space Grotesk) for questions/headlines/big numbers; body/UI
  // stays on the system font. Non-blocking: screens render with the system
  // font for the instant before the load resolves, then re-render.
  useFonts({ SpaceGrotesk_500Medium, SpaceGrotesk_700Bold });

  const tree = !publishableKey ? (
    <AppContent />
  ) : (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ClerkSupabaseBridge />
      <RevenueCatBridge />
      <AppContent />
    </ClerkProvider>
  );

  // No PostHog key configured (local dev, CI) -> no provider, no network, no
  // session replay. `track()` is already a no-op in that case, so screens need
  // no guards of their own.
  //
  // captureScreens is false because expo-router hides the NavigationContainer
  // PostHog's tracker needs; AnalyticsBridge reports screens instead.
  // captureTouches is false on purpose: raw tap autocapture on a set-logging
  // screen is mostly noise, and session replay already shows the taps.
  if (!posthog) return tree;

  return (
    <PostHogProvider
      client={posthog}
      autocapture={{ captureScreens: false, captureTouches: false }}
    >
      {tree}
    </PostHogProvider>
  );
}
