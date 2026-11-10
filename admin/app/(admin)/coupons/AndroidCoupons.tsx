'use client';
/**
 * Coupons page, Android part: make a server code (any free time, no card,
 * nothing renews) and the list of codes made so far. A server code works in
 * the app's "Have a code?" box on Android and web. On iPhone the app sends it
 * to the App Store, where it does not work, so iPhone users get Apple codes.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Link as LinkIcon, Loader2, Power, Smartphone } from 'lucide-react';
import { makeServerCode, turnOffServerCode } from './android-actions';

export type ServerCodeRow = {
  code: string;
  days: number;
  uses: number | null;
  used: number;
  given_to: string | null;
  note: string | null;
  made_at: string;
  expires_at: string | null;
  last_used: string | null;
};

const LENGTHS = [
  { days: 30, label: '1 month' },
  { days: 60, label: '2 months' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
];

export function daysLabel(days: number): string {
  return LENGTHS.find((l) => l.days === days)?.label ?? `${days} days`;
}

// The app's invite link: opens the app with the code filled in.
const link = (code: string) => `https://tryoverload.app/i/${code}`;

function shareText(code: string, days: number): string {
  return (
    `Here's ${daysLabel(days)} of Overload Pro, free, for Android. Open this link on your phone: ${link(code)}\n` +
    `Or in the app, tap "Have a code?" and enter ${code}. No card needed, and nothing renews.`
  );
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

export function AndroidCoupons({ codes, now }: { codes: ServerCodeRow[]; now: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({ days: 365, uses: 1, to: '', note: '', code: '' });
  const [result, setResult] = useState<{ code: string; days: number; uses: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ended = (c: ServerCodeRow) => c.expires_at !== null && new Date(c.expires_at).getTime() <= now;
  const full = (c: ServerCodeRow) => c.uses !== null && c.used >= c.uses;

  const make = () =>
    start(async () => {
      setError(null);
      const r = await makeServerCode(form);
      if (!r.ok) return setError(r.error);
      setResult({ code: r.code, days: form.days, uses: form.uses });
      setForm({ ...form, to: '', note: '', code: '', uses: 1 });
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <section className={card}>
        <div className="flex items-center gap-2 mb-1">
          <Smartphone size={15} className="text-primary" />
          <h2 className="text-sm font-semibold">Make an Android code</h2>
        </div>
        <p className="text-xs text-text-muted mb-4">
          Our own code, not a Google Play code. The person enters it in the app and gets Pro for the free time.
          No card, nothing renews, and one code per account. It does not work on iPhone.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[140px_100px_1fr_1fr_1fr_auto] gap-3 items-end">
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Free time
            <select className={input} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}>
              {LENGTHS.map((l) => (
                <option key={l.days} value={l.days}>{l.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            People
            <input
              className={input}
              type="number"
              min={1}
              max={100000}
              value={form.uses}
              onChange={(e) => setForm({ ...form, uses: Number(e.target.value) || 1 })}
            />
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            For (name)
            <input className={input} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="Rahul" />
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Note
            <input className={input} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Giveaway…" />
          </label>
          <label className="text-xs text-muted-fg flex flex-col gap-1.5">
            Code (blank = random)
            <input
              className={`${input} font-mono uppercase`}
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
              placeholder="GYMBUDDY26"
              maxLength={16}
            />
          </label>
          <button className={primaryBtn} disabled={pending || (form.code.length > 0 && form.code.length < 8)} onClick={make}>
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Smartphone size={14} />}
            Make code
          </button>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          People = how many accounts can use it. Keep 1 for a personal code. A code you choose needs 8 to 16 letters or numbers.
        </p>

        {result && (
          <div className="mt-4 rounded-lg border border-primary-muted bg-primary-subtle px-4 py-4">
            <div className="text-xs text-muted-fg mb-1">
              {daysLabel(result.days)} free · Android · {result.uses === 1 ? 'one person' : `${result.uses} people`}
            </div>
            <div className="font-mono text-2xl font-semibold tracking-wider text-primary mb-3">{result.code}</div>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={result.code} label="Copy code" />
              <CopyButton text={link(result.code)} label="Copy link" icon={<LinkIcon size={12} />} />
              <CopyButton text={shareText(result.code, result.days)} label="Copy message" />
            </div>
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold mb-1">Android codes ({codes.length})</h2>
        <p className="text-xs text-text-muted mb-4">
          Newest first. Turning a code off stops new people from using it. People who already used it keep their free time.
        </p>
        {codes.length === 0 ? (
          <p className="text-sm text-text-dim py-4">No Android codes yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-text-muted text-left">
                <tr>
                  <th className="py-2 pr-4 font-normal">Code</th>
                  <th className="py-2 pr-4 font-normal">Free time</th>
                  <th className="py-2 pr-4 font-normal">Used</th>
                  <th className="py-2 pr-4 font-normal">For</th>
                  <th className="py-2 pr-4 font-normal">Made</th>
                  <th className="py-2 pr-4 font-normal">Note</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => {
                  const off = ended(c);
                  return (
                    <tr key={c.code} className={`border-t border-border ${off ? 'opacity-50' : ''}`}>
                      <td className="py-2 pr-4 font-mono">
                        {c.code}
                        {off && <span className="ml-2 text-[10px] uppercase text-danger">off</span>}
                        {!off && full(c) && <span className="ml-2 text-[10px] uppercase text-info">used</span>}
                      </td>
                      <td className="py-2 pr-4 text-muted-fg">{daysLabel(c.days)}</td>
                      <td className="py-2 pr-4 text-muted-fg">
                        {c.used} / {c.uses ?? '∞'}
                        {c.last_used && <span className="ml-2 text-xs text-text-dim">last {when(c.last_used)}</span>}
                      </td>
                      <td className="py-2 pr-4">{c.given_to ?? <span className="text-text-dim">-</span>}</td>
                      <td className="py-2 pr-4 text-muted-fg">{when(c.made_at)}</td>
                      <td className="py-2 pr-4 text-muted-fg">{c.note}</td>
                      <td className="py-2 text-right">
                        <div className="inline-flex gap-2">
                          {!off && <CopyButton text={shareText(c.code, c.days)} label="Message" />}
                          {!off && (
                            <button
                              title="Turn off"
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-danger hover:border-danger/40 disabled:opacity-50"
                              disabled={pending}
                              onClick={() => {
                                if (confirm(`Turn off ${c.code}? Nobody new can use it. You can't turn it back on.`)) {
                                  start(async () => {
                                    const r = await turnOffServerCode(c.code);
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
