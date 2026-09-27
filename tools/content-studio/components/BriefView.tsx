'use client';

import { useState } from 'react';
import type { StudioApi } from '@/app/page';
import { ago, api } from '@/lib/client';
import type { BriefSection } from '@/lib/types';

export default function BriefView({ s }: { s: StudioApi }) {
  const [sections, setSections] = useState<BriefSection[]>(s.state.brief.sections);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(sections) !== JSON.stringify(s.state.brief.sections);
  const neverSaved = new Date(s.state.brief.updatedAt).getTime() === 0;

  const save = async () => {
    setSaving(true);
    await api('/api/brief', 'PUT', { sections });
    await s.reload();
    setSaving(false);
    setSaved(true);
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>Brief</h1>
          <p>Everything the writer knows about Overload and about you. It never invents facts, so the more real detail you put here, especially in your story, the better the posts get.</p>
        </div>
        <div className="row">
          <span className="subtle">{neverSaved ? 'Starting draft, not saved yet' : `Saved ${ago(s.state.brief.updatedAt)}`}</span>
          <button className="btn primary" onClick={save} disabled={(!dirty && !neverSaved) || saving}>{saving ? 'Saving…' : 'Save brief'}</button>
        </div>
      </div>
      {saved && !dirty && <div className="okbox" style={{ marginBottom: 12 }}>Saved. New ideas and drafts will use it.</div>}

      <div className="stack">
        {sections.map((sec, i) => (
          <div className="card" key={sec.key}>
            <div className="spread" style={{ marginBottom: 8 }}>
              <p className="h2">{sec.label}</p>
              <span className="subtle">{sec.hint}</span>
            </div>
            <textarea
              rows={Math.min(12, Math.max(3, sec.text.split('\n').length + 1))}
              value={sec.text}
              onChange={(e) => { setSaved(false); setSections(sections.map((x, j) => (j === i ? { ...x, text: e.target.value } : x))); }}
            />
          </div>
        ))}

        <div className="card">
          <div className="spread" style={{ marginBottom: 8 }}>
            <p className="h2">Recent work (read automatically)</p>
            <span className="subtle">Commits on main from the last 3 weeks</span>
          </div>
          {s.state.recentWork.length ? (
            <ul className="clean" style={{ maxHeight: 260, overflow: 'auto' }}>
              {s.state.recentWork.map((w, i) => <li key={i} className="muted">{w}</li>)}
            </ul>
          ) : (
            <p className="muted">No commits found at {s.state.status.repo}. Set OVERLOAD_REPO in .env.local.</p>
          )}
          <p className="subtle" style={{ marginBottom: 0 }}>FEATURES.md from the same repo is read on every run too.</p>
        </div>
      </div>
    </>
  );
}
