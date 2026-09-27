'use client';

import { useEffect, useState } from 'react';
import type { StudioApi } from '@/app/page';
import { ago, api, CHANNEL_NAME } from '@/lib/client';
import { partLength, SPECS } from '@/lib/channels';
import { redditSubmitUrl } from '@/lib/publish/reddit';
import type { Channel, Draft } from '@/lib/types';

const QUICK = ['Shorter', 'Stronger first line', 'More concrete, add a specific detail', 'More personal', 'Less salesy', 'Make it a thread', 'Make it a single post'];

export default function DraftsView({ s }: { s: StudioApi }) {
  const drafts = s.state.drafts.filter((d) => d.status === 'draft');
  const [sel, setSel] = useState<string | null>(s.selectedDraft ?? drafts[0]?.id ?? null);
  const [channel, setChannel] = useState<Channel | 'all'>('all');

  useEffect(() => {
    if (s.selectedDraft) setSel(s.selectedDraft);
  }, [s.selectedDraft]);

  const list = drafts.filter((d) => channel === 'all' || d.channel === channel);
  const current = s.state.drafts.find((d) => d.id === sel) ?? list[0];

  return (
    <>
      <div className="head">
        <div>
          <h1>Drafts</h1>
          <p>Edit, rewrite with a note, then post. Nothing goes out until you confirm the exact text.</p>
        </div>
        <div className="row">
          {(['all', 'x', 'linkedin', 'reddit'] as const).map((c) => (
            <button key={c} className={`chip ${channel === c ? 'on' : ''}`} onClick={() => setChannel(c)}>
              {c === 'all' ? 'All' : CHANNEL_NAME[c]}
            </button>
          ))}
        </div>
      </div>

      {drafts.length === 0 && !current ? (
        <div className="empty">
          No drafts yet. Pick a topic in Ideas and press "Write for X", "LinkedIn" or "Reddit".
          <div style={{ marginTop: 12 }}><button className="btn" onClick={() => s.go('ideas')}>Go to Ideas</button></div>
        </div>
      ) : (
        <div className="split">
          <div className="list">
            {list.map((d) => (
              <button key={d.id} className={`item ${current?.id === d.id ? 'on' : ''}`} onClick={() => setSel(d.id)}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className={`tag ${d.channel}`}>{CHANNEL_NAME[d.channel]}</span>
                  <span className="subtle">{ago(d.updatedAt)}</span>
                </div>
                <div className="t">{d.topicTitle}</div>
                <div className="subtle" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.title || d.parts[0]}
                </div>
              </button>
            ))}
            {list.length === 0 && <div className="subtle">No open drafts for this channel.</div>}
          </div>
          {current ? <Editor key={`${current.id}:${current.updatedAt}`} d={current} s={s} /> : <div />}
        </div>
      )}
    </>
  );
}

function Editor({ d, s }: { d: Draft; s: StudioApi }) {
  const spec = SPECS[d.channel];
  const [parts, setParts] = useState(d.parts);
  const [title, setTitle] = useState(d.title ?? '');
  const [sub, setSub] = useState(d.subreddit ?? '');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty = JSON.stringify(parts) !== JSON.stringify(d.parts) || title !== (d.title ?? '') || sub !== (d.subreddit ?? '');
  const refining = s.busy(`refine:${d.id}`);
  const over = parts.some((p) => partLength(d.channel, p) > spec.limit) || (spec.titleLimit ? title.length > spec.titleLimit : false);
  const placeholders = parts.some((p) => /\[[^\]]+\](?!\()/.test(p)) || /\[[^\]]+\](?!\()/.test(title);
  const dashes = parts.some((p) => /[–—]/.test(p));

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setErr(null);
    try {
      await api('/api/drafts', 'PUT', { id: d.id, parts: parts.filter((p) => p.trim()), title: d.channel === 'reddit' ? title : undefined, subreddit: d.channel === 'reddit' ? sub : undefined });
      await s.reload();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const refine = async (instruction: string) => {
    // A rewrite of the old server text would throw away the unsaved edits.
    if (dirty && !(await save())) return;
    s.run('/api/drafts/refine', { draftId: d.id, instruction }, { key: `refine:${d.id}`, label: `Rewriting: ${instruction.slice(0, 40)}` });
    setNote('');
  };

  const applyHook = (h: string) => {
    const [first, ...rest] = parts[0].split('\n');
    void first;
    setParts([[h, ...rest].join('\n'), ...parts.slice(1)]);
  };

  const remove = async () => {
    if (!window.confirm('Delete this draft?')) return;
    await api('/api/drafts', 'DELETE', { id: d.id });
    s.reload();
  };

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <div>
          <div className="row"><span className={`tag ${d.channel}`}>{spec.name}</span><span className="subtle">from “{d.topicTitle}”</span></div>
        </div>
        <button className="btn ghost small danger" onClick={remove}>Delete</button>
      </div>

      {d.channel === 'reddit' && (
        <div className="stack" style={{ marginBottom: 12 }}>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Subreddit</div>
            <input type="text" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="r/SideProject" />
          </div>
          <div>
            <div className="spread" style={{ marginBottom: 6 }}>
              <span className="label">Title</span>
              <span className={`counter ${title.length > (spec.titleLimit ?? 300) ? 'over' : ''}`}>{title.length}/{spec.titleLimit}</span>
            </div>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
      )}

      <div className="stack">
        {parts.map((p, i) => {
          const len = partLength(d.channel, p);
          return (
            <div key={i}>
              <div className="spread" style={{ marginBottom: 6 }}>
                <span className="label">{d.channel === 'x' ? (parts.length > 1 ? `Post ${i + 1} of ${parts.length}` : 'Post') : d.channel === 'reddit' ? 'Body' : 'Post'}</span>
                <span className="row">
                  {spec.fold && <span className="counter">first {spec.fold} show before “see more”</span>}
                  <span className={`counter ${len > spec.limit ? 'over' : ''}`}>{len}/{spec.limit}</span>
                  {d.channel === 'x' && parts.length > 1 && (
                    <button className="btn ghost small" onClick={() => setParts(parts.filter((_, j) => j !== i))}>Remove</button>
                  )}
                </span>
              </div>
              <textarea
                rows={d.channel === 'x' ? 4 : 14}
                value={p}
                onChange={(e) => setParts(parts.map((x, j) => (j === i ? e.target.value : x)))}
              />
            </div>
          );
        })}
        {d.channel === 'x' && (
          <div><button className="btn ghost small" onClick={() => setParts([...parts, ''])}>+ Add a post to the thread</button></div>
        )}
      </div>

      {(placeholders || dashes) && (
        <div className="error" style={{ marginTop: 12 }}>
          {placeholders && 'Fill in the [bracketed] parts with your real details before posting. '}
          {dashes && 'There is an em dash in the text. Replace it before posting.'}
        </div>
      )}
      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn dark" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : dirty ? 'Save edits' : 'Saved'}</button>
        {dirty && <button className="btn ghost" onClick={() => { setParts(d.parts); setTitle(d.title ?? ''); setSub(d.subreddit ?? ''); }}>Undo edits</button>}
      </div>

      <hr />
      <div className="label" style={{ marginBottom: 8 }}>Rewrite with a note</div>
      <div className="row" style={{ marginBottom: 8 }}>
        {QUICK.filter((q) => d.channel === 'x' || !q.includes('thread') && !q.includes('single')).map((q) => (
          <button key={q} className="chip" disabled={refining} onClick={() => refine(q)}>{q}</button>
        ))}
      </div>
      <div className="row">
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell it what to change" style={{ flex: 1, minWidth: 220 }}
          onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) refine(note); }} />
        <button className="btn" disabled={!note.trim() || refining} onClick={() => refine(note)}>{refining ? 'Rewriting…' : 'Rewrite'}</button>
      </div>

      <hr />
      <div className="spread" style={{ marginBottom: 8 }}>
        <span className="label">Sticky score</span>
        <span className="row">
          {(['simple', 'unexpected', 'concrete', 'credible', 'emotional', 'story'] as const).map((k) => (
            <span key={k} title={`${k}: ${d.scores[k] ?? 0}/2`} className="row" style={{ gap: 4 }}>
              <span className="subtle" style={{ fontSize: 11 }}>{k[0].toUpperCase()}</span>
              <span className="score"><i className={`s${d.scores[k] ?? 0}`} /></span>
            </span>
          ))}
        </span>
      </div>
      <p className="muted" style={{ margin: 0 }}>{d.rationale}</p>
      {d.altHooks.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary>Other first lines to try</summary>
          <div className="stack">
            {d.altHooks.map((h, i) => (
              <div key={i} className="spread preview">
                <span style={{ flex: 1 }}>{h}</span>
                <button className="btn small" onClick={() => applyHook(h)}>Use</button>
              </div>
            ))}
          </div>
        </details>
      )}
      {d.history.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary>Earlier versions ({d.history.length})</summary>
          <div className="stack">
            {d.history.map((h, i) => (
              <div key={i} className="preview">
                <div className="spread"><span className="subtle">{h.note ? `Before: ${h.note}` : ''} · {ago(h.at)}</span>
                  <button className="btn small" onClick={() => { setParts(h.parts); if (h.title) setTitle(h.title); }}>Restore</button></div>
                <pre className="post subtle">{h.parts.join('\n\n---\n\n').slice(0, 600)}</pre>
              </div>
            ))}
          </div>
        </details>
      )}

      <hr />
      <Publish d={d} s={s} blocked={dirty ? 'Save your edits first.' : over ? 'Something is over the character limit.' : placeholders ? 'Fill in the [bracketed] parts first.' : dashes ? 'Remove the em dash first.' : null}
        confirm={confirm} setConfirm={setConfirm} />
    </div>
  );
}

function Publish({ d, s, blocked, confirm, setConfirm }: { d: Draft; s: StudioApi; blocked: string | null; confirm: boolean; setConfirm: (v: boolean) => void }) {
  const st = s.state.status;
  const [community, setCommunity] = useState(false);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [opened, setOpened] = useState(false);

  const canApi = d.channel === 'x' ? st.x : d.channel === 'linkedin' ? st.linkedinConnected : false;
  const hasLink = d.parts.some((p) => /https?:\/\/\S+/.test(p));
  const cost = d.parts.reduce((sum, p) => sum + (/https?:\/\/\S+/.test(p) ? 0.2 : 0.015), 0);

  const post = async () => {
    setPosting(true);
    setErr(null);
    try {
      await api('/api/publish', 'POST', { draftId: d.id, action: 'post', community });
      setConfirm(false);
      await s.reload();
      s.go('posted');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPosting(false);
    }
  };

  const mark = async () => {
    await api('/api/publish', 'POST', { draftId: d.id, action: 'mark', url: manualUrl });
    await s.reload();
    s.go('posted');
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked; the text is still on screen */ }
  };

  const openManual = async () => {
    const text = d.parts.join('\n\n');
    let url: string;
    if (d.channel === 'reddit') {
      await copy(d.parts[0]);
      url = redditSubmitUrl(d.subreddit ?? '', d.title ?? '', d.parts[0]);
    } else if (d.channel === 'linkedin') {
      await copy(text);
      url = `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`;
    } else {
      await copy(d.parts.slice(1).join('\n\n'));
      url = `https://x.com/intent/post?text=${encodeURIComponent(d.parts[0])}`;
    }
    window.open(url, '_blank', 'noopener');
    setOpened(true);
  };

  return (
    <div>
      <div className="label" style={{ marginBottom: 8 }}>Publish</div>
      {blocked && <div className="subtle" style={{ marginBottom: 8 }}>{blocked}</div>}

      <div className="row">
        {d.channel !== 'reddit' && (
          <button className="btn primary" disabled={!!blocked || !canApi} onClick={() => setConfirm(true)}>
            Post to {CHANNEL_NAME[d.channel]} now
          </button>
        )}
        <button className="btn" disabled={!!blocked} onClick={openManual}>
          {d.channel === 'reddit' ? 'Open Reddit, filled in' : `Open ${CHANNEL_NAME[d.channel]} and post it yourself`}
        </button>
      </div>

      <div className="subtle" style={{ marginTop: 8 }}>
        {d.channel === 'x' && (st.x
          ? `Posting from here uses your X API credit: about $${cost.toFixed(3)} for ${d.parts.length} post${d.parts.length > 1 ? 's' : ''}${hasLink ? ' (a post with a link costs $0.20)' : ''}. The free button opens X with the first post filled in and copies the rest.`
          : 'Add your X keys in Setup to post from here. The free button opens X with the first post filled in and copies the rest of the thread.')}
        {d.channel === 'linkedin' && (st.linkedinConnected
          ? `Posting as ${st.linkedinName ?? 'you'}.`
          : 'Connect LinkedIn in Setup to post from here. The other button opens LinkedIn and copies the text.')}
        {d.channel === 'reddit' && 'Reddit bans accounts that post by bot, so you press Post yourself. The body is copied too, in case Reddit does not fill it in.'}
      </div>

      {opened && (
        <div className="row" style={{ marginTop: 12 }}>
          <input type="url" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="Paste the post link (optional)" style={{ flex: 1, minWidth: 220 }} />
          <button className="btn dark" onClick={mark}>I posted it</button>
        </div>
      )}

      {confirm && (
        <div className="veil" onClick={() => !posting && setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p className="h2" style={{ marginBottom: 4 }}>Post this to {CHANNEL_NAME[d.channel]}?</p>
            <p className="subtle" style={{ marginTop: 0 }}>It goes live right away and is public.</p>
            {d.parts.map((p, i) => <div key={i} className="preview"><pre className="post">{p}</pre></div>)}
            {d.channel === 'x' && st.xCommunity && (
              <label className="row" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={community} onChange={(e) => setCommunity(e.target.checked)} />
                Post into your X Community instead of to everyone
              </label>
            )}
            {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setConfirm(false)} disabled={posting}>Cancel</button>
              <button className="btn primary" onClick={post} disabled={posting}>{posting ? 'Posting…' : 'Post now'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
