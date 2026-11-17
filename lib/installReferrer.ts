/**
 * Where an Android install came from, read from Google Play's install referrer.
 *
 * Google Play keeps the `referrer=` value of the store link the person tapped
 * and hands it to the app on first open (expo-application's
 * getInstallReferrerAsync). A plain store search gives
 * `utm_source=google-play&utm_medium=organic`. A tagged link from our website
 * gives whatever UTM the website passed through (utm_source=chatgpt, ...).
 *
 * No imports, so Deno tests it directly (lib/installReferrer.test.ts).
 * lib/installSource.ts does the native call and sends it to PostHog.
 */

export type InstallReferrer = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  /** True only for Play's own "organic" tag (a store search or browse). */
  organic: boolean;
};

const MAX_LEN = 100;

function cut(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_LEN) : null;
}

export function parseInstallReferrer(raw: string): InstallReferrer {
  let text = (raw ?? '').trim();
  // Some links double-encode the referrer value; Play then returns it encoded.
  if (!text.includes('=') && text.includes('%3D')) {
    try {
      text = decodeURIComponent(text);
    } catch {
      // keep it as it is
    }
  }
  const empty: InstallReferrer = { source: null, medium: null, campaign: null, content: null, term: null, organic: false };
  if (!text.includes('=')) return empty;

  let q: URLSearchParams;
  try {
    q = new URLSearchParams(text);
  } catch {
    return empty;
  }
  let source = cut(q.get('utm_source'));
  let medium = cut(q.get('utm_medium'));
  // A Google Ads app-install click carries only a gclid.
  if (!source && q.get('gclid')) {
    source = 'google';
    medium = medium ?? 'cpc';
  }
  return {
    source,
    medium,
    campaign: cut(q.get('utm_campaign')),
    content: cut(q.get('utm_content')),
    term: cut(q.get('utm_term')),
    organic: medium === 'organic',
  };
}

/** Flat person properties for PostHog. Null fields are left out. */
export function installSourceProps(r: InstallReferrer): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (r.source) out.install_source = r.source;
  if (r.medium) out.install_medium = r.medium;
  if (r.campaign) out.install_campaign = r.campaign;
  if (r.content) out.install_content = r.content;
  if (r.term) out.install_term = r.term;
  out.install_organic = r.organic;
  return out;
}

/**
 * Retry bookkeeping for lib/installSource.ts, kept in one storage value:
 * '1' = sent, 'fail:N' = N failed reads. Play's referrer service can be
 * briefly unavailable (SERVICE_UNAVAILABLE, SERVICE_DISCONNECTED), so a
 * failure is tried again on later opens, up to MAX_REFERRER_TRIES.
 */
export const MAX_REFERRER_TRIES = 5;

function failures(stored: string | null): number {
  const m = /^fail:(\d+)$/.exec(stored ?? '');
  return m ? Number(m[1]) : 0;
}

export function shouldReadReferrer(stored: string | null): boolean {
  if (stored === '1') return false;
  return failures(stored) < MAX_REFERRER_TRIES;
}

export function afterReferrerFailure(stored: string | null): string {
  return `fail:${failures(stored) + 1}`;
}

/** Parameter names only: enough to spot a new link format, no values. */
export function referrerKeys(raw: string): string {
  try {
    return [...new Set([...new URLSearchParams((raw ?? '').trim()).keys()].filter(Boolean))].sort().join(',');
  } catch {
    return '';
  }
}
