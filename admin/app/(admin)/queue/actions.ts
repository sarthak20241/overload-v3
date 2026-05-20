/**
 * Server actions for the review queue.
 *
 * Both `approvePending` and `rejectPending` call SECURITY DEFINER RPCs that
 * re-verify is_admin() server-side, so even if a non-admin somehow invokes
 * the action, the database rejects. After mutating, we `revalidatePath` to
 * refresh the queue list on the client.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase';
import { isAdmin } from '@/lib/admin-check';

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function approvePending(pendingId: string): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc('promote_pending_to_kb', {
    p_pending_id: pendingId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/queue');
  revalidatePath('/kb');
  revalidatePath('/stats');
  return { ok: true, message: 'Promoted to research_kb' };
}

/**
 * Phase 3 approve + supersede in one atomic-from-the-UI step.
 *
 * Flow when the reviewer toggled "Replace this in KB" on one or more
 * contradiction flags:
 *   1. promote_pending_to_kb(pending_id) → returns the new kb row's UUID
 *   2. For each toggled kb_id: supersede_kb(toggled_id, new_id, reviewer)
 *
 * Each supersede call is server-side guardrailed (rank monotonicity,
 * preprint-can't-supersede-peer-reviewed, journal tier, sample-size
 * floor — see migration 0021/0022). If guardrails reject a particular
 * supersede we collect the error in `partial_errors` but DON'T roll back
 * the approve — the new paper is still in KB and worth having, just the
 * specific supersede didn't go through.
 */
export async function approvePendingWithSupersede(
  pendingId: string,
  supersedeKbIds: string[],
): Promise<ActionResult & { partial_errors?: string[] }> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = await getSupabaseServerClient();

  // Step 1: promote
  const { data: newId, error: promoteErr } = await supabase.rpc('promote_pending_to_kb', {
    p_pending_id: pendingId,
  });
  if (promoteErr) return { ok: false, error: promoteErr.message };

  // Step 2: supersede each toggled kb_id. Collect failures; don't abort.
  const partial_errors: string[] = [];
  for (const kbId of supersedeKbIds) {
    const { error: supErr } = await supabase.rpc('supersede_kb', {
      p_superseded_id: kbId,
      p_by_id: newId,
      p_reviewer: null, // null → server uses auth.jwt()->>'sub'
    });
    if (supErr) {
      partial_errors.push(`${kbId.slice(0, 8)}…: ${supErr.message}`);
    }
  }

  revalidatePath('/queue');
  revalidatePath('/kb');
  revalidatePath('/stats');
  revalidatePath('/agent');

  const successfulSupersedes = supersedeKbIds.length - partial_errors.length;
  let message: string;
  if (supersedeKbIds.length === 0) {
    message = 'Promoted to research_kb';
  } else if (partial_errors.length === 0) {
    message = `Promoted + superseded ${successfulSupersedes} entr${successfulSupersedes === 1 ? 'y' : 'ies'}`;
  } else {
    message = `Promoted, ${successfulSupersedes}/${supersedeKbIds.length} supersedes succeeded`;
  }

  return {
    ok: true,
    message,
    ...(partial_errors.length > 0 ? { partial_errors } : {}),
  };
}

export async function rejectPending(
  pendingId: string,
  reason: string,
): Promise<ActionResult> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc('reject_pending', {
    p_pending_id: pendingId,
    p_reason: reason || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/queue');
  revalidatePath('/stats');
  return { ok: true, message: 'Rejected' };
}
