import { NextResponse } from 'next/server';
import { postBlocker } from '@/lib/checks';
import { tokenOk } from '@/lib/routine';
import { update } from '@/lib/store';
import type { Draft } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Hands the routine the oldest Ready X draft and claims it. If an earlier
 * draft was claimed but never confirmed, the routine posted it and failed to
 * record it, or never posted it: either way nothing new goes out until that is
 * settled, so a hiccup can't put the same thread on X twice.
 */
export async function GET(req: Request) {
  if (!(await tokenOk(req))) return NextResponse.json({ error: 'Bad token' }, { status: 403 });
  let pending = undefined as Draft | undefined;
  let next = undefined as Draft | undefined;
  let blocked: string[] = [];
  const now = new Date().toISOString();
  await update<Draft[]>('drafts', [], (cur) => {
    const unposted = cur.filter((d) => d.channel === 'x' && d.status === 'draft');
    // Any claim blocks the day, Ready or not: a claim means something may be live.
    pending = unposted.find((d) => d.claimedAt);
    if (pending) return cur;
    const open = unposted.filter((d) => d.ready).map((d) => ({ d, why: postBlocker(d) }));
    blocked = open.filter((o) => o.why).map((o) => `${o.d.topicTitle}: ${o.why}`);
    next = open.filter((o) => !o.why).map((o) => o.d).sort((a, b) => (a.readyAt ?? a.updatedAt).localeCompare(b.readyAt ?? b.updatedAt))[0];
    if (!next) return cur;
    next = { ...next, claimedAt: now };
    return cur.map((d) => (d.id === next!.id ? next! : d));
  });

  if (pending) {
    const p = pending as Draft;
    return NextResponse.json({
      draft: null,
      unconfirmed: { id: p.id, topic: p.topicTitle, firstPost: p.parts[0], claimedAt: p.claimedAt },
      note: 'An earlier draft was handed out but never confirmed. Do NOT post anything on X today. Check https://x.com/build_sarthak: if a post starting with firstPost is there, open /api/routine/x-posted with this id and that post\'s URL. If it is not there, report it so the founder can release it in the studio.',
    });
  }
  if (!next) {
    return NextResponse.json({
      draft: null,
      note: blocked.length ? 'Ready drafts exist but none can be posted as-is. Post nothing on X today and report these.' : 'No X draft is marked Ready. Post nothing on X today.',
      ...(blocked.length ? { skipped: blocked } : {}),
    });
  }
  const n = next as Draft;
  return NextResponse.json({
    draft: { id: n.id, topic: n.topicTitle, posts: n.parts, count: n.parts.length },
    note: 'Post these as ONE thread to Everyone, in this exact order and wording. Then open /api/routine/x-posted with id and url.',
  });
}
