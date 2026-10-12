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
  let saved: Draft | undefined;
  await update<Draft[]>('drafts', [], (cur) =>
    cur.map((d) => {
      if (d.id !== body.id) return d;
      saved = {
        ...d,
        history: [{ title: d.title, subreddit: d.subreddit, parts: d.parts, at: d.updatedAt, note: 'before your edit' }, ...d.history].slice(0, 20),
        parts: body.parts.map(cleanDashes),
        title: body.title !== undefined ? cleanDashes(body.title) : d.title,
        subreddit: body.subreddit ?? d.subreddit,
        ready: false,
        updatedAt: new Date().toISOString(),
      };
      return saved;
    }),
  );
  return NextResponse.json(saved ?? null);
}

/** Mark a draft Ready (or not). Only a draft that could be posted as-is can be Ready. */
export async function PATCH(req: Request) {
  const { id, ready } = (await req.json()) as { id: string; ready: boolean };
  let error: string | null = null;
  let saved: Draft | undefined;
  await update<Draft[]>('drafts', [], (cur) =>
    cur.map((d) => {
      if (d.id !== id) return d;
      if (d.status === 'posted') { error = 'This draft is already posted.'; return d; }
      if (ready) {
        error = postBlocker(d);
        if (error) return d;
      }
      return (saved = { ...d, ready: Boolean(ready), updatedAt: new Date().toISOString() });
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
