// App Store offer codes, from the command line (App Store Connect API).
//
//   npx tsx scripts/offer-codes/codes.mts setup
//     Makes the two offers once (safe to run again, it skips what exists):
//     - "Friend month": 1 month free on overload_monthly, custom code
//       FRIENDMONTH (the code the app's invite screen opens on iPhone).
//     - "Free year": 1 year free on overload_annual. No shared code: hand
//       out one-time codes from `make`.
//
//   npx tsx scripts/offer-codes/codes.mts make 10 [--expires 2027-01-31] [--sandbox]
//     Makes 10 one-time "Free year" codes, waits for Apple, prints them and
//     saves a CSV next to the key file. Each code works once.
//
//   npx tsx scripts/offer-codes/codes.mts list
//     The offers and their code batches.
//
// Key: App Store Connect > Users and Access > Integrations > App Store Connect
// API > Team Keys, role App Manager. Put this in ~/.config/overload/asc.env
// (never in the repo):
//   ASC_KEY_ID=XXXXXXXXXX
//   ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
//   ASC_KEY_PATH=/Users/you/.config/overload/AuthKey_XXXXXXXXXX.p8
// Environment variables with the same names win over the file.
//
// Apple limits: one-time codes are capped per app per quarter (150,000), a
// batch expires on its date (at most 6 months out for one-time codes), and a
// person can redeem one code per offer.

import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const APP_ID = '6773063775';
const API = 'https://api.appstoreconnect.apple.com';

type OfferSpec = {
  name: string;
  productId: string;
  duration: 'ONE_MONTH' | 'ONE_YEAR';
  customCode?: string;
  customCodeCount?: number;
};

export const FRIEND_MONTH: OfferSpec = {
  name: 'Friend month',
  productId: 'overload_monthly',
  duration: 'ONE_MONTH',
  customCode: 'FRIENDMONTH',
  // Apple needs a number of redemptions for a custom code. Large, so friends
  // never hit it; the server watches referrals (referral_watch()).
  customCodeCount: 25000,
};

export const FREE_YEAR: OfferSpec = {
  name: 'Free year',
  productId: 'overload_annual',
  duration: 'ONE_YEAR',
};

// ---------- auth ----------

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = join(homedir(), '.config/overload/asc.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_PATH']) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

const env = loadEnv();

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64url');
}

let cachedToken: { value: string; until: number } | null = null;

function token(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.until > now + 60) return cachedToken.value;
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH } = env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_PATH) {
    throw new Error('Missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH (see the top of this file).');
  }
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }));
  const exp = now + 15 * 60;
  const payload = b64url(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp, aud: 'appstoreconnect-v1' }));
  const key = createPrivateKey(readFileSync(ASC_KEY_PATH, 'utf8'));
  const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  cachedToken = { value: `${header}.${payload}.${b64url(sig)}`, until: exp };
  return cachedToken.value;
}

async function api(path: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<any> {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      Accept: init.accept ?? 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).errors.map((e: any) => `${e.status} ${e.code}: ${e.detail}`).join('\n');
    } catch { /* keep raw */ }
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}\n${detail}`);
  }
  if (init.accept && init.accept !== 'application/json') return text;
  return text ? JSON.parse(text) : null;
}

/** Every page of a list endpoint. */
async function all(path: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = path;
  while (next) {
    const page: any = await api(next);
    out.push(...page.data);
    next = page.links?.next ?? null;
  }
  return out;
}

// ---------- lookups ----------

async function subscription(productId: string): Promise<{ id: string; name: string }> {
  const groups = await all(`/v1/apps/${APP_ID}/subscriptionGroups?limit=50`);
  for (const g of groups) {
    const subs = await all(`/v1/subscriptionGroups/${g.id}/subscriptions?limit=50`);
    const s = subs.find((x) => x.attributes.productId === productId);
    if (s) return { id: s.id, name: s.attributes.name };
  }
  throw new Error(`No subscription with product id ${productId} on app ${APP_ID}.`);
}

async function offers(subId: string): Promise<any[]> {
  return all(`/v1/subscriptions/${subId}/offerCodes?limit=50`);
}

async function findOffer(spec: OfferSpec): Promise<{ subId: string; offer: any | null }> {
  const sub = await subscription(spec.productId);
  const list = await offers(sub.id);
  return { subId: sub.id, offer: list.find((o) => o.attributes.name === spec.name) ?? null };
}

/** Territories the subscription is sold in: a free offer needs one price row each. */
async function territories(subId: string): Promise<string[]> {
  const prices = await all(`/v1/subscriptions/${subId}/prices?include=territory&limit=200`);
  const ids = new Set<string>();
  for (const p of prices) {
    const t = p.relationships?.territory?.data?.id;
    if (t) ids.add(t);
  }
  return [...ids].sort();
}

// ---------- actions ----------

async function createOffer(spec: OfferSpec): Promise<string> {
  const found = await findOffer(spec);
  if (found.offer) {
    console.log(`= "${spec.name}" already exists (${found.offer.id}).`);
    return found.offer.id;
  }
  const terr = await territories(found.subId);
  if (!terr.length) throw new Error(`${spec.productId} has no prices yet, so Apple can't make an offer for it.`);
  const priceRows = terr.map((t, i) => ({
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
          // New and lapsed subscribers. Someone paying now gains nothing from
          // a free period on top, and Apple would stack it on their plan.
          customerEligibilities: ['NEW', 'EXPIRED'],
          offerEligibility: 'STACK_WITH_INTRO_OFFERS',
          offerMode: 'FREE_TRIAL',
          duration: spec.duration,
          numberOfPeriods: 1,
        },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: found.subId } },
          prices: { data: priceRows.map((p) => ({ type: p.type, id: p.id })) },
        },
      },
      included: priceRows,
    },
  });
  console.log(`+ "${spec.name}" made (${res.data.id}), ${spec.duration} free on ${spec.productId}, ${terr.length} countries.`);
  return res.data.id;
}

async function addCustomCode(offerId: string, spec: OfferSpec): Promise<void> {
  if (!spec.customCode) return;
  const existing = await all(`/v1/subscriptionOfferCodes/${offerId}/customCodes?limit=50`);
  if (existing.some((c) => c.attributes.customCode === spec.customCode)) {
    console.log(`= Code ${spec.customCode} already exists.`);
    return;
  }
  await api('/v1/subscriptionOfferCodeCustomCodes', {
    method: 'POST',
    body: {
      data: {
        type: 'subscriptionOfferCodeCustomCodes',
        attributes: { customCode: spec.customCode, numberOfCodes: spec.customCodeCount ?? 1000 },
        relationships: { offerCode: { data: { type: 'subscriptionOfferCodes', id: offerId } } },
      },
    },
  });
  console.log(`+ Code ${spec.customCode} made (${spec.customCodeCount} uses, no end date).`);
}

function defaultExpiry(): string {
  // Apple allows one-time codes up to 6 months out; 90 days is plenty to hand out.
  const d = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function makeOneTime(count: number, expires: string, sandbox: boolean): Promise<void> {
  const { offer } = await findOffer(FREE_YEAR);
  if (!offer) throw new Error('No "Free year" offer yet. Run `setup` first.');
  const batch = await api('/v1/subscriptionOfferCodeOneTimeUseCodes', {
    method: 'POST',
    body: {
      data: {
        type: 'subscriptionOfferCodeOneTimeUseCodes',
        attributes: {
          numberOfCodes: count,
          expirationDate: expires,
          ...(sandbox ? { environment: 'SANDBOX' } : {}),
        },
        relationships: { offerCode: { data: { type: 'subscriptionOfferCodes', id: offer.id } } },
      },
    },
  });
  const id = batch.data.id;
  process.stdout.write(`Batch ${id}: waiting for Apple to make ${count} codes`);
  // Apple builds the codes in the background; the values call fails until then.
  let csv = '';
  for (let i = 0; i < 60; i++) {
    try {
      csv = await api(`/v1/subscriptionOfferCodeOneTimeUseCodes/${id}/values`, { accept: 'text/csv' });
      if (csv.trim()) break;
    } catch { /* not ready yet */ }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  process.stdout.write('\n');
  if (!csv.trim()) {
    console.log(`Not ready after 5 minutes. Get them later in App Store Connect, or run: list`);
    return;
  }
  const codes = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/code/i.test(l));
  const dir = env.ASC_KEY_PATH ? dirname(env.ASC_KEY_PATH) : process.cwd();
  const file = join(dir, `free-year-codes-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}.csv`);
  writeFileSync(file, csv);
  console.log(`${codes.length} one-time codes, 1 year free each, valid until ${expires}${sandbox ? ' (SANDBOX)' : ''}:\n`);
  for (const c of codes) console.log(`  ${c}   https://apps.apple.com/redeem?ctx=offercodes&id=${APP_ID}&code=${c}`);
  console.log(`\nSaved: ${file}`);
}

async function list(): Promise<void> {
  for (const spec of [FRIEND_MONTH, FREE_YEAR]) {
    const { offer } = await findOffer(spec);
    if (!offer) {
      console.log(`- "${spec.name}": not made yet (run setup)`);
      continue;
    }
    const a = offer.attributes;
    console.log(`- "${spec.name}" ${offer.id}: ${a.duration} ${a.offerMode}, ${a.customerEligibilities?.join('/')}, active=${a.active}`);
    for (const c of await all(`/v1/subscriptionOfferCodes/${offer.id}/customCodes?limit=50`)) {
      console.log(`    code ${c.attributes.customCode}: ${c.attributes.numberOfCodes} uses, ends ${c.attributes.expirationDate ?? 'never'}, active=${c.attributes.active}`);
    }
    for (const b of await all(`/v1/subscriptionOfferCodes/${offer.id}/oneTimeUseCodes?limit=50`)) {
      console.log(`    batch ${b.id}: ${b.attributes.numberOfCodes} one-time codes, ends ${b.attributes.expirationDate}, made ${b.attributes.createdDate?.slice(0, 10)}, active=${b.attributes.active}`);
    }
  }
}

// ---------- main ----------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'setup') {
    const monthId = await createOffer(FRIEND_MONTH);
    await addCustomCode(monthId, FRIEND_MONTH);
    await createOffer(FREE_YEAR);
  } else if (cmd === 'make') {
    const count = Number(rest[0]);
    if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Usage: make <how many, 1-10000> [--expires YYYY-MM-DD] [--sandbox]');
    const expires = flag('--expires') ?? defaultExpiry();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new Error('--expires must be YYYY-MM-DD');
    await makeOneTime(count, expires, rest.includes('--sandbox'));
  } else if (cmd === 'list') {
    await list();
  } else {
    console.log('Usage: npx tsx scripts/offer-codes/codes.mts setup | make <count> [--expires YYYY-MM-DD] [--sandbox] | list');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
});
