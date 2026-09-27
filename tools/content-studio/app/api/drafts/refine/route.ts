import { NextResponse } from 'next/server';
import { refineDraft } from '@/lib/generate';
import { startJob } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { draftId, instruction } = (await req.json()) as { draftId: string; instruction: string };
  if (!instruction?.trim()) return NextResponse.json({ error: 'Say what to change.' }, { status: 400 });
  const job = startJob('refine', `refine:${draftId}`, 'Rewrite draft', (log) => refineDraft({ draftId, instruction: instruction.trim() }, log));
  return NextResponse.json({ jobId: job.id });
}
