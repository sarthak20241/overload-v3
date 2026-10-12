import { NextResponse } from 'next/server';
import { writeDraft } from '@/lib/generate';
import { startJob } from '@/lib/jobs';
import { postBlocker } from '@/lib/checks';
import { cleanDashes } from '@/lib/lint';
import { update } from '@/lib/store';
import { CHANNELS, type Channel, type Draft } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { topicId, channel, steer } = (await req.json()) as { topicId: string; channel: Channel; steer?: string };
  if (!CHANNELS.includes(channel)) return NextResponse.json({ error: 'Unknown channel' }, { status: 400 });
  const job = startJob('draft', `draft:${topicId}:${channel}`, 'Writing a draft', (log) => writeDraft({ topicId, channel, steer: steer?.trim() || undefined }, log));
  return NextResponse.json({ jobId: job.id });
}

/** Your own edits. Saved as-is except that dashes are still cleaned. */
export async function PUT(req: Request) {
  const body = (await req.json()) as Pick<Draft, 'id' | 'parts' | 'title' | 'subreddit'>;
  let saved = undefined as Draft | undefined;
  let claimed = false;
  await update<Draft[]>('drafts', [], (cur) =>
    cur.map((d) => {
      if (d.id !== body.id) return d;
      // The routine may be posting this exact text right now.
      if (d.claimedAt) { claimed = true; return d; }
      saved = {
        ...d,
        history: [{ title: d.title, subreddit: d.subreddit, parts: d.parts, at: d.updatedAt, note: 'before your edit' }, ...d.history].slice(0, 20),
        parts: body.parts.map(cleanDashes),
        title: body.title !== undefined ? cleanDashes(body.title) : d.title,
        subreddit: body.subreddit ?? d.subreddit,
        ready: false,
        readyAt: undefined,
        updatedAt: new Date().toISOString(),
      };
      return saved;
    }),
  );
  if (claimed) return NextResponse.json({ error: 'The daily routine has taken this draft to post. Press "Not ready" to take it back first.' }, { status: 409 });
  return NextResponse.json(saved ?? null);
}

/** Mark a draft Ready (or not). Only a draft that could be posted as-is can be Ready. */
export async function PATCH(req: Request) {
  const { id, ready } = (await req.json()) as { id: string; ready: unknown };
  if (typeof ready !== 'boolean') return NextResponse.json({ error: 'ready must be true or false' }, { status: 400 });
  let error = null as string | null;
  let saved: Draft | undefined;
  await update<Draft[]>('drafts', [], (cur) =>
    cur.map((d) => {
      if (d.id !== id) return d;
      if (d.status === 'posted') { error = 'This draft is already posted.'; return d; }
      if (d.channel !== 'x') { error = 'Only X drafts can be Ready. The routine posts nothing else.'; return d; }
      if (ready) {
        error = postBlocker(d);
        if (error) return d;
      }
      if (ready && d.ready) return (saved = d); // already Ready: a repeat call must not touch the claim
      if (ready) return (saved = { ...d, ready: true, readyAt: new Date().toISOString() });
      // Not ready also releases a claim, so you can take a draft back from the routine.
      return (saved = { ...d, ready: false, readyAt: undefined, claimedAt: undefined });
    }),
  );
  if (error) return NextResponse.json({ error }, { status: 400 });
  return NextResponse.json(saved ?? null);
}

export async function DELETE(req: Request) {
  const { id } = (await req.json()) as { id: string };
  await update<Draft[]>('drafts', [], (cur) => cur.filter((d) => d.id !== id));
  return NextResponse.json({ ok: true });
}
