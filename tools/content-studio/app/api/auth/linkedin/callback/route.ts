import { NextResponse } from 'next/server';
import { handleCallback } from '@/lib/publish/linkedin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const back = new URL('/?tab=setup', req.url);
  if (!code) {
    back.searchParams.set('error', url.searchParams.get('error_description') ?? 'LinkedIn login was cancelled.');
    return NextResponse.redirect(back);
  }
  try {
    await handleCallback(url.origin, code, state);
    back.searchParams.set('ok', 'linkedin');
  } catch (e) {
    back.searchParams.set('error', (e as Error).message);
  }
  return NextResponse.redirect(back);
}
