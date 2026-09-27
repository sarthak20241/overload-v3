'use client';

import { useState } from 'react';
import type { StudioApi } from '@/app/page';
import { api, ago, CHANNEL_NAME } from '@/lib/client';
import { CHANNELS, PILLARS, type Channel, type Pillar, type Topic } from '@/lib/types';

type Filter = 'open' | 'starred' | 'used' | 'archived' | 'all';

export default function IdeasView({ s }: { s: StudioApi }) {
  const { topics, playbooks } = s.state;
  const [pillars, setPillars] = useState<Pillar[]>([]);
  const [count, setCount] = useState(12);
  const [steer, setSteer] = useState('');
  const [filter, setFilter] = useState<Filter>('open');
  const [pillarFilter, setPillarFilter] = useState<Pillar | 'all'>('all');

  const researched = CHANNELS.filter((c) => playbooks[c]).length;
  const generating = s.busy('topics');

  const shown = topics.filter((t) => {
    if (pillarFilter !== 'all' && t.pillar !== pillarFilter) return false;
    if (filter === 'open') return t.status === 'new' || t.status === 'starred';
    if (filter === 'all') return true;
    return t.status === filter;
  });

  const toggle = (p: Pillar) => setPillars((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const suggest = () =>
    s.run('/api/topics', { pillars, count, steer }, { key: 'topics', label: `Suggesting ${count} topics` });

  return (
    <>
      <div className="head">
        <div>
          <h1>Ideas</h1>
          <p>Topics built on one core idea each, made sticky with the Made to Stick checklist, and matched to the channel where they will land best.</p>
        </div>
      </div>

      {researched < 3 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="spread">
            <span className="muted">
              {researched === 0 ? 'No channel research yet.' : `${researched} of 3 channels researched.`} Ideas get sharper after research.
            </span>
            <button className="btn small" onClick={() => s.go('research')}>Go to Research</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="stack">
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Draw from (none picked = all)</div>
            <div className="row">
              {PILLARS.map((p) => (
                <button key={p.key} className={`chip ${pillars.includes(p.key) ? 'on' : ''}`} onClick={() => toggle(p.key)} title={p.hint}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="label" style={{ marginBottom: 6 }}>Focus (optional)</div>
              <input type="text" value={steer} onChange={(e) => setSteer(e.target.value)} placeholder="e.g. the food logging launch, or posts for people who hit a plateau" />
            </div>
            <div style={{ width: 90 }}>
              <div className="label" style={{ marginBottom: 6 }}>How many</div>
              <input type="number" min={3} max={30} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </div>
            <button className="btn primary" onClick={suggest} disabled={generating}>
              {generating ? 'Thinking…' : 'Suggest topics'}
            </button>
          </div>
        </div>
      </div>

      <div className="spread" style={{ margin: '24px 0 12px' }}>
        <div className="row">
          {(['open', 'starred', 'used', 'archived', 'all'] as Filter[]).map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'open' ? 'Open' : f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <select value={pillarFilter} onChange={(e) => setPillarFilter(e.target.value as Pillar | 'all')} style={{ width: 200 }}>
          <option value="all">All pillars</option>
          {PILLARS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {shown.length === 0 ? (
        <div className="empty">{topics.length ? 'Nothing here with these filters.' : 'No ideas yet. Press "Suggest topics".'}</div>
      ) : (
        <div className="stack">{shown.map((t) => <TopicCard key={t.id} t={t} s={s} />)}</div>
      )}
    </>
  );
}

function TopicCard({ t, s }: { t: Topic; s: StudioApi }) {
  const [steer, setSteer] = useState('');
  const pillar = PILLARS.find((p) => p.key === t.pillar);
  const drafts = s.state.drafts.filter((d) => d.topicId === t.id);

  const setStatus = async (status: Topic['status']) => {
    await api('/api/topics', 'PATCH', { id: t.id, status });
    s.reload();
  };

  const write = (channel: Channel) =>
    s.run('/api/drafts', { topicId: t.id, channel, steer }, {
      key: `draft:${t.id}:${channel}`,
      label: `Writing for ${CHANNEL_NAME[channel]}: ${t.title.slice(0, 40)}`,
      onDone: (d) => d?.id && s.go('drafts', d.id),
    });

  const order: Channel[] = [...t.channels, ...CHANNELS.filter((c) => !t.channels.includes(c))];

  return (
    <div className="card">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="tag">{pillar?.label ?? t.pillar}</span>
            {t.status === 'starred' && <span className="tag">Starred</span>}
            {t.status === 'used' && <span className="tag">Used</span>}
            <span className="subtle">{ago(t.createdAt)}</span>
          </div>
          <p className="big">{t.title}</p>
          <p className="muted" style={{ margin: '6px 0 0' }}><b style={{ color: 'var(--text)' }}>Core idea:</b> {t.coreIdea}</p>
        </div>
        <div className="row">
          <button className="btn ghost small" onClick={() => setStatus(t.status === 'starred' ? 'new' : 'starred')}>
            {t.status === 'starred' ? 'Unstar' : 'Star'}
          </button>
          <button className="btn ghost small" onClick={() => setStatus(t.status === 'archived' ? 'new' : 'archived')}>
            {t.status === 'archived' ? 'Restore' : 'Archive'}
          </button>
        </div>
      </div>

      <div className="preview" style={{ marginTop: 12 }}>
        <div className="label" style={{ marginBottom: 4 }}>Hook</div>
        {t.hook}
        <div className="subtle" style={{ marginTop: 6 }}>{t.angle}</div>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary>Why it sticks</summary>
        <div className="stick">
          {(['simple', 'unexpected', 'concrete', 'credible', 'emotional', 'story'] as const).map((k) => (
            <div key={k} style={{ opacity: t.stick[k] ? 1 : 0.45 }}>
              <b>{k}</b>
              {t.stick[k] || 'not used'}
            </div>
          ))}
        </div>
        <p className="subtle" style={{ marginBottom: 0 }}>{t.whyItWorks}</p>
      </details>

      <hr />
      <div className="row">
        <input type="text" value={steer} onChange={(e) => setSteer(e.target.value)} placeholder="Anything to add for the draft? (optional)" style={{ flex: 1, minWidth: 220 }} />
        {order.map((c, i) => {
          const busy = s.busy(`draft:${t.id}:${c}`);
          return (
            <button key={c} className={`btn ${i === 0 && t.channels.includes(c) ? 'dark' : ''}`} disabled={busy} onClick={() => write(c)}>
              {busy ? 'Writing…' : `Write for ${CHANNEL_NAME[c]}`}
            </button>
          );
        })}
      </div>
      {drafts.length > 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="subtle">Drafts:</span>
          {drafts.map((d) => (
            <button key={d.id} className="btn ghost small" onClick={() => s.go('drafts', d.id)}>
              {CHANNEL_NAME[d.channel]}{d.status === 'posted' ? ' (posted)' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
