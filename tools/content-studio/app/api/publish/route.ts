import { NextResponse } from 'next/server';
import { postBlocker } from '@/lib/checks';
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
    const blocker = postBlocker(draft);
    if (blocker) return NextResponse.json({ error: blocker }, { status: 400 });

    if (inFlight.has(draftId)) return NextResponse.json({ error: 'This draft is already being posted.' }, { status: 409 });
    // Take the claim under the store lock, the same lock x-next uses, so the
    // routine and "Post now" can never both send this draft.
    let refused = null as string | null;
    await update<Draft[]>('drafts', [], (cur) =>
      cur.map((d) => {
        if (d.id !== draftId) return d;
        if (d.status === 'posted') { refused = 'This draft is already posted.'; return d; }
        if (d.claimedAt) { refused = 'The daily routine has taken this draft to post. Check X first, or press "Not ready" to take it back.'; return d; }
        return { ...d, claimedAt: new Date().toISOString() };
      }),
    );
    if (refused) return NextResponse.json({ error: refused }, { status: 409 });
    inFlight.add(draftId);
    let sent = false;
    try {
      if (draft.channel === 'x') {
        const communityId = community ? process.env.X_COMMUNITY_ID : undefined;
        postedUrl = (await postToX(draft.parts, { communityId })).url;
        sent = true;
      } else if (draft.channel === 'linkedin') {
        postedUrl = (await postToLinkedIn(draft.parts.join('\n\n'))).url;
        sent = true;
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
      // Nothing went out: give the draft back so it can be posted later.
      if (!sent && !(await read<Draft[]>('drafts', [])).find((d) => d.id === draftId && d.status === 'posted')) {
        await update<Draft[]>('drafts', [], (cur) => cur.map((d) => (d.id === draftId ? { ...d, claimedAt: undefined } : d)));
      }
    }
  }

  return NextResponse.json(await markPosted(draftId, postedUrl));
}
