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
