/**
 * Dashboard reminder after "Do it later" on the paywall's success screen:
 * one quiet-glass row that opens the ChatGPT / Claude setup. It hides itself
 * once they open their AI from that screen, or for good with its X
 * (lib/connectNudge.ts). Re-reads on focus, so it is gone when they come back.
 */
import { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { FontFamily } from '@/constants/theme';
import { useGlass } from '@/components/paywall/PaywallParts';
import { showConnectNudge } from '@/lib/aiConnect';
import { readConnectNudge, setConnectNudge, type ConnectNudge } from '@/lib/connectNudge';
import { track } from '@/lib/analytics';

export function ConnectNudgeCard({
  userId,
  hasConnector,
  containerStyle,
}: {
  userId: string;
  hasConnector: boolean;
  containerStyle?: ViewStyle;
}) {
  const g = useGlass();
  const router = useRouter();
  const [state, setState] = useState<ConnectNudge | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void readConnectNudge(userId).then((v) => { if (live) setState(v); });
      return () => { live = false; };
    }, [userId]),
  );

  if (!showConnectNudge(state, hasConnector)) return null;

  return (
    <View style={containerStyle}>
      <View style={[s.card, { backgroundColor: g.quietFill, borderColor: g.quietEdge, borderTopColor: g.quietTop }]}>
        <TouchableOpacity
          style={s.main}
          activeOpacity={0.7}
          onPress={() => { track('connect_nudge_tapped'); router.push('/connect-ai' as any); }}
          accessibilityRole="button"
          accessibilityLabel="Connect ChatGPT or Claude. Takes 2 minutes."
        >
          <View style={[s.icon, { backgroundColor: g.selectedPill }]}>
            <Feather name="link" size={14} color={g.C.foreground} />
          </View>
          <View style={s.text}>
            <Text style={[s.title, { color: g.C.foreground }]}>Connect ChatGPT or Claude</Text>
            <Text style={[s.sub, { color: g.C.textSecondary }]}>Log and ask from your own AI. 2 minutes.</Text>
          </View>
          <Feather name="chevron-right" size={16} color={g.C.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { track('connect_nudge_dismissed'); setState('dismissed'); void setConnectNudge(userId, 'dismissed'); }}
          style={s.close}
          accessibilityRole="button"
          accessibilityLabel="Hide this reminder"
        >
          <Feather name="x" size={14} color={g.C.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, borderWidth: 1, paddingLeft: 14 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10 },
  icon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  title: { fontSize: 15, fontFamily: FontFamily.onboardingHeading },
  sub: { fontSize: 13, lineHeight: 18, marginTop: 2, fontFamily: FontFamily.onboardingBody },
  close: { width: 44, height: 64, alignItems: 'center', justifyContent: 'center' },
});
