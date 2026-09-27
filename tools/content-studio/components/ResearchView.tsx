'use client';

import type { StudioApi } from '@/app/page';
import { ago, CHANNEL_NAME } from '@/lib/client';
import { CHANNELS, type Channel, type Playbook } from '@/lib/types';

export default function ResearchView({ s }: { s: StudioApi }) {
  const research = (c: Channel) =>
    s.run('/api/research', { channel: c }, { key: `research:${c}`, label: `Researching ${CHANNEL_NAME[c]}` });

  return (
    <>
      <div className="head">
        <div>
          <h1>Research</h1>
          <p>The studio searches the web for what works on each channel right now: how the feed ranks posts, which formats and first lines win, and the rules that get accounts banned. Every idea and draft uses it. Run it again every few weeks.</p>
        </div>
        <button className="btn primary" disabled={CHANNELS.some((c) => s.busy(`research:${c}`))}
          onClick={() => CHANNELS.forEach((c) => research(c))}>Research all three</button>
      </div>

      <div className="stack">
        {CHANNELS.map((c) => (
          <ChannelCard key={c} c={c} p={s.state.playbooks[c]} busy={s.busy(`research:${c}`)} onRun={() => research(c)} />
        ))}
      </div>
    </>
  );
}

function ChannelCard({ c, p, busy, onRun }: { c: Channel; p?: Playbook; busy: boolean; onRun: () => void }) {
  return (
    <div className="card">
      <div className="spread">
        <div className="row">
          <p className="h2">{CHANNEL_NAME[c]}</p>
          <span className="subtle">{p ? `Researched ${ago(p.updatedAt)}` : 'Not researched yet'}</span>
        </div>
        <button className="btn" onClick={onRun} disabled={busy}>{busy ? 'Researching…' : p ? 'Research again' : 'Research now'}</button>
      </div>
      {p && (
        <>
          <p style={{ marginBottom: 0 }}>{p.summary}</p>
          <div className="grid3" style={{ marginTop: 14 }}>
            <Block title="Do" items={p.doList} />
            <Block title="Don't" items={p.dontList} />
            <Block title="First lines that work" items={p.hooks} />
          </div>
          <details style={{ marginTop: 14 }}>
            <summary>Formats, length, cadence, communities, sources</summary>
            <div className="stack">
              <div>
                <div className="label">How the feed works now</div>
                <ul className="clean">{p.algorithm.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
              <div>
                <div className="label">Formats</div>
                <ul className="clean">{p.formats.map((f, i) => <li key={i}><b>{f.name}</b>: {f.why} <span className="subtle">Pattern: {f.pattern}</span></li>)}</ul>
              </div>
              <div><div className="label">Length</div><p style={{ margin: '4px 0 0' }}>{p.length}</p></div>
              <div><div className="label">Cadence</div><p style={{ margin: '4px 0 0' }}>{p.cadence}</p></div>
              {p.communities.length > 0 && (
                <div>
                  <div className="label">Communities</div>
                  <ul className="clean">{p.communities.map((m, i) => <li key={i}><b>{m.name}</b>: {m.fit} <span className="subtle">Rules: {m.rules}</span></li>)}</ul>
                </div>
              )}
              {p.examples.length > 0 && (
                <div>
                  <div className="label">What top posts did</div>
                  <ul className="clean">{p.examples.map((e, i) => <li key={i}>{e.pattern} <span className="subtle">{e.why}</span></li>)}</ul>
                </div>
              )}
              <div>
                <div className="label">Sources</div>
                <ul className="clean">{p.sources.map((src, i) => <li key={i}><a href={src.url} target="_blank" rel="noreferrer">{src.title || src.url}</a></li>)}</ul>
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function Block({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="label">{title}</div>
      <ul className="clean">{items.slice(0, 6).map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}
