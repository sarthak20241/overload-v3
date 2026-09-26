import { NextResponse } from 'next/server';
import { researchChannel } from '@/lib/generate';
import { SPECS } from '@/lib/channels';
import { startJob } from '@/lib/jobs';
import { CHANNELS, type Channel } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { channel } = (await req.json()) as { channel: Channel };
  if (!CHANNELS.includes(channel)) return NextResponse.json({ error: 'Unknown channel' }, { status: 400 });
  const job = startJob('research', `Researching ${SPECS[channel].name}`, (log) => researchChannel(channel, log));
  return NextResponse.json({ jobId: job.id });
}
