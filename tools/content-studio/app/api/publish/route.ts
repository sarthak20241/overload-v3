import { NextResponse } from 'next/server';
import { partLength, SPECS } from '@/lib/channels';
import { hasDashes } from '@/lib/lint';
import { postToLinkedIn } from '@/lib/publish/linkedin';
import { PartialThreadError, postToX } from '@/lib/publish/x';
import { read, update } from '@/lib/store';
import type { Draft } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * action "post": sends the draft to X or LinkedIn right now.
 * action "mark": records a post you made by hand (Reddit, or the free X link).
 * The browser only calls "post" after you confirm the exact text.
 */
/** Drafts being posted right now. A double click or a second tab must not post twice. */
const inFlight: Set<string> = ((globalThis as any).__studioPublishing ??= new Set());

async function markPosted(draftId: string, postedUrl: string | undefined, note?: string): Promise<Draft | undefined> {
  const now = new Date().toISOString();
  let saved: Draft | undefined;
  await update<Draft[]>('drafts', [], (cur) =>
    cur.map((d) => (d.id === draftId ? (saved = { ...d, status: 'posted', postedUrl, postedAt: now, updatedAt: now, ...(note ? { rationale: `${note}\n\n${d.rationale}` } : {}) }) : d)),
  );
  return saved;
}

export async function POST(req: Request) {
  const { draftId, action, url, community } = (await req.json()) as {
    draftId: string;
    action: 'post' | 'mark';
    url?: string;
    community?: boolean;
  };
  const draft = (await read<Draft[]>('drafts', [])).find((d) => d.id === draftId);
  if (!draft) return NextResponse.json({ error: 'Draft not found.' }, { status: 404 });
  if (draft.status === 'posted') {
    return NextResponse.json({ error: 'This draft is already posted.' }, { status: 409 });
  }

  let postedUrl = url?.trim() || undefined;
  if (action === 'post') {
    const spec = SPECS[draft.channel];
    const tooLong = draft.parts.findIndex((p) => partLength(draft.channel, p) > spec.limit);
    if (tooLong >= 0) return NextResponse.json({ error: `Part ${tooLong + 1} is over the ${spec.limit} character limit.` }, { status: 400 });
    if (draft.parts.some((p) => /\[[^\]]+\](?!\()/.test(p))) {
      return NextResponse.json({ error: 'The draft still has a [placeholder]. Fill it in first.' }, { status: 400 });
    }
    if (draft.parts.some(hasDashes)) return NextResponse.json({ error: 'The draft has an em dash. Remove it first.' }, { status: 400 });

    if (inFlight.has(draftId)) return NextResponse.json({ error: 'This draft is already being posted.' }, { status: 409 });
    inFlight.add(draftId);
    try {
      if (draft.channel === 'x') {
        const communityId = community ? process.env.X_COMMUNITY_ID : undefined;
        postedUrl = (await postToX(draft.parts, { communityId })).url;
      } else if (draft.channel === 'linkedin') {
        postedUrl = (await postToLinkedIn(draft.parts.join('\n\n'))).url;
      } else {
        return NextResponse.json({ error: 'Reddit posts are opened in your browser, not posted from here.' }, { status: 400 });
      }
    } catch (e) {
      // Some of the thread is public already. Record it as posted so a retry
      // cannot publish (and pay for) those posts a second time.
      if (e instanceof PartialThreadError) {
        await markPosted(draftId, e.url, `Only the first ${e.posted} post(s) of this thread went live. Finish it by replying on X.`);
      }
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    } finally {
      inFlight.delete(draftId);
    }
  }

  return NextResponse.json(await markPosted(draftId, postedUrl));
}
