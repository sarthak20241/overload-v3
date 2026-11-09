// Refer a friend: your own code and link, one Share button, and how many
// friends have joined (migration 20261109120000_referral_codes.sql).
//
// A friend who uses the link gets a month of Pro free, and so does the
// sharer, with no limit. A sharer who pays through a store earns nothing (a
// store plan can't be extended from our server), so they are not promised it.
import { useCallback, useEffect, useState } from 'react';
import { Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import {
  Colors,
  FontFamily,
  FontSize,
  FontWeight,
  IconSize,
  LetterSpacing,
  Radius,
  Shadow,
  Spacing,
} from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useSupabaseClient } from '@/lib/supabase';
import { PressableScale } from '@/components/ui/PressableScale';
import { OrbLoader } from '@/components/ui/OrbLoader';
import { track } from '@/lib/analytics';
import {
  readMyReferral,
  referralLoadError,
  referralShareMessage,
  referralTally,
  type MyReferral,
} from '@/lib/invite';

export default function ReferScreen() {
  const { C } = useTheme();
  const router = useRouter();
  const supabase = useSupabaseClient();
  const [mine, setMine] = useState<MyReferral | null>(null);

  const load = useCallback(async () => {
    setMine(null);
    try {
      const { data, error } = await supabase.rpc('get_my_referral_code');
      setMine(readMyReferral(data, error));
    } catch (e) {
      setMine(readMyReferral(null, e));
    }
  }, [supabase]);

  useEffect(() => {
    track('referral_opened');
    void load();
  }, [load]);

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/(app)'));

  const share = async () => {
    if (!mine?.ok) return;
    try {
      // The link is inside the message. Passing `url` too shows it twice on iOS.
      const r = await Share.share({ message: referralShareMessage(mine.code, mine.paying) });
      track('referral_shared', { action: r.action, friends: mine.friends });
    } catch {
      /* the sheet closed or failed; nothing to do */
    }
  };

  // Until the code loads we don't know if they pay: neutral words, no flash
  // of a promise a payer won't get.
  const loaded = !!mine?.ok;
  const paying = mine?.ok ? mine.paying : false;

  return (
    <SafeAreaView style={[s.root, { backgroundColor: C.background }]} edges={['top', 'bottom']}>
      <View style={s.topBar}>
        <TouchableOpacity
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={[s.closeBtn, { backgroundColor: C.card }]}
        >
          <Feather name="x" size={IconSize.md} color={C.textMuted} />
        </TouchableOpacity>
      </View>

      <View style={s.body}>
        <View style={s.main}>
          <Text style={[s.eyebrow, { color: C.accentText }]}>INVITE FRIENDS</Text>
          <Text style={[s.title, { color: C.foreground }]}>
            {!loaded ? 'Invite friends.' : paying ? 'Give a friend a free month.' : 'Give a month, get a month.'}
          </Text>
          <Text style={[s.sub, { color: C.textSecondary }]}>
            {!loaded
              ? 'Send your link to a friend. They get a month of Pro free.'
              : paying
              ? 'Send your link. Your friend gets a month of Pro free. No card needed.'
              : 'Send your link. When a friend joins with it, you both get a month of Pro free. No card needed, and no limit on friends.'}
          </Text>

          {mine === null ? (
            <View style={s.codeWrap}>
              <OrbLoader size="small" color={C.textMuted} />
            </View>
          ) : mine.ok ? (
            <>
              <View style={[s.codeBox, { backgroundColor: C.card, borderColor: C.borderSubtle }]}>
                <Text style={[s.codeLabel, { color: C.textMuted }]}>YOUR CODE</Text>
                <Text selectable style={[s.code, { color: C.foreground }]}>{mine.code}</Text>
              </View>
              <Text style={[s.tally, { color: C.textMuted }]}>{referralTally(mine.friends, mine.monthsEarned)}</Text>
            </>
          ) : (
            <View style={s.codeWrap}>
              <Text style={[s.tally, { color: C.textMuted }]}>
                {referralLoadError(mine.reason)}
              </Text>
              {mine.reason === 'network' && (
                <TouchableOpacity onPress={load} accessibilityRole="button" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={[s.link, { color: C.accentText }]}>Try again</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        <View style={s.footer}>
          <PressableScale
            onPress={share}
            disabled={!mine?.ok}
            style={[s.cta, Shadow.playBtn, !mine?.ok && { opacity: 0.5 }]}
            accessibilityRole="button"
            accessibilityLabel="Share my link"
          >
            <Text style={s.ctaText}>Share my link</Text>
          </PressableScale>
          <TouchableOpacity
            onPress={() => router.push('/invite' as any)}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={s.codeLink}
          >
            <Text style={[s.link, { color: C.textMuted }]}>Got a code from someone? Enter it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, paddingHorizontal: Spacing.xl },
  main: { flex: 1, justifyContent: 'center' },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    letterSpacing: LetterSpacing.eyebrow,
    marginBottom: Spacing.sm,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: 32,
    letterSpacing: LetterSpacing.tight,
    lineHeight: 38,
  },
  sub: { fontSize: FontSize.base, lineHeight: 21, marginTop: Spacing.md },
  codeWrap: { marginTop: Spacing.xxl, alignItems: 'center', gap: Spacing.sm },
  codeBox: {
    marginTop: Spacing.xxl,
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  codeLabel: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, letterSpacing: LetterSpacing.eyebrow },
  code: { fontSize: 28, fontWeight: FontWeight.bold, letterSpacing: 4, marginTop: Spacing.xs },
  tally: { fontSize: FontSize.sm, lineHeight: 18, marginTop: Spacing.md, textAlign: 'center' },
  link: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, textAlign: 'center' },
  footer: { paddingBottom: Spacing.lg },
  cta: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    height: 56,
    borderRadius: Radius.full,
  },
  ctaText: { fontSize: 17, fontWeight: FontWeight.bold, color: Colors.primaryFg },
  codeLink: { marginTop: Spacing.md, alignItems: 'center' },
});
