import type { Channel } from './types';

export interface ChannelSpec {
  key: Channel;
  name: string;
  /** Hard limit per part (per post on X, whole post elsewhere). */
  limit: number;
  titleLimit?: number;
  /** Characters visible before "see more". */
  fold?: number;
  rules: string;
}

export const SPECS: Record<Channel, ChannelSpec> = {
  x: {
    key: 'x',
    name: 'X',
    limit: 280,
    rules: [
      'The account is on the free tier: every post is at most 280 characters. A link counts as 23.',
      'Write a single post when one idea fits. Write a thread (2 to 7 posts) only when the idea needs steps or a story.',
      'The first post must stand alone and stop the scroll. Do not start with "Thread:" or a thread emoji.',
      'No links in the first post (they cut reach). If a link helps, put it in the LAST post.',
      'At most one hashtag, usually none. No emoji walls.',
    ].join('\n'),
  },
  linkedin: {
    key: 'linkedin',
    name: 'LinkedIn',
    limit: 3000,
    fold: 210,
    rules: [
      'Posts are at most 3000 characters. Aim for 900 to 1600.',
      'Only about the first 210 characters show before "see more". The first two lines must earn the click.',
      'Short paragraphs, one to two sentences each, with blank lines between them.',
      'A personal story that turns into a lesson works best. End with a real question that invites replies.',
      'No external links in the body (they cut reach). Say "link in the first comment" if needed.',
      'Up to 3 relevant hashtags at the very end, or none.',
    ].join('\n'),
  },
  reddit: {
    key: 'reddit',
    name: 'Reddit',
    limit: 40000,
    titleLimit: 300,
    rules: [
      'Reddit punishes marketing. Write as a person sharing something useful, not a brand.',
      'The title carries the post: specific, honest, curious. No clickbait, no ALL CAPS, no emoji.',
      'Give real value in the body even to someone who never downloads the app.',
      'If the app is mentioned, say plainly that you are the solo developer. Mention it once, late, and only if the subreddit allows it.',
      'Pick the subreddit that fits the post and follow its rules. Fitness subs usually ban self-promotion: write value-only posts there.',
      'Plain text, short paragraphs, markdown lists are fine. No hashtags.',
    ].join('\n'),
  },
};

/** X counts most characters as 1, CJK and emoji as 2, and any URL as 23. */
export function xLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return '';
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    n += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return n;
}

export function partLength(channel: Channel, text: string): number {
  return channel === 'x' ? xLength(text) : [...text].length;
}
