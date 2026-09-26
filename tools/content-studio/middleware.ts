import { NextResponse, type NextRequest } from 'next/server';

/**
 * The studio can post to your accounts, so its API only answers this Mac.
 * Binding to 127.0.0.1 (package.json) keeps the LAN out. These checks keep
 * out a web page open in another tab: a foreign Origin on a write, or a
 * DNS-rebinding Host that is not localhost.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return new NextResponse('Forbidden', { status: 403 });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).hostname; } catch { /* treated as foreign */ }
      if (!LOCAL_HOSTS.has(originHost) && !LOCAL_HOSTS.has(`[${originHost}]`)) {
        return NextResponse.json({ error: 'Requests from other sites are blocked.' }, { status: 403 });
      }
    }
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
