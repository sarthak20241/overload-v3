import { NextResponse } from 'next/server';
import { suggestTopics } from '@/lib/generate';
import { startJob } from '@/lib/jobs';
import { update } from '@/lib/store';
import type { Pillar, Topic } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { pillars = [], count = 12, steer } = (await req.json()) as { pillars?: Pillar[]; count?: number; steer?: string };
  const n = Math.max(3, Math.min(30, Number(count) || 12));
  const job = startJob('topics', `${n} topic ideas`, (log) => suggestTopics({ pillars, count: n, steer: steer?.trim() || undefined }, log));
  return NextResponse.json({ jobId: job.id });
}

export async function PATCH(req: Request) {
  const { id, status } = (await req.json()) as { id: string; status: Topic['status'] };
  const topics = await update<Topic[]>('topics', [], (cur) => cur.map((t) => (t.id === id ? { ...t, status } : t)));
  return NextResponse.json(topics.find((t) => t.id === id) ?? null);
}
