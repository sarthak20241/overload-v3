/**
 * Users — per-user coach activity aggregate. Pulls 1000 most recent
 * coach_traces rows and aggregates client-side; powers "who's actually
 * using the coach and how" plus power-user discovery.
 *
 * For each Clerk user with at least one turn we surface:
 *   - turn count
 *   - last seen
 *   - total tokens (input + output)
 *   - error rate
 *   - avg latency
 *   - avg citations per turn
 *
 * Click a row → list of their recent turns (links into /conversations
 * with user filter pre-applied).
 */
import Link from 'next/link';
import { getSupabaseServerClient } from '@/lib/supabase';
import { Users, AlertCircle, ArrowUpRight } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface UserAggregate {
  user_id: string;
  turn_count: number;
  error_count: number;
  last_seen: string;
  first_seen: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_latency_ms: number;
  total_citations: number;
  retrieval_misses: number;
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function loadUsers(): Promise<{ users: UserAggregate[]; error: string | null; sampleSize: number }> {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from('coach_traces')
      .select('user_id, request_at, status, input_tokens, output_tokens, latency_ms, citation_ids, retrieval_status')
      .order('request_at', { ascending: false })
      .limit(1000);
    if (error) return { users: [], error: error.message, sampleSize: 0 };

    const m = new Map<string, UserAggregate>();
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const uid = row.user_id ? String(row.user_id) : null;
      if (!uid) continue;
      const isError = row.status !== 'success';
      const reqAt = String(row.request_at);
      const existing = m.get(uid);
      const citations = Array.isArray(row.citation_ids) ? row.citation_ids.length : 0;
      const missedRetrieval = row.retrieval_status === 'no_matches';
      if (existing) {
        existing.turn_count += 1;
        if (isError) existing.error_count += 1;
        if (reqAt > existing.last_seen)  existing.last_seen  = reqAt;
        if (reqAt < existing.first_seen) existing.first_seen = reqAt;
        existing.total_input_tokens  += Number(row.input_tokens  ?? 0);
        existing.total_output_tokens += Number(row.output_tokens ?? 0);
        existing.total_latency_ms    += Number(row.latency_ms    ?? 0);
        existing.total_citations     += citations;
        if (missedRetrieval) existing.retrieval_misses += 1;
      } else {
        m.set(uid, {
          user_id: uid,
          turn_count: 1,
          error_count: isError ? 1 : 0,
          last_seen: reqAt,
          first_seen: reqAt,
          total_input_tokens:  Number(row.input_tokens  ?? 0),
          total_output_tokens: Number(row.output_tokens ?? 0),
          total_latency_ms:    Number(row.latency_ms    ?? 0),
          total_citations:     citations,
          retrieval_misses:    missedRetrieval ? 1 : 0,
        });
      }
    }

    const users = [...m.values()].sort((a, b) => b.turn_count - a.turn_count);
    return { users, error: null, sampleSize: (data ?? []).length };
  } catch (e) {
    return { users: [], error: String(e), sampleSize: 0 };
  }
}

export default async function UsersPage() {
  const { users, error, sampleSize } = await loadUsers();

  return (
    <div className="h-screen overflow-y-auto">
      <div className="px-8 py-5 border-b border-border">
        <h1 className="text-xl font-semibold text-fg flex items-center gap-2">
          <Users size={18} />
          Users
        </h1>
        <p className="text-xs text-muted-fg mt-0.5">
          {users.length} active users (last {sampleSize} turns sampled)
        </p>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger" />
          <span className="text-sm text-danger">Failed to load: {error}</span>
        </div>
      )}

      <div className="px-8 py-6">
        {users.length === 0 && !error ? (
          <div className="rounded-lg border border-border bg-card p-12 text-center">
            <Users size={36} className="text-text-muted mx-auto mb-3" />
            <p className="text-fg font-medium">No coach users yet</p>
            <p className="text-sm text-muted-fg mt-1">
              Once people start chatting with the coach, this page surfaces
              their activity and patterns.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated border-b border-border">
                <tr className="text-left">
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">User</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Turns</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Errors</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Avg latency</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Avg citations</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Retrieval misses</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide text-right">Tokens</th>
                  <th className="px-4 py-2.5 text-text-muted font-semibold text-xs uppercase tracking-wide">Last seen</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const avgLatencyMs = u.turn_count > 0 ? u.total_latency_ms / u.turn_count : 0;
                  const avgCitations = u.turn_count > 0 ? u.total_citations  / u.turn_count : 0;
                  const errorRate    = u.turn_count > 0 ? u.error_count      / u.turn_count : 0;
                  const tokens       = u.total_input_tokens + u.total_output_tokens;
                  return (
                    <tr key={u.user_id} className="border-b border-border last:border-b-0 hover:bg-card-hover">
                      <td className="px-4 py-2.5 text-fg font-mono text-xs" title={u.user_id}>
                        {u.user_id.slice(0, 14)}…
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-fg font-semibold">{u.turn_count}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <span className={errorRate > 0.1 ? 'text-danger' : 'text-muted-fg'}>
                          {u.error_count}
                          {errorRate > 0.05 ? ` (${(errorRate * 100).toFixed(0)}%)` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-fg">
                        {(avgLatencyMs / 1000).toFixed(1)}s
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-fg">
                        {avgCitations.toFixed(1)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <span className={u.retrieval_misses > 0 ? 'text-warning' : 'text-muted-fg'}>
                          {u.retrieval_misses}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-fg">
                        {tokens.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-muted-fg text-xs">{timeSince(u.last_seen)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/conversations?user=${u.user_id.slice(-5)}`}
                          className="text-primary hover:underline text-xs flex items-center justify-end gap-0.5"
                          title="Open this user's conversations"
                        >
                          View <ArrowUpRight size={11} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
