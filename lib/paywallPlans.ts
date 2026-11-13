/**
 * What the two-sided paywall shows, as plain rules (app/upgrade.tsx renders
 * them). Plan: .planning/connect-plan-paywall.md section 3.
 *
 *   Drona coach   Pro: Drona in the app, plus everything Connect has.
 *   Your own AI   Connect: the tracker plus ChatGPT / Claude through the
 *                 connector, no Drona.
 *
 * Kept pure so the words and the plan order are unit-tested
 * (lib/paywallPlans.test.ts) and the screen holds no copy logic.
 */
/** The PlanKey values (lib/revenuecat.ts) the paywall sells. Spelled out
 *  here so this file has no import and its test type-checks alone. */
export type PaywallPlan = 'annual' | 'monthly' | 'connect_annual' | 'connect_monthly' | 'connect_lifetime';

export type PaywallSide = 'drona' | 'own_ai';
export type PaywallPeriod = 'annual' | 'monthly' | 'lifetime';
/** The A/B test (PostHog flag `paywall-layout`): A = tiles, B = icon list. */
export type PaywallLayout = 'tiles' | 'list';

export const PAYWALL_LAYOUT_FLAG = 'paywall-layout';

export function layoutFromFlag(variant: string | null | undefined): PaywallLayout {
  return variant === 'list' ? 'list' : 'tiles';
}

/** Periods a side sells, in display order. Lifetime is Connect only. */
export const SIDE_PERIODS: Record<PaywallSide, readonly PaywallPeriod[]> = {
  drona: ['annual', 'monthly'],
  own_ai: ['annual', 'monthly', 'lifetime'],
};

export function planFor(side: PaywallSide, period: PaywallPeriod): PaywallPlan | null {
  if (side === 'drona') {
    if (period === 'annual') return 'annual';
    if (period === 'monthly') return 'monthly';
    return null;
  }
  if (period === 'annual') return 'connect_annual';
  if (period === 'monthly') return 'connect_monthly';
  return 'connect_lifetime';
}

export const PERIOD_LABEL: Record<PaywallPeriod, string> = {
  annual: 'Yearly',
  monthly: 'Monthly',
  lifetime: 'Lifetime',
};

export const SIDE_LABEL: Record<PaywallSide, string> = {
  drona: 'Drona coach',
  own_ai: 'Your own AI',
};

export const SIDE_TITLE: Record<PaywallSide, string> = {
  drona: 'A coach for your food and workouts',
  own_ai: 'Your food and workouts, in your own AI',
};

export const SIDE_SUB: Record<PaywallSide, string> = {
  drona: 'The coach inside the app',
  own_ai: 'Log and analyze in ChatGPT, Claude, and more',
};

export type FeatureIcon =
  | 'mic'
  | 'message-circle'
  | 'refresh-cw'
  | 'bar-chart-2'
  | 'activity'
  | 'link'
  | 'trending-up';

export interface Feature {
  icon: FeatureIcon;
  label: string;
  /** Included on this side. A locked feature shows a lock. */
  included: boolean;
}

/** Six features per side, the included ones first. Feather icon names. */
export function sideFeatures(side: PaywallSide): Feature[] {
  if (side === 'drona') {
    return [
      { icon: 'mic', label: 'Say a meal, it is logged', included: true },
      { icon: 'message-circle', label: 'Ask your coach', included: true },
      { icon: 'refresh-cw', label: 'A plan that adapts to you', included: true },
      { icon: 'bar-chart-2', label: 'Weekly insights', included: true },
      { icon: 'activity', label: 'Food and workout tracker', included: true },
      { icon: 'link', label: 'Log in ChatGPT, Claude, more', included: true },
    ];
  }
  return [
    { icon: 'activity', label: 'Food and workout tracker', included: true },
    { icon: 'link', label: 'Log in ChatGPT, Claude, more', included: true },
    { icon: 'trending-up', label: 'Charts and history', included: true },
    { icon: 'message-circle', label: 'Coach in the app', included: false },
    { icon: 'refresh-cw', label: 'A plan that adapts to you', included: false },
    { icon: 'bar-chart-2', label: 'Weekly insights', included: false },
  ];
}

/**
 * The button. A trial is claimed only when the store says this product has
 * one for this buyer (`trialDays` from freeTrialDays), never from the plan
 * name, so a returning buyer is never promised a free week they won't get.
 */
export function ctaLabel(side: PaywallSide, period: PaywallPeriod, trialDays: number): string {
  if (period === 'lifetime') return 'Buy once';
  if (trialDays > 0) return side === 'drona' ? `Try Drona free for ${trialDays} days` : `Try free for ${trialDays} days`;
  return 'Continue';
}

/** The one line under the button. `price` is the store's localized string. */
export function priceLine(period: PaywallPeriod, price: string, trialDays: number): string {
  if (period === 'lifetime') return `${price} one time. Yours forever.`;
  const unit = period === 'annual' ? 'a year' : 'a month';
  return trialDays > 0 ? `Then ${price} ${unit}. Cancel any time.` : `${price} ${unit}. Cancel any time.`;
}

/**
 * The side the paywall opens on. A Connect buyer who reaches it (from a
 * locked Drona feature) is shown Drona; so is everyone else, Drona being the
 * default sell. `own_ai` only when asked for (the connector setup screen).
 */
export function initialSide(context: string | null | undefined): PaywallSide {
  return context === 'connect' ? 'own_ai' : 'drona';
}

/**
 * Has the access answer (get_coach_access_status) turned on what a purchase
 * bought? A Connect purchase never makes the state 'paid' (no Drona): it lands
 * as `connect: true`, which the server sets whether or not the buyer also has
 * Pro. 'either' is for Restore only, which carries no plan.
 */
export function accessHasPlan(
  row: { state?: string; connect?: boolean } | null | undefined,
  want: 'pro' | 'connect' | 'either',
): boolean {
  const pro = row?.state === 'paid' || row?.state === 'trialing';
  const connect = row?.connect === true;
  return want === 'pro' ? pro : want === 'connect' ? connect : pro || connect;
}
