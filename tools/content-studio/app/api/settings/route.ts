import { NextResponse } from 'next/server';
import type { WriterSettings } from '@/lib/llm';
import { update } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const body = (await req.json()) as Partial<WriterSettings>;
  const saved = await update<Partial<WriterSettings>>('settings', {}, (cur) => ({
    ...cur,
    ...(body.provider === 'claude' || body.provider === 'codex' ? { provider: body.provider } : {}),
    ...(typeof body.fallback === 'boolean' ? { fallback: body.fallback } : {}),
  }));
  return NextResponse.json(saved);
}
