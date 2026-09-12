/**
 * One source of truth for what a `user_profiles.tier` value means.
 *
 * The list is NOT free-form. It mirrors the CHECK constraint on
 * user_profiles.tier, verified against production:
 *
 *   free | monthly | annual | founding_lifetime | appsumo_lifetime
 *
 * `founding_annual` existed in migration 0028 and was DROPPED by 0030. Code
 * that still switches on it is dead, and code that treats founding_lifetime as
 * the only lifetime tier silently mishandles appsumo_lifetime — an AppSumo
 * buyer was being offered a "Manage or cancel in the App Store" link for a
 * purchase that never went through a store. Both bugs existed in two screens
 * before this file, which is why the logic lives here now.
 */
export type Tier =
  | 'free'
  | 'monthly'
  | 'annual'
  | 'founding_lifetime'
  | 'appsumo_lifetime';

/** Tiers bought once, with nothing to renew and nothing to cancel. */
const LIFETIME_TIERS = new Set<string>(['founding_lifetime', 'appsumo_lifetime']);

/**
 * True for a one-time purchase. Such a tier never appears under the store's
 * subscription management, so the UI must not offer to manage or cancel it.
 */
export function isLifetimeTier(tier: string | null | undefined): boolean {
  return !!tier && LIFETIME_TIERS.has(tier);
}

/** Tiers bought through the App Store or Play, so the store can manage them. */
const STORE_TIERS = new Set<string>(['monthly', 'annual', 'founding_lifetime']);

/**
 * True when the store is the right place to send someone. AppSumo lifetime is
 * deliberately excluded: it was redeemed with a code, so neither store has any
 * record of it.
 */
export function isStorePurchase(tier: string | null | undefined): boolean {
  return !!tier && STORE_TIERS.has(tier);
}

/** Human label for a tier. Falls back to "Active" for anything unrecognized. */
export function tierLabel(tier: string | null | undefined): string {
  switch (tier) {
    case 'monthly': return 'Monthly';
    case 'annual': return 'Annual';
    case 'founding_lifetime': return 'Founding Lifetime';
    case 'appsumo_lifetime': return 'AppSumo Lifetime';
    default: return 'Active';
  }
}

/**
 * What Pro gives you, shared by the profile card and the plan page so the two
 * cannot drift.
 *
 * Deliberately shorter and blunter than the paywall's comparison table
 * (app/upgrade.tsx COMPARE_CORE): that table sells by contrast against a free
 * column and needs four rows to do it, while these two surfaces are read by
 * someone who has already paid and only wants confirmation. Nothing enforces
 * parity with the paywall, so if the offer changes, both need editing.
 */
export const PLAN_BENEFITS = [
  'Unlimited coach chat',
  'Unlimited AI food logs',
  'Personalized plans, rewritten every week',
];
