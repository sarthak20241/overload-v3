import { NextResponse } from 'next/server';
import { writeDraft } from '@/lib/generate';
import { startJob } from '@/lib/jobs';
import { cleanDashes } from '@/lib/lint';
import { update } from '@/lib/store';
import { CHANNELS, type Channel, type Draft } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { topicId, channel, steer } = (await req.json()) as { topicId: string; channel: Channel; steer?: string };
  if (!CHANNELS.includes(channel)) return NextResponse.json({ error: 'Unknown channel' }, { status: 400 });
  const job = startJob('draft', 'Writing a draft', (log) => writeDraft({ topicId, channel, steer: steer?.trim() || undefined }, log));
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
        updatedAt: new Date().toISOString(),
      };
      return saved;
    }),
  );
  return NextResponse.json(saved ?? null);
}

export async function DELETE(req: Request) {
  const { id } = (await req.json()) as { id: string };
  await update<Draft[]>('drafts', [], (cur) => cur.filter((d) => d.id !== id));
  return NextResponse.json({ ok: true });
}
