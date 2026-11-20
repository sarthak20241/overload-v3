/**
 * Server push, app side: saves this phone's push token for the signed-in
 * account (on mount and each return to the app, only when permission is
 * already granted: it never asks), and opens the screen a tapped Drona push
 * names. Mounted once in app/(app)/_layout.tsx, signed-in accounts only.
 * The ask itself happens after a food log (lib/pushRegistration.ts).
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { addNotificationTapListener, takeLaunchTapData } from '@/lib/notifications';
import { syncPushToken } from '@/lib/pushRegistration';
import { pushRoute } from '@/lib/pushAsk';
import { track } from '@/lib/analytics';

export function PushSync({ userId }: { userId: string }) {
  const router = useRouter();

  useEffect(() => {
    void syncPushToken();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncPushToken();
    });
    return () => sub.remove();
  }, [userId]);

  useEffect(() => {
    const open = (data: Record<string, unknown>) => {
      const route = pushRoute(data);
      if (!route) return; // a kept-sheet notice: CoachSheetHost routes those
      track('push_opened', { type: String(data.type ?? '') });
      router.push(route);
    };
    // A launch tap waits a beat: the tab navigator may still be mounting.
    let launch: ReturnType<typeof setTimeout> | undefined;
    void takeLaunchTapData((d) => pushRoute(d) !== null).then((data) => {
      if (data) launch = setTimeout(() => open(data), 400);
    });
    const unsubscribe = addNotificationTapListener(open);
    return () => { if (launch) clearTimeout(launch); unsubscribe(); };
  }, [router]);

  return null;
}
