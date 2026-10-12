import { partLength, SPECS } from './channels';
import { hasDashes } from './lint';
import type { Draft } from './types';

/** Why a draft can't go out yet, or null. Shared by Post now and Ready. */
export function postBlocker(d: Pick<Draft, 'channel' | 'parts'>): string | null {
  const spec = SPECS[d.channel];
  const tooLong = d.parts.findIndex((p) => partLength(d.channel, p) > spec.limit);
  if (tooLong >= 0) return `Part ${tooLong + 1} is over the ${spec.limit} character limit.`;
  if (d.parts.some((p) => /\[[^\]]+\](?!\()/.test(p))) return 'The draft still has a [placeholder]. Fill it in first.';
  if (d.parts.some(hasDashes)) return 'The draft has an em dash. Remove it first.';
  if (!d.parts.some((p) => p.trim())) return 'The draft is empty.';
  return null;
}
