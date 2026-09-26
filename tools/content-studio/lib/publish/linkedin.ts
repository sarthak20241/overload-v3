/**
 * Posts to your personal LinkedIn profile.
 * One-time setup: an app with "Share on LinkedIn" + "Sign In with LinkedIn
 * using OpenID Connect", then "Connect LinkedIn" in the studio. The token
 * lasts 60 days and LinkedIn gives no refresh token to small apps, so the
 * studio asks you to reconnect when it runs out.
 */
import { randomBytes } from 'node:crypto';
import { read, update } from '../store';

export const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || '202609';
const SCOPES = 'openid profile w_member_social';

interface LinkedInToken {
  accessToken: string;
  expiresAt: number;
  personUrn: string;
  name?: string;
}

interface Tokens {
  linkedin?: LinkedInToken;
  linkedinState?: string;
}

export function linkedinConfigured(): boolean {
  return Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
}

export function redirectUri(origin: string): string {
  return `${origin}/api/auth/linkedin/callback`;
}

export async function linkedinStatus(): Promise<{ connected: boolean; name?: string; expiresAt?: number }> {
  const t = (await read<Tokens>('tokens', {})).linkedin;
  if (!t || t.expiresAt < Date.now()) return { connected: false };
  return { connected: true, name: t.name, expiresAt: t.expiresAt };
}

export async function authUrl(origin: string): Promise<string> {
  const state = randomBytes(16).toString('hex');
  await update<Tokens>('tokens', {}, (cur) => ({ ...cur, linkedinState: state }));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    state,
    scope: SCOPES,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
}

export async function handleCallback(origin: string, code: string, state: string): Promise<void> {
  const saved = await read<Tokens>('tokens', {});
  if (!saved.linkedinState || saved.linkedinState !== state) throw new Error('LinkedIn login did not match. Start again from the studio.');

  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(origin),
      client_id: process.env.LINKEDIN_CLIENT_ID!,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
    }),
  });
  const tok: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token) throw new Error(`LinkedIn token error: ${tok.error_description || tokenRes.statusText}`);

  const meRes = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const me: any = await meRes.json().catch(() => ({}));
  if (!meRes.ok || !me.sub) throw new Error('Could not read your LinkedIn profile id. Is "Sign In with LinkedIn using OpenID Connect" added to the app?');

  await update<Tokens>('tokens', {}, (cur) => ({
    ...cur,
    linkedinState: undefined,
    linkedin: {
      accessToken: tok.access_token,
      expiresAt: Date.now() + (Number(tok.expires_in) || 5_184_000) * 1000,
      personUrn: `urn:li:person:${me.sub}`,
      name: me.name,
    },
  }));
}

/**
 * LinkedIn's "little text" format treats these as markup. Unescaped, a
 * bracket or a hashtag can cut the post short or mangle it.
 */
export function escapeLittle(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

export async function postToLinkedIn(text: string): Promise<{ url: string }> {
  const t = (await read<Tokens>('tokens', {})).linkedin;
  if (!t || t.expiresAt < Date.now()) throw new Error('LinkedIn is not connected, or the 60-day login ran out. Press "Connect LinkedIn" in Setup.');

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t.accessToken}`,
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      author: t.personUrn,
      commentary: escapeLittle(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (res.status !== 201) {
    const j: any = await res.json().catch(() => ({}));
    const hint = res.status === 426 || /version/i.test(j?.message ?? '') ? ' The LinkedIn-Version may be retired: set LINKEDIN_VERSION=YYYYMM in .env.local.' : '';
    throw new Error(`LinkedIn said ${res.status}: ${j?.message || res.statusText}.${hint}`);
  }
  const urn = res.headers.get('x-restli-id') ?? '';
  return { url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : 'https://www.linkedin.com/feed/' };
}
