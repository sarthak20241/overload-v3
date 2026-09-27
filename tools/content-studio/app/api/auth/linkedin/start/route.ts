import { NextResponse } from 'next/server';
import { authUrl, linkedinConfigured } from '@/lib/publish/linkedin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!linkedinConfigured()) return NextResponse.redirect(new URL('/?tab=setup&error=linkedin-keys', req.url));
  return NextResponse.redirect(await authUrl(new URL(req.url).origin));
}
