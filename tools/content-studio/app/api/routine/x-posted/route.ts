import { NextResponse } from 'next/server';
import { tokenOk } from '@/lib/routine';
import { update } from '@/lib/store';
import type { Draft } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Records that the routine posted a Ready X draft. Only a Ready, unposted X
 *  draft can be marked, and only with a link to an x.com post. */
export async function GET(req: Request) {
  if (!(await tokenOk(req))) return NextResponse.json({ error: 'Bad token' }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const id = q.get('id') ?? '';
  const url = q.get('url') ?? '';
  if (!/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(url)) {
    return NextResponse.json({ error: 'url must be the link to the first post, like https://x.com/build_sarthak/status/123' }, { status: 400 });
  }
  let result: Draft | undefined;
  let error = 'Draft not found.';
  const now = new Date().toISOString();
  await update<Draft[]>('drafts', [], (cur) =>
    cur.map((d) => {
      if (d.id !== id) return d;
      if (d.channel !== 'x' || !d.ready || d.status !== 'draft') { error = 'That draft is not a Ready, unposted X draft.'; return d; }
      return (result = { ...d, status: 'posted', postedUrl: url, postedAt: now, updatedAt: now });
    }),
  );
  if (!result) return NextResponse.json({ error }, { status: 400 });
  return NextResponse.json({ ok: true, id: result.id, postedUrl: result.postedUrl });
}
