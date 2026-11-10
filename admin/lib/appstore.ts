/**
 * App Store Connect API, server side only: offers, one-time code batches and
 * named codes for the Coupons page.
 *
 * Key: App Store Connect > Users and Access > Integrations > Team Keys, role
 * App Manager. A key just for this site, so it can be revoked without
 * touching RevenueCat's key. Env (Vercel + admin/.env.local):
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY (the .p8 text; "\n" allowed)
 *
 * Apple's limits, checked against the live API on 2026-11-10:
 *   - one-time codes come in batches of 500 to 25,000, each batch ending on a
 *     date at most 6 months out;
 *   - a named code needs 500+ uses (1, 2, 10, 100 are refused);
 *   - a person can redeem one code per offer.
 */
import 'server-only';
import { createPrivateKey, sign } from 'node:crypto';

export const APP_ID = '6773063775';
const API = 'https://api.appstoreconnect.apple.com';

export const PERIODS = [
  'THREE_DAYS', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH',
  'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR',
] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABEL: Record<Period, string> = {
  THREE_DAYS: '3 days',
  ONE_WEEK: '1 week',
  TWO_WEEKS: '2 weeks',
  ONE_MONTH: '1 month',
  TWO_MONTHS: '2 months',
  THREE_MONTHS: '3 months',
  SIX_MONTHS: '6 months',
  ONE_YEAR: '1 year',
};

/**
 * Which offer each period uses. 1 year is the existing "Free year" offer on
 * the annual plan (codes.mts made it). Shorter periods sit on the monthly
 * plan, so after the free time a person pays monthly, not a full year.
 * "Friend month" (FRIENDMONTH) stays the referral offer: a gift month is its
 * own offer, so a friend who used FRIENDMONTH can still redeem a gift code.
 */
export function offerFor(period: Period): { name: string; productId: string } {
  if (period === 'ONE_YEAR') return { name: 'Free year', productId: 'overload_annual' };
  return { name: `Free ${PERIOD_LABEL[period]}`, productId: 'overload_monthly' };
}

export const BATCH_SIZE = 500; // Apple's smallest one-time batch
export const NAMED_USES = 500; // Apple's smallest named code
export const BATCH_DAYS = 150; // Apple allows up to 6 months

export function redeemUrl(code: string): string {
  return `https://apps.apple.com/redeem?ctx=offercodes&id=${APP_ID}&code=${encodeURIComponent(code)}`;
}

// ---------- auth ----------

let cached: { value: string; until: number } | null = null;

function token(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.until > now + 60) return cached.value;
  const keyId = process.env.ASC_KEY_ID;
  const issuer = process.env.ASC_ISSUER_ID;
  const pem = process.env.ASC_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!keyId || !issuer || !pem) {
    throw new Error('App Store key not set: add ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY to the admin site env.');
  }
  const b64 = (s: Buffer | string) => Buffer.from(s).toString('base64url');
  const exp = now + 15 * 60;
  const head = b64(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: issuer, iat: now, exp, aud: 'appstoreconnect-v1' }));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(pem),
    dsaEncoding: 'ieee-p1363',
  });
  cached = { value: `${head}.${body}.${b64(sig)}`, until: exp };
  return cached.value;
}

export function hasKey(): boolean {
  return !!(process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function api(path: string, init: { method?: string; body?: unknown; csv?: boolean } = {}): Promise<Json> {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      Accept: init.csv ? 'text/csv' : 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).errors.map((e: Json) => e.detail ?? e.title).join(' ');
    } catch { /* keep raw */ }
    throw new Error(`Apple said ${res.status}: ${detail}`);
  }
  if (init.csv) return text;
  return text ? JSON.parse(text) : null;
}

async function all(path: string): Promise<Json[]> {
  const out: Json[] = [];
  let next: string | null = path;
  while (next) {
    const page: Json = await api(next);
    out.push(...page.data);
    next = page.links?.next ?? null;
  }
  return out;
}

// ---------- offers ----------

async function subscriptionId(productId: string): Promise<string> {
  for (const g of await all(`/v1/apps/${APP_ID}/subscriptionGroups?limit=50`)) {
    const subs = await all(`/v1/subscriptionGroups/${g.id}/subscriptions?limit=50`);
    const s = subs.find((x) => x.attributes.productId === productId);
    if (s) return s.id;
  }
  throw new Error(`No subscription ${productId} on the app.`);
}

/** The offer for a period; made the first time it is needed. */
export async function ensureOffer(period: Period): Promise<string> {
  const spec = offerFor(period);
  const subId = await subscriptionId(spec.productId);
  const existing = (await all(`/v1/subscriptions/${subId}/offerCodes?limit=50`))
    .find((o) => o.attributes.name === spec.name);
  if (existing) return existing.id;

  // A free offer needs one price row per country the plan is sold in.
  const prices = await all(`/v1/subscriptions/${subId}/prices?include=territory&limit=200`);
  const territories = [...new Set(prices.map((p) => p.relationships?.territory?.data?.id).filter(Boolean))] as string[];
  if (!territories.length) throw new Error(`${spec.productId} has no prices, so Apple can't make an offer.`);
  const rows = territories.map((t, i) => ({
    type: 'subscriptionOfferCodePrices',
    id: `\${price-${i}}`,
    relationships: { territory: { data: { type: 'territories', id: t } } },
  }));
  const res = await api('/v1/subscriptionOfferCodes', {
    method: 'POST',
    body: {
      data: {
        type: 'subscriptionOfferCodes',
        attributes: {
          name: spec.name,
          // New and lapsed subscribers: someone paying now gains nothing.
          customerEligibilities: ['NEW', 'EXPIRED'],
          offerEligibility: 'STACK_WITH_INTRO_OFFERS',
          offerMode: 'FREE_TRIAL',
          duration: period,
          numberOfPeriods: 1,
        },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: subId } },
          prices: { data: rows.map((r) => ({ type: r.type, id: r.id })) },
        },
      },
      included: rows,
    },
  });
  return res.data.id;
}

// ---------- codes ----------

/** Ask Apple for a batch of one-time codes. Apple builds them in the background. */
export async function requestBatch(offerId: string, count: number, expires: string, sandbox: boolean): Promise<string> {
  const res = await api('/v1/subscriptionOfferCodeOneTimeUseCodes', {
    method: 'POST',
    body: {
      data: {
        type: 'subscriptionOfferCodeOneTimeUseCodes',
        attributes: {
          numberOfCodes: count,
          expirationDate: expires,
          ...(sandbox ? { environment: 'SANDBOX' } : {}),
        },
        relationships: { offerCode: { data: { type: 'subscriptionOfferCodes', id: offerId } } },
      },
    },
  });
  return res.data.id;
}

/** The codes of a batch, or null while Apple is still making them. */
export async function batchCodes(batchId: string): Promise<string[] | null> {
  try {
    const csv: string = await api(`/v1/subscriptionOfferCodeOneTimeUseCodes/${batchId}/values`, { csv: true });
    const codes = csv.split(/\r?\n/).map((l) => l.split(',')[0].trim()).filter((c) => /^[A-Z0-9]{6,}$/.test(c));
    return codes.length ? codes : null;
  } catch {
    return null;
  }
}

/** Batches Apple has for an offer (to pick up ones the database never saved). */
export async function listBatches(offerId: string): Promise<{ id: string; count: number; expires: string; active: boolean; sandbox: boolean }[]> {
  return (await all(`/v1/subscriptionOfferCodes/${offerId}/oneTimeUseCodes?limit=50`)).map((b) => ({
    id: b.id,
    count: b.attributes.numberOfCodes,
    expires: b.attributes.expirationDate,
    active: b.attributes.active !== false,
    sandbox: b.attributes.environment === 'SANDBOX',
  }));
}

/** A named code (like RAHUL). Apple needs 500+ uses. */
export async function createNamedCode(offerId: string, code: string, expires: string | null): Promise<string> {
  const res = await api('/v1/subscriptionOfferCodeCustomCodes', {
    method: 'POST',
    body: {
      data: {
        type: 'subscriptionOfferCodeCustomCodes',
        attributes: {
          customCode: code,
          numberOfCodes: NAMED_USES,
          ...(expires ? { expirationDate: expires } : {}),
        },
        relationships: { offerCode: { data: { type: 'subscriptionOfferCodes', id: offerId } } },
      },
    },
  });
  return res.data.id;
}

/** Turn a named code off at Apple (it stops working at once). */
export async function deactivateNamedCode(id: string): Promise<void> {
  await api(`/v1/subscriptionOfferCodeCustomCodes/${id}`, {
    method: 'PATCH',
    body: { data: { type: 'subscriptionOfferCodeCustomCodes', id, attributes: { active: false } } },
  });
}
