/**
 * Posts to X with OAuth 1.0a user keys (your own app, your own account).
 * X bills every post from prepaid credit (pay-per-use since 2026-02):
 * about $0.015 a post, $0.20 when the post contains a link.
 */
import { createHmac, randomBytes } from 'node:crypto';

const ENDPOINT = 'https://api.x.com/2/tweets';

export function xConfigured(): boolean {
  return Boolean(process.env.X_API_KEY && process.env.X_API_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET);
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function authHeader(method: string, url: string): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: process.env.X_API_KEY!,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_ACCESS_TOKEN!,
    oauth_version: '1.0',
  };
  // A JSON body is not part of the signature; only oauth params and the query.
  const params = Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join('&');
  const base = [method.toUpperCase(), enc(url), enc(params)].join('&');
  const key = `${enc(process.env.X_API_SECRET!)}&${enc(process.env.X_ACCESS_SECRET!)}`;
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

async function createPost(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', ENDPOINT), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.data?.id) {
    const detail = json?.detail || json?.title || json?.errors?.[0]?.message || res.statusText;
    const hint =
      res.status === 401 ? ' Check the four X keys in .env.local.'
      : res.status === 402 || res.status === 403 ? ' Check that the app has "Read and write" permission (then regenerate the access token) and that your X API credit balance is above zero.'
      : res.status === 429 ? ' X rate limit hit. Try again later.'
      : '';
    throw new Error(`X said ${res.status}: ${detail}.${hint}`);
  }
  return json.data.id as string;
}

/** Posts one post or a thread. Returns the URL of the first post. */
export async function postToX(parts: string[], opts: { communityId?: string } = {}): Promise<{ url: string; ids: string[] }> {
  const ids: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const body: Record<string, unknown> = { text: parts[i] };
    if (i === 0 && opts.communityId) body.community_id = opts.communityId;
    if (i > 0) body.reply = { in_reply_to_tweet_id: ids[i - 1] };
    try {
      ids.push(await createPost(body));
    } catch (e) {
      if (i === 0) throw e;
      // Part of the thread is already live. Say exactly where it stopped.
      throw new Error(`Posts 1 to ${i} went live (https://x.com/i/web/status/${ids[0]}), but post ${i + 1} failed: ${(e as Error).message}`);
    }
  }
  return { url: `https://x.com/i/web/status/${ids[0]}`, ids };
}

/** Free fallback: opens X's composer with the first post filled in. */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/** Estimated cost in USD at pay-per-use prices. */
export function xCost(parts: string[]): number {
  return parts.reduce((sum, p) => sum + (/https?:\/\/\S+/.test(p) ? 0.2 : 0.015), 0);
}
