/**
 * Coupons, two stores:
 * - iPhone (?store=apple, the default): App Store offer codes. Give the next
 *   unused code for a period, pick one from the list, make 500 more, or make a
 *   named code (like RAHUL). In coupon_batches + coupons (20261110120000).
 * - Android (?store=android): our own server codes, any free time, no card,
 *   nothing renews. In invite_codes (20261110150000). Google is not involved.
 */
import Link from 'next/link';
import { getSupabaseServerClient } from '@/lib/supabase';
import { hasKey, PERIODS, PERIOD_LABEL, redeemUrl, type Period } from '@/lib/appstore';
import { AndroidCoupons, type ServerCodeRow } from './AndroidCoupons';
import { CouponsInteractive, type CouponRow, type BatchRow, type StockRow } from './CouponsInteractive';

export const dynamic = 'force-dynamic';
// Making a batch waits for Apple (usually under a minute).
export const maxDuration = 300;

const COLUMNS = 'code, period, kind, expires, sandbox, given_at, given_to, note, coupon_batches(status)';

function toRow(c: Record<string, unknown>): CouponRow {
  const batch = c.coupon_batches as { status: string } | null;
  return {
    code: c.code as string,
    period: c.period as Period,
    kind: c.kind as CouponRow['kind'],
    expires: c.expires as string | null,
    sandbox: c.sandbox as boolean,
    given_at: c.given_at as string | null,
    given_to: c.given_to as string | null,
    note: c.note as string | null,
    off: batch?.status === 'off',
    url: redeemUrl(c.code as string),
  };
}

export default async function CouponsPage({
  searchParams,
}: { searchParams: Promise<{ period?: string; store?: string }> }) {
  const sp = await searchParams;
  if (sp.store === 'android') return <AndroidPage />;
  const period: Period = (PERIODS as readonly string[]).includes(sp.period ?? '') ? (sp.period as Period) : 'ONE_YEAR';
  const supabase = await getSupabaseServerClient();
  const soon = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const [stock, unused, given, batches] = await Promise.all([
    supabase.rpc('coupon_stock'),
    supabase
      .from('coupons')
      .select(COLUMNS)
      .eq('period', period)
      .eq('kind', 'one_time')
      .eq('sandbox', false)
      .is('given_at', null)
      .gte('expires', soon)
      .order('expires')
      .order('code')
      .limit(100),
    supabase
      .from('coupons')
      .select(COLUMNS)
      .not('given_at', 'is', null)
      .order('given_at', { ascending: false })
      .limit(300),
    supabase
      .from('coupon_batches')
      .select('id, period, kind, count, expires, status, sandbox, created_at')
      .order('created_at', { ascending: false })
      .limit(200),
  ]);
  const error = stock.error ?? unused.error ?? given.error ?? batches.error;

  return (
    <div className="px-8 py-7 max-w-6xl">
      <Header store="apple" />
      {error && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Could not read coupons: {error.message}
        </div>
      )}
      {!hasKey() && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          The App Store key is not set on this site. You can give codes already in stock, but you can&apos;t
          make new ones. Add ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY to the site env.
        </div>
      )}
      <CouponsInteractive
        period={period}
        periods={PERIODS.map((p) => ({ id: p, label: PERIOD_LABEL[p] }))}
        stock={((stock.data ?? []) as StockRow[]).filter((s) => !s.sandbox)}
        unused={(unused.data ?? []).map(toRow)}
        given={(given.data ?? []).map(toRow)}
        batches={(batches.data ?? []) as BatchRow[]}
      />
    </div>
  );
}

function Header({ store }: { store: 'apple' | 'android' }) {
  const tab = (id: 'apple' | 'android', label: string) => (
    <Link
      href={`/coupons?store=${id}`}
      className={`rounded-md px-3 py-1.5 text-sm ${store === id ? 'bg-primary-subtle text-primary' : 'text-muted-fg hover:text-fg'}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">Coupons</h1>
      <p className="text-sm text-muted-fg mt-1">
        {store === 'apple'
          ? 'Free Pro time on iPhone, as App Store offer codes. Each one-time code works for one person.'
          : 'Free Pro time on Android, as our own codes. No card, nothing renews, and Google is not involved.'}
      </p>
      <div className="mt-4 flex gap-1">
        {tab('apple', 'iPhone')}
        {tab('android', 'Android')}
      </div>
    </div>
  );
}

async function AndroidPage() {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('admin_server_codes', { p_limit: 300 });
  return (
    <div className="px-8 py-7 max-w-6xl">
      <Header store="android" />
      {error && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Could not read Android codes: {error.message}
        </div>
      )}
      <AndroidCoupons codes={(data ?? []) as ServerCodeRow[]} now={Date.now()} />
    </div>
  );
}
