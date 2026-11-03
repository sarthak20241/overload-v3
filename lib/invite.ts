// Invite codes: a free month of Pro (migration 20261031150000_invite_codes.sql).
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
      return "I can't find that code. Check it against your email and try again.";
    case 'already_redeemed':
      return "You've already used an invite on this account. One free month each.";
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
