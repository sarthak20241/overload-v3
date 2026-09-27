'use client';

import type { StudioApi } from '@/app/page';
import { ago, CHANNEL_NAME } from '@/lib/client';

export default function PostedView({ s }: { s: StudioApi }) {
  const posted = s.state.drafts
    .filter((d) => d.status === 'posted')
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));

  return (
    <>
      <div className="head">
        <div>
          <h1>Posted</h1>
          <p>Everything that went out, newest first.</p>
        </div>
      </div>
      {posted.length === 0 ? (
        <div className="empty">Nothing posted yet.</div>
      ) : (
        <div className="stack">
          {posted.map((d) => (
            <div className="card" key={d.id}>
              <div className="spread">
                <div className="row">
                  <span className={`tag ${d.channel}`}>{CHANNEL_NAME[d.channel]}</span>
                  {d.subreddit && <span className="subtle">{d.subreddit}</span>}
                  <span className="subtle">{ago(d.postedAt)}</span>
                </div>
                {d.postedUrl && <a className="btn small" href={d.postedUrl} target="_blank" rel="noreferrer">Open post</a>}
              </div>
              {d.title && <p className="h2" style={{ marginTop: 10 }}>{d.title}</p>}
              <pre className="post muted" style={{ marginTop: 8 }}>{d.parts.join('\n\n').slice(0, 500)}{d.parts.join('').length > 500 ? '…' : ''}</pre>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
