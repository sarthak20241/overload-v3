'use client';

import { useEffect, useState } from 'react';
import type { StudioApi } from '@/app/page';
import { api } from '@/lib/client';

export default function SetupView({ s }: { s: StudioApi }) {
  const st = s.state.status;
  const [flash, setFlash] = useState<{ ok?: string; error?: string }>({});

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setFlash({ ok: q.get('ok') ?? undefined, error: q.get('error') ?? undefined });
  }, []);

  const days = st.linkedinExpiresAt ? Math.max(0, Math.round((st.linkedinExpiresAt - Date.now()) / 86_400_000)) : 0;

  return (
    <>
      <div className="head">
        <div>
          <h1>Setup</h1>
          <p>Keys live in <code>tools/content-studio/.env.local</code> on this Mac. Restart the studio after you change that file.</p>
        </div>
      </div>

      {flash.ok === 'linkedin' && <div className="okbox" style={{ marginBottom: 12 }}>LinkedIn is connected.</div>}
      {flash.error && <div className="error" style={{ marginBottom: 12 }}>{flash.error === 'linkedin-keys' ? 'Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to .env.local first.' : flash.error}</div>}

      <div className="stack">
        <Row ok title="Writer" state={`${st.provider === 'codex' ? 'ChatGPT' : 'Claude'}, model ${st.model}`}>
          <p style={{ marginTop: 0 }}>Uses your subscription login, not an API key.</p>
          <div className="row">
            {(['claude', 'codex'] as const).map((p) => (
              <button key={p} className={`chip ${st.provider === p ? 'on' : ''}`}
                onClick={async () => { await api('/api/settings', 'PUT', { provider: p }); s.reload(); }}>
                {p === 'claude' ? 'Claude' : 'ChatGPT'}
              </button>
            ))}
            <label className="row" style={{ marginLeft: 8 }}>
              <input type="checkbox" checked={st.fallback}
                onChange={async (e) => { await api('/api/settings', 'PUT', { fallback: e.target.checked }); s.reload(); }} />
              If one hits its usage limit, use the other
            </label>
          </div>
          <p className="subtle" style={{ marginBottom: 0 }}>
            ChatGPT runs through codex at <code>{st.codexBin}</code>{st.codexLoggedIn ? ', logged in.' : '. Not logged in: open the ChatGPT app and sign in to Codex once.'}
          </p>
        </Row>

        <Row ok={st.x} title="X" state={st.x ? `Keys found${st.xCommunity ? ', community set' : ''}` : 'Not set up, posts open in X for you to send'}>
          <ol className="clean">
            <li>Go to developer.x.com and create a project and an app. X now bills per post from prepaid credit (about $0.015 a post, $0.20 with a link). Add a few dollars.</li>
            <li>In the app settings, set permissions to <b>Read and write</b>.</li>
            <li>Under Keys and tokens, copy the API key and secret, then generate the Access token and secret (after the permission change).</li>
            <li>Put them in <code>X_API_KEY</code>, <code>X_API_SECRET</code>, <code>X_ACCESS_TOKEN</code>, <code>X_ACCESS_SECRET</code>.</li>
            <li>Optional: <code>X_COMMUNITY_ID</code> = the number in the Build in Public community link (x.com/i/communities/NUMBER).</li>
          </ol>
        </Row>

        <Row ok={st.linkedinConnected} title="LinkedIn"
          state={st.linkedinConnected ? `Connected as ${st.linkedinName ?? 'you'}, ${days} days left` : st.linkedin ? 'Keys found, not connected yet' : 'Not set up, posts open in LinkedIn for you to send'}>
          <ol className="clean">
            <li>Go to linkedin.com/developers and create an app. It must be linked to a LinkedIn Page; you can create one in the form.</li>
            <li>Under Products, add <b>Share on LinkedIn</b> and <b>Sign In with LinkedIn using OpenID Connect</b>.</li>
            <li>Under Auth, add this redirect URL: <code>http://localhost:4747/api/auth/linkedin/callback</code></li>
            <li>Put the Client ID and secret in <code>LINKEDIN_CLIENT_ID</code> and <code>LINKEDIN_CLIENT_SECRET</code>, restart, then press Connect.</li>
            <li>The login lasts 60 days. The studio tells you when to connect again.</li>
          </ol>
          {st.linkedin && (
            <a className="btn dark" href="/api/auth/linkedin/start" style={{ marginTop: 8 }}>{st.linkedinConnected ? 'Reconnect LinkedIn' : 'Connect LinkedIn'}</a>
          )}
        </Row>

        <Row ok title="Reddit" state="You press Post yourself">
          Reddit stopped giving API access to new personal apps in November 2025, and accounts that post by bot get shadowbanned. The studio writes the post, opens the right subreddit with the title filled in, and copies the body. You check the subreddit rules and press Post.
        </Row>
      </div>
    </>
  );
}

function Row({ ok, title, state, children }: { ok: boolean; title: string; state: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 8 }}>
        <div className="row"><span className={`dot ${ok ? 'ok' : ''}`} /><p className="h2">{title}</p></div>
        <span className="subtle">{state}</span>
      </div>
      <div className="muted">{children}</div>
    </div>
  );
}
