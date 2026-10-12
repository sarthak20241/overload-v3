import { NextResponse } from 'next/server';
import { postBlocker } from '@/lib/checks';
import { tokenOk } from '@/lib/routine';
import { read } from '@/lib/store';
import type { Draft } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The oldest X draft you marked Ready and that is still unposted, or none. */
export async function GET(req: Request) {
  if (!(await tokenOk(req))) return NextResponse.json({ error: 'Bad token' }, { status: 403 });
  const drafts = await read<Draft[]>('drafts', []);
  const next = drafts
    .filter((d) => d.channel === 'x' && d.status === 'draft' && d.ready && !postBlocker(d))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  if (!next) return NextResponse.json({ draft: null, note: 'No X draft is marked Ready. Post nothing on X today.' });
  return NextResponse.json({
    draft: { id: next.id, topic: next.topicTitle, posts: next.parts, count: next.parts.length },
    note: 'Post these as ONE thread to Everyone, in this exact order and wording. Then open /api/routine/x-posted with id and url.',
  });
}
