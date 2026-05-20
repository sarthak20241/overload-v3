/**
 * Conversations — recent coach turns from coach_traces.
 *
 * The dashboard's "what is the coach actually doing" surface. Server-fetches
 * the last 500 turns ordered newest-first; ConversationsInteractive (client)
 * handles filters, search, and the detail panel.
 *
 * Each row exposes the trace's structured fields without giving up the
 * underlying user_id (we render a short hash so traffic patterns are
 * legible without revealing identifiers in a screenshot).
 */
import { getSupabaseServerClient } from '@/lib/supabase';
import { MessageSquare, AlertCircle } from 'lucide-react';
import { ConversationsInteractive, type CoachTrace } from './ConversationsInteractive';

export const dynamic = 'force-dynamic';

async function loadTraces(): Promise<{ traces: CoachTrace[]; error: string | null }> {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from('coach_traces')
      .select('id, request_at, user_id, status, http_status, error_message, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, latency_ms, message_count, has_user_context, retrieved_doc_ids, retrieval_status, citation_ids, tool_calls, last_user_message_preview, response_preview')
      .order('request_at', { ascending: false })
      .limit(500);
    if (error) return { traces: [], error: error.message };
    return {
      traces: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        request_at: String(r.request_at),
        user_id: r.user_id ? String(r.user_id) : null,
        status: String(r.status),
        http_status: Number(r.http_status ?? 0),
        error_message: r.error_message ? String(r.error_message) : null,
        model: r.model ? String(r.model) : null,
        input_tokens: r.input_tokens === null ? null : Number(r.input_tokens),
        output_tokens: r.output_tokens === null ? null : Number(r.output_tokens),
        cache_creation_input_tokens: r.cache_creation_input_tokens === null ? null : Number(r.cache_creation_input_tokens),
        cache_read_input_tokens: r.cache_read_input_tokens === null ? null : Number(r.cache_read_input_tokens),
        latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
        message_count: r.message_count === null ? null : Number(r.message_count),
        has_user_context: r.has_user_context === null ? null : Boolean(r.has_user_context),
        retrieved_doc_ids: Array.isArray(r.retrieved_doc_ids) ? r.retrieved_doc_ids as string[] : [],
        retrieval_status: r.retrieval_status ? String(r.retrieval_status) : null,
        citation_ids: Array.isArray(r.citation_ids) ? r.citation_ids as string[] : [],
        tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls as string[] : [],
        last_user_message_preview: r.last_user_message_preview ? String(r.last_user_message_preview) : null,
        response_preview: r.response_preview ? String(r.response_preview) : null,
      })),
      error: null,
    };
  } catch (e) {
    return { traces: [], error: String(e) };
  }
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; trace?: string }>;
}) {
  const sp = await searchParams;
  const { traces, error } = await loadTraces();
  return (
    <div className="flex flex-col h-screen">
      <div className="px-8 py-5 border-b border-border flex items-center gap-6">
        <div>
          <h1 className="text-xl font-semibold text-fg flex items-center gap-2">
            <MessageSquare size={18} />
            Conversations
          </h1>
          <p className="text-xs text-muted-fg mt-0.5">
            Recent coach turns · last 500 · newest first
          </p>
        </div>
      </div>
      {error && (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 flex items-center gap-2">
          <AlertCircle size={14} className="text-danger" />
          <span className="text-sm text-danger">Failed to load: {error}</span>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {traces.length === 0 && !error ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
            <MessageSquare size={36} className="text-text-muted" />
            <p className="text-lg text-fg font-medium">No coach turns yet</p>
            <p className="text-sm text-muted-fg text-center max-w-md">
              When users chat with the AI coach, every turn lands in
              <code className="px-1 py-0.5 rounded bg-card border border-border text-xs mx-1">coach_traces</code>
              and surfaces here for inspection.
            </p>
          </div>
        ) : (
          <ConversationsInteractive
            traces={traces}
            initialUserFilter={sp.user ?? null}
            initialSelectedId={sp.trace ?? null}
          />
        )}
      </div>
    </div>
  );
}
