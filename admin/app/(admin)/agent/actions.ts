/**
 * Server actions for the Agent Activity page.
 *
 * The auto-review agent's decisions are auditable + revertable. When a
 * human reverts, the agent_review_log row is marked reverted_at + the
 * underlying research_kb_pending row goes back to review_status='pending'
 * so the queue picks it up again.
 *
 * If the agent's action was 'supersede', the supersede needs to be
 * unwound too — the revert_agent_decision RPC handles that server-side
 * by calling unsupersede_kb for each id in superseded_kb_ids.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase';
import { isAdmin } from '@/lib/admin-check';

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function revertAgentDecision(logId: string): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc('revert_agent_decision', {
    p_log_id: logId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/agent');
  revalidatePath('/queue');
  revalidatePath('/kb');
  revalidatePath('/stats');
  return { ok: true, message: 'Reverted — paper is back in pending queue' };
}
