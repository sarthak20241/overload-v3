'use client';
/**
 * Coupons page, interactive part: give a code, pick one from the list, make
 * 500 more, make a named code, and the list of codes already given.
 */
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Link as LinkIcon, Loader2, Plus, Power, Tag, Ticket, Undo2 } from 'lucide-react';
import {
  checkBatches, giveCode, makeBatch, makeNamedCode, markGiven, turnOffNamedCode, undoGiven,
} from './actions';
import type { Period } from '@/lib/appstore';

export type CouponRow = {
  code: string;
  period: Period;
  kind: 'one_time' | 'named';
  expires: string | null;
  sandbox: boolean;
  given_at: string | null;
  given_to: string | null;
  note: string | null;
  off: boolean;
  url: string;
};

export type BatchRow = {
  id: string;
  period: Period;
  kind: 'one_time' | 'named';
  count: number;
  expires: string | null;
  status: 'making' | 'ready' | 'failed' | 'off';
  sandbox: boolean;
  created_at: string;
};

export type StockRow = {
  period: Period;
  sandbox: boolean;
  usable: number;
  ending_soon: number;
  given: number;
  next_end: string | null;
};

type Props = {
  period: Period;
  periods: { id: Period; label: string }[];
  stock: StockRow[];
  unused: CouponRow[];
  given: CouponRow[];
  batches: BatchRow[];
};

const APP_ID = '6773063775';
const redeem = (code: string) =>
  `https://apps.apple.com/redeem?ctx=offercodes&id=${APP_ID}&code=${encodeURIComponent(code)}`;

function shareText(code: string, label: string): string {
  return `Here's ${label} of Overload Pro, free. Tap to claim it on your iPhone: ${redeem(code)}\n(Or enter code ${code} in the App Store.)`;
}

function when(iso: string | null): string {
  if (!iso) return '';
  // A fixed locale and zone: the server and the browser must print the same text.
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function CopyButton({ text, label, icon }: { text: string; label: string; icon?: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-fg hover:text-fg hover:border-border-strong"
    >
      {done ? <Check size={12} className="text-primary" /> : (icon ?? <Copy size={12} />)}
      {done ? 'Copied' : label}
    </button>
  );
}

const input =
  'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-text-dim focus:outline-none focus:border-border-strong';
const primaryBtn =
  'inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-accent disabled:opacity-50';
const card = 'rounded-xl border border-border bg-card p-5';

export function CouponsInteractive({ period, periods, stock, unused, given, batches }: Props) {
  const router = useRouter();
  const label = (p: Period) => periods.find((x) => x.id === p)?.label ?? p;
  const [pending, start] = useTransition();
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CouponRow | { code: string; period: Period } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [making, setMaking] = useState<Period | null>(null);
  const [named, setNamed] = useState({ code: '', period: 'ONE_MONTH' as Period, to: '', note: '' });
  const [tab, setTab] = useState<'unused' | 'given'>('unused');

  const stockOf = (p: Period) => stock.find((s) => s.period === p);
  const makingBatches = batches.filter((b) => b.status === 'making');

  // While Apple is still making a batch, check every 5 s and save it when done.
  useEffect(() => {
    if (!makingBatches.length) return;
    const t = setInterval(async () => {
      const r = await checkBatches();
      if (r.ok) router.refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [makingBatches.length, router]);

  const setPeriod = (p: Period) => {
    setEmpty(false);
    setResult(null);
    router.push(`/coupons?period=${p}`, { scroll: false });
  };

  const give = () =>
    start(async () => {
      setError(null);
      setEmpty(false);
      const r = await giveCode(period, to, note);
      if (!r.ok) return setError(r.error);
      if (!r.coupon) return setEmpty(true);
      setResult(r.coupon);
      setTo('');
      setNote('');
      router.refresh();
    });

  const pick = (code: string) =>
    start(async () => {
      setError(null);
      const r = await markGiven(code, to, note);
      if (!r.ok) return setError(r.error);
      setResult({ code, period });
      setTo('');
      setNote('');
      router.refresh();
    });

  const make = (p: Period) => {
    setMaking(p);
    start(async () => {
      setError(null);
      const r = await makeBatch(p);
      setMaking(null);
      if (!r.ok) return setError(r.error);
      setEmpty(false);
      router.refresh();
    });
  };

  const makeNamed = () =>
    start(async () => {
      setError(null);
      const r = await makeNamedCode(named.period, named.code, named.to, named.note);
      if (!r.ok) return setError(r.error);
      setResult(r.coupon);
      setNamed({ code: '', period: named.period, to: '', note: '' });
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Give a code */}
      <section className={card}>
        <div className="flex items-center gap-2 mb-4">
          <Ticket size={15} className="text-primary" />
          <h2 className="text-sm font-semibold">Give a code</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_1fr_auto] gap-3 items-end">
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Free time
            <select className={input} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            For (name)
            <input className={input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="Rahul" />
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Note
            <input className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Old app user, giveaway…" />
          </label>
          <button className={primaryBtn} disabled={pending} onClick={give}>
            {pending && !making ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} />}
            Give next code
          </button>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          {stockOf(period)?.usable ?? 0} unused {label(period)} codes ready. Or pick one from the list below.
        </p>

        {empty && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
            No {label(period)} codes left. Apple makes them 500 at a time (about a minute).
            <button className={primaryBtn} disabled={pending} onClick={() => make(period)}>
              <Plus size={14} /> Make 500
            </button>
          </div>
        )}

        {result && (
          <div className="mt-4 rounded-lg border border-primary-muted bg-primary-subtle px-4 py-4">
            <div className="text-xs text-muted-fg mb-1">{label(result.period)} free · works one time</div>
            <div className="font-mono text-2xl font-semibold tracking-wider text-primary mb-3">{result.code}</div>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={result.code} label="Copy code" />
              <CopyButton text={redeem(result.code)} label="Copy link" icon={<LinkIcon size={12} />} />
              <CopyButton text={shareText(result.code, label(result.period))} label="Copy message" />
            </div>
          </div>
        )}
      </section>

      {/* Stock */}
      <section className={card}>
        <h2 className="text-sm font-semibold mb-1">Stock</h2>
        <p className="text-xs text-text-muted mb-4">
          Apple makes one-time codes 500 at a time. Each batch ends after 150 days. A code that ends within 14 days is not given.
        </p>
        {makingBatches.length > 0 && (
          <div className="mb-3 flex items-center gap-2 text-xs text-info">
            <Loader2 size={12} className="animate-spin" />
            Apple is making {makingBatches.map((b) => label(b.period)).join(', ')} codes. This page checks every 5 seconds.
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-text-muted text-left">
              <tr>
                <th className="py-2 pr-4 font-normal">Free time</th>
                <th className="py-2 pr-4 font-normal">Unused</th>
                <th className="py-2 pr-4 font-normal">Given</th>
                <th className="py-2 pr-4 font-normal">Next batch ends</th>
                <th className="py-2 font-normal" />
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => {
                const s = stockOf(p.id);
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-2 pr-4">{p.label}</td>
                    <td className={`py-2 pr-4 ${s?.usable ? 'text-fg' : 'text-text-dim'}`}>
                      {s?.usable ?? 0}
                      {s?.ending_soon ? <span className="ml-2 text-xs text-warning">+{s.ending_soon} ending soon</span> : null}
                    </td>
                    <td className="py-2 pr-4 text-muted-fg">{s?.given ?? 0}</td>
                    <td className="py-2 pr-4 text-muted-fg">{s?.next_end ? when(s.next_end) : '-'}</td>
                    <td className="py-2 text-right">
                      <button
                        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-fg hover:text-fg hover:border-border-strong disabled:opacity-50"
                        disabled={pending}
                        onClick={() => make(p.id)}
                      >
                        {making === p.id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        {making === p.id ? 'Making…' : 'Make 500'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Named code */}
      <section className={card}>
        <div className="flex items-center gap-2 mb-1">
          <Tag size={15} className="text-primary" />
          <h2 className="text-sm font-semibold">Make a named code</h2>
        </div>
        <p className="text-xs text-text-muted mb-4">
          A code you choose, like RAHUL. Apple makes every named code good for 500 people, so give it to one person only.
          You can turn it off later.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_1fr_1fr_auto] gap-3 items-end">
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Code
            <input
              className={`${input} font-mono uppercase`}
              value={named.code}
              onChange={(e) => setNamed({ ...named, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
              placeholder="RAHUL"
              maxLength={30}
            />
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Free time
            <select className={input} value={named.period} onChange={(e) => setNamed({ ...named, period: e.target.value as Period })}>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            For (name)
            <input className={input} value={named.to} onChange={(e) => setNamed({ ...named, to: e.target.value })} />
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Note
            <input className={input} value={named.note} onChange={(e) => setNamed({ ...named, note: e.target.value })} />
          </label>
          <button className={primaryBtn} disabled={pending || named.code.length < 4} onClick={makeNamed}>
            <Tag size={14} /> Make code
          </button>
        </div>
      </section>

      {/* Lists */}
      <section className={card}>
        <div className="flex gap-1 mb-4">
          {(['unused', 'given'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-xs ${tab === t ? 'bg-primary-subtle text-primary' : 'text-muted-fg hover:text-fg'}`}
            >
              {t === 'unused' ? `Unused ${label(period)} codes` : `Given (${given.length})`}
            </button>
          ))}
        </div>

        {tab === 'unused' && (
          <>
            <p className="text-xs text-text-muted mb-3">
              Pick a code to share. &quot;Give&quot; marks it as given, with the name and note from the top.
            </p>
            {unused.length === 0 ? (
              <p className="text-sm text-text-dim py-4">No unused {label(period)} codes. Use Make 500 above.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {unused.map((c) => (
                    <tr key={c.code} className="border-t border-border">
                      <td className="py-2 pr-4 font-mono">{c.code}</td>
                      <td className="py-2 pr-4 text-xs text-text-muted">ends {when(c.expires)}</td>
                      <td className="py-2 text-right">
                        <div className="inline-flex gap-2">
                          <CopyButton text={c.url} label="Copy link" icon={<LinkIcon size={12} />} />
                          <button
                            className="inline-flex items-center gap-1.5 rounded-md border border-primary-muted px-2.5 py-1 text-xs text-primary hover:bg-primary-subtle disabled:opacity-50"
                            disabled={pending}
                            onClick={() => pick(c.code)}
                          >
                            <Check size={12} /> Give
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === 'given' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-text-muted text-left">
                <tr>
                  <th className="py-2 pr-4 font-normal">Code</th>
                  <th className="py-2 pr-4 font-normal">Free time</th>
                  <th className="py-2 pr-4 font-normal">For</th>
                  <th className="py-2 pr-4 font-normal">Given</th>
                  <th className="py-2 pr-4 font-normal">Note</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {given.map((c) => (
                  <tr key={c.code} className={`border-t border-border ${c.off ? 'opacity-50' : ''}`}>
                    <td className="py-2 pr-4 font-mono">
                      {c.code}
                      {c.kind === 'named' && <span className="ml-2 text-[10px] uppercase text-info">named</span>}
                      {c.off && <span className="ml-2 text-[10px] uppercase text-danger">off</span>}
                    </td>
                    <td className="py-2 pr-4 text-muted-fg">{label(c.period)}</td>
                    <td className="py-2 pr-4">{c.given_to ?? <span className="text-text-dim">-</span>}</td>
                    <td className="py-2 pr-4 text-muted-fg">{when(c.given_at)}</td>
                    <td className="py-2 pr-4 text-muted-fg">{c.note}</td>
                    <td className="py-2 text-right">
                      <div className="inline-flex gap-2">
                        {!c.off && <CopyButton text={c.url} label="Link" icon={<LinkIcon size={12} />} />}
                        {c.kind === 'one_time' && (
                          <button
                            title="Put back as unused (only if you never sent it)"
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-fg hover:text-fg disabled:opacity-50"
                            disabled={pending}
                            onClick={() => {
                              if (confirm(`Put ${c.code} back as unused? Only do this if you never sent it.`)) {
                                start(async () => {
                                  const r = await undoGiven(c.code);
                                  if (!r.ok) setError(r.error);
                                  router.refresh();
                                });
                              }
                            }}
                          >
                            <Undo2 size={12} />
                          </button>
                        )}
                        {c.kind === 'named' && !c.off && (
                          <button
                            title="Turn off at Apple"
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-danger hover:border-danger/40 disabled:opacity-50"
                            disabled={pending}
                            onClick={() => {
                              if (confirm(`Turn off ${c.code}? It stops working at once. You can't turn it back on.`)) {
                                start(async () => {
                                  const r = await turnOffNamedCode(c.code);
                                  if (!r.ok) setError(r.error);
                                  router.refresh();
                                });
                              }
                            }}
                          >
                            <Power size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
