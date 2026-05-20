/**
 * Agent Activity — auditable view of every auto-review-agent decision.
 *
 * Server-fetches the last N decisions; the client component handles
 * filtering (smart "needs spot-check" filter for agent approves below a
 * confidence threshold, "downgrades only" for cases where guardrails
 * fired) and the per-row Revert button.
 *
 * Each row shows:
 *   - Action chip (color-coded approve / reject / supersede / coexist)
 *   - Paper title + timestamp
 *   - Agent's rationale (expandable)
 *   - Flag pills (off_topic, small_n, animal_study, …)
 *   - Confidence
 *   - "Downgraded by guardrail" badge if final_action != proposed_action
 *   - Revert button (disabled if already reverted)
 */
import { getSupabaseServerClient } from '@/lib/supabase';
import type { AgentReviewLog } from '@/lib/types';
import { AgentInteractive } from './AgentInteractive';
import { AlertCircle, Bot } from 'lucide-react';

export const dynamic = 'force-dynamic';

async function loadAgentLog(): Promise<{ rows: AgentReviewLog[]; error: string | null }> {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from('agent_review_log')
      .select('id, pending_id, paper_url, paper_title, proposed_action, final_action, downgrade_reason, confidence, rationale, flags, superseded_kb_ids, decided_at, reverted_at, reverted_by')
      .order('decided_at', { ascending: false })
      .limit(200);
    if (error) return { rows: [], error: error.message };
    const rows = (data ?? []).map((r) => ({
      ...r,
      confidence: Number(r.confidence),
    })) as AgentReviewLog[];
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: String(e) };
  }
}

export default async function AgentPage() {
  const { rows, error } = await loadAgentLog();

  // Stats for the header
  const last7d = rows.filter((r) => {
    const ageMs = Date.now() - new Date(r.decided_at).getTime();
    return ageMs < 7 * 24 * 60 * 60 * 1000;
  });
  const approves = last7d.filter((r) => r.final_action === 'approve').length;
  const rejects = last7d.filter((r) => r.final_action === 'reject').length;
  const supersedes = last7d.filter((r) => r.final_action === 'supersede').length;
  const coexists = last7d.filter((r) => r.final_action === 'coexist').length;
  const downgrades = last7d.filter((r) => r.downgrade_reason !== null).length;
  const reverts = last7d.filter((r) => r.reverted_at !== null).length;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="px-8 py-5 border-b border-border flex items-center gap-6">
        <div>
          <h1 className="text-xl font-semibold text-fg flex items-center gap-2">
            <Bot size={18} />
            Agent Activity
          </h1>
          <p className="text-xs text-muted-fg mt-0.5">
            Auto-review agent decisions — last 200, newest first
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StatPill label="Last 7d" value={last7d.length} />
          <StatPill label="Approves" value={approves} accent="primary" />
          <StatPill label="Rejects" value={rejects} accent="danger" />
          <StatPill label="Supersedes" value={supersedes} accent="warning" />
          <StatPill label="Coexists" value={coexists} />
          {downgrades > 0 && (
            <StatPill label="Guardrail downgrades" value={downgrades} accent="warning" />
          )}
          {reverts > 0 && (
            <StatPill label="Reverted" value={reverts} accent="danger" />
          )}
        </div>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger" />
          <span className="text-sm text-danger">Failed to load: {error}</span>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {rows.length === 0 && !error ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 p-8">
            <Bot size={36} className="text-text-muted" />
            <div>
              <p className="text-lg text-fg font-medium">No agent activity yet</p>
              <p className="text-sm text-muted-fg mt-1 max-w-md">
                The auto-review agent runs nightly. When papers sit in the
                queue past the 24h threshold, the agent reviews them and
                logs every decision here. Until then, this page is empty.
              </p>
            </div>
          </div>
        ) : (
          <AgentInteractive rows={rows} />
        )}
      </div>
    </div>
  );
}

function StatPill({
  label, value, accent,
}: { label: string; value: number; accent?: 'primary' | 'danger' | 'warning' }) {
  const palette =
    accent === 'primary' ? 'bg-primary-subtle border-primary-muted text-primary' :
    accent === 'danger'  ? 'bg-danger/10  border-danger/30   text-danger'  :
    accent === 'warning' ? 'bg-warning/10 border-warning/30  text-warning' :
                           'bg-card       border-border      text-fg';
  return (
    <div className={'px-3 py-1.5 rounded-md border ' + palette}>
      <div className="text-[10px] opacity-80 uppercase tracking-wider">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
