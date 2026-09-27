import { NextResponse } from 'next/server';
import { update } from '@/lib/store';
import type { Brief } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const body = (await req.json()) as Brief;
  const saved = await update<Brief | null>('brief', null, () => ({ sections: body.sections, updatedAt: new Date().toISOString() }));
  return NextResponse.json(saved);
}
