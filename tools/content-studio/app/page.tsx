'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import BriefView from '@/components/BriefView';
import DraftsView from '@/components/DraftsView';
import IdeasView from '@/components/IdeasView';
import PostedView from '@/components/PostedView';
import ResearchView from '@/components/ResearchView';
import SetupView from '@/components/SetupView';
import { api, type JobView, type StudioState } from '@/lib/client';

export type Tab = 'ideas' | 'drafts' | 'research' | 'brief' | 'posted' | 'setup';

export interface StudioApi {
  state: StudioState;
  reload: () => Promise<void>;
  /** Start a server job and track it in the dock. */
  run: (path: string, body: unknown, opts: { key: string; label: string; onDone?: (result: any) => void }) => Promise<void>;
  /** True while a job started with this key is still running. */
  busy: (key: string) => boolean;
  go: (tab: Tab, draftId?: string) => void;
  selectedDraft: string | null;
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'ideas', label: 'Ideas' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'posted', label: 'Posted' },
  { key: 'research', label: 'Research' },
  { key: 'brief', label: 'Brief' },
  { key: 'setup', label: 'Setup' },
];

export default function Page() {
  const [state, setState] = useState<StudioState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('ideas');
  const [selectedDraft, setSelectedDraft] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const callbacks = useRef(new Map<string, (r: any) => void>());

  const reload = useCallback(async () => {
    try {
      setState(await api<StudioState>('/api/state'));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('tab') as Tab | null;
    if (t && TABS.some((x) => x.key === t)) setTab(t);
    reload();
  }, [reload]);

  // Pick up jobs that were already running when the page loaded.
  useEffect(() => {
    if (!state) return;
    setJobs((cur) => {
      const known = new Set(cur.map((j) => j.id));
      const extra = state.jobs.filter((j) => !known.has(j.id)).map((j) => ({ ...j, status: 'running' as const, progress: [], startedAt: Date.now() }));
      return extra.length ? [...cur, ...extra] : cur;
    });
  }, [state]);

  const running = jobs.filter((j) => j.status === 'running');
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(async () => {
      const updates = await Promise.all(running.map((j) => api<JobView>(`/api/jobs/${j.id}`).catch(() => null)));
      // State updaters run later, during render, so side effects stay out here.
      const finished = updates.filter((u): u is JobView => !!u && u.status !== 'running');
      setJobs((cur) =>
        cur.map((j) => {
          const u = updates.find((x) => x?.id === j.id);
          return u ? { ...j, ...u, key: j.key, label: j.label } : j;
        }),
      );
      if (finished.length) {
        // Finished jobs clear themselves so the dock does not cover the page. Errors stay.
        const done = finished.filter((u) => u.status === 'done').map((u) => u.id);
        if (done.length) setTimeout(() => setJobs((c) => c.filter((j) => !done.includes(j.id))), 4000);
        await reload();
        for (const u of finished) {
          const cb = callbacks.current.get(u.id);
          callbacks.current.delete(u.id);
          if (cb && u.status === 'done') cb(u.result);
        }
      }
    }, 1500);
    return () => clearInterval(t);
  }, [running.map((j) => j.id).join(','), reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((t: Tab, draftId?: string) => {
    setTab(t);
    if (draftId) setSelectedDraft(draftId);
    const url = new URL(window.location.href);
    url.search = `?tab=${t}`;
    window.history.replaceState(null, '', url);
    window.scrollTo({ top: 0 });
  }, []);

  const run = useCallback<StudioApi['run']>(async (path, body, opts) => {
    try {
      const { jobId } = await api<{ jobId: string }>(path, 'POST', body);
      if (opts.onDone) callbacks.current.set(jobId, opts.onDone);
      setJobs((cur) => [...cur, { id: jobId, key: opts.key, kind: path, label: opts.label, status: 'running', progress: [], startedAt: Date.now() }]);
    } catch (e) {
      setJobs((cur) => [...cur, { id: `fail_${Date.now()}`, key: opts.key, kind: path, label: opts.label, status: 'error', error: (e as Error).message, progress: [], startedAt: Date.now() }]);
    }
  }, []);

  const busy = useCallback((key: string) => running.some((j) => j.key === key), [running]);

  if (loadError && !state) return <div className="main"><div className="error">Could not load the studio: {loadError}</div></div>;
  if (!state) return <div className="main subtle">Loading…</div>;

  const studio: StudioApi = { state, reload, run, busy, go, selectedDraft };
  const counts: Partial<Record<Tab, number>> = {
    ideas: state.topics.filter((t) => t.status === 'new' || t.status === 'starred').length,
    drafts: state.drafts.filter((d) => d.status === 'draft').length,
    posted: state.drafts.filter((d) => d.status === 'posted').length,
  };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Overload <span>Studio</span></div>
        {TABS.map((t, i) => (
          <button key={t.key} className={`nav ${tab === t.key ? 'on' : ''}`} onClick={() => go(t.key)}>
            <span className="n">{i + 1}</span>
            {t.label}
            {counts[t.key] ? <span className="count">{counts[t.key]}</span> : null}
          </button>
        ))}
        <div className="foot">
          Writing with {state.status.provider === 'codex' ? 'ChatGPT' : 'Claude'} · {state.status.model}
        </div>
      </aside>

      <main className="main">
        {tab === 'ideas' && <IdeasView s={studio} />}
        {tab === 'drafts' && <DraftsView s={studio} />}
        {tab === 'posted' && <PostedView s={studio} />}
        {tab === 'research' && <ResearchView s={studio} />}
        {tab === 'brief' && <BriefView s={studio} />}
        {tab === 'setup' && <SetupView s={studio} />}
      </main>

      <div className="dock">
        {jobs.slice(-3).map((j) => (
          <div className="job" key={j.id}>
            <div className="spread">
              <div className="row">
                {j.status === 'running' ? <span className="spin" /> : <span className={`dot ${j.status === 'done' ? 'ok' : 'bad'}`} />}
                <b style={{ fontSize: 14 }}>{j.label}</b>
              </div>
              {j.status !== 'running' && (
                <button className="btn ghost small" onClick={() => setJobs((c) => c.filter((x) => x.id !== j.id))}>Close</button>
              )}
            </div>
            {j.status === 'error' && <div className="error" style={{ marginTop: 8 }}>{j.error}</div>}
            {j.status !== 'error' && j.progress.length > 0 && (
              <div className="log">{j.progress.slice(-6).map((p, i) => <div key={i}>{p}</div>)}</div>
            )}
            {j.status === 'running' && <div className="subtle" style={{ marginTop: 6 }}>{Math.round((Date.now() - j.startedAt) / 1000)}s</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
