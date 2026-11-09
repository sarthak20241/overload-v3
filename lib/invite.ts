// Invite codes: free Pro time (migrations 20261031150000_invite_codes.sql and
// 20261109120000_referral_codes.sql). Three kinds share one code box: a
// friend's referral code, a campaign code from us, and an old-app code. A
// code our server doesn't know may be a store discount code (App Store offer
// code, Play promo code); storeRedeemUrl() hands it to the store.
//
// The email link is tryoverload.app/i/CODE, whose page opens
// overload://invite?code=CODE. Someone who opens it signed out keeps the code
// here, so the invite screen can fill it in once they have an account.
import AsyncStorage from '@react-native-async-storage/async-storage';

const PENDING_KEY = 'overload.pendingInvite';

/** Codes are upper-case letters and digits; people type them any way. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

export async function savePendingInvite(code: string): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_KEY, normalizeCode(code));
  } catch {}
}

export async function readPendingInvite(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

export async function clearPendingInvite(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {}
}

export type RedeemResult =
  | { ok: true; days: number; isOwner: boolean }
  | { ok: false; reason: string };

/** redeem_invite()'s jsonb, or an RPC error, as one result. */
export function readRedeemResult(data: unknown, error: unknown): RedeemResult {
  if (error || !data || typeof data !== 'object') return { ok: false, reason: 'network' };
  const r = data as { ok?: boolean; days?: number; is_owner?: boolean; reason?: string };
  if (r.ok) return { ok: true, days: r.days ?? 30, isOwner: !!r.is_owner };
  return { ok: false, reason: r.reason ?? 'unknown' };
}

/** What Drona says when a code does not go through. */
export function redeemFailureCopy(reason: string): string {
  switch (reason) {
    case 'invalid_code':
      return "I can't find that code. Check the letters and try again.";
    case 'own_code':
      return "That's your own code. Send it to a friend: you both get a free month.";
    case 'expired':
      return 'This code has ended.';
    case 'too_many_tries':
      return 'Too many wrong codes. Try again in an hour.';
    case 'already_redeemed':
      return "You've already used a code on this account. It's one per account.";
    case 'already_pro':
      return "You're already on Pro, so you don't need this one. Pass the link to a friend.";
    case 'code_full':
      return 'This link is full. It has already given away all of its free months.';
    case 'unauthenticated':
    case 'no_profile':
      return 'Sign in first, then try the code again.';
    default:
      return "That didn't go through. Check your connection and try again.";
  }
}

/** The success line: whole months when they are whole, days otherwise. */
export function redeemSuccessCopy(days: number): string {
  const months = days / 30;
  const span = Number.isInteger(months)
    ? months === 1 ? '1 month' : `${months} months`
    : `${days} days`;
  return `You have ${span} of Pro, free. No card, and nothing renews.`;
}

/** The App Store's (numeric) id for Overload, from eas.json's ascAppId. */
export const APP_STORE_ID = '6773063775';

/**
 * Where a store discount code is redeemed, with the code filled in. Apple's
 * offer-code page and Play's redeem page both take it in the URL.
 */
export function storeRedeemUrl(code: string, os: 'ios' | 'android'): string {
  const c = encodeURIComponent(normalizeCode(code));
  return os === 'ios'
    ? `https://apps.apple.com/redeem?ctx=offercodes&id=${APP_STORE_ID}&code=${c}`
    : `https://play.google.com/redeem?code=${c}`;
}

/** The link a sharer sends. The page opens the app with the code. */
export function referralLink(code: string): string {
  return `https://tryoverload.app/i/${normalizeCode(code)}`;
}

/** The text that goes with the link in the share sheet. */
export function referralShareMessage(code: string): string {
  return `I'm training with Overload. Use my link and we both get a month of Pro free: ${referralLink(code)}`;
}

export type MyReferral =
  | { ok: true; code: string; friends: number; monthsEarned: number; paying: boolean }
  | { ok: false; reason: string };

/** get_my_referral_code()'s jsonb, or an RPC error, as one result. */
export function readMyReferral(data: unknown, error: unknown): MyReferral {
  if (error || !data || typeof data !== 'object') return { ok: false, reason: 'network' };
  const r = data as { ok?: boolean; code?: string; friends?: number; months_earned?: number; paying?: boolean; reason?: string };
  if (r.ok && r.code) {
    return { ok: true, code: r.code, friends: r.friends ?? 0, monthsEarned: r.months_earned ?? 0, paying: !!r.paying };
  }
  return { ok: false, reason: r.reason ?? 'unknown' };
}

/**
 * "3 friends have joined. You earned 3 free months." The months are the ones
 * the server really gave (none while the sharer was paying), never the friend
 * count.
 */
export function referralTally(friends: number, monthsEarned: number): string {
  if (friends === 0) return 'No friends have joined yet.';
  const who = friends === 1 ? '1 friend has joined' : `${friends} friends have joined`;
  if (monthsEarned === 0) return `${who}. Thank you.`;
  return `${who}. You earned ${monthsEarned === 1 ? '1 free month' : `${monthsEarned} free months`}.`;
}
