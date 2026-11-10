'use server';
/**
 * Android coupons: server codes (invite_codes, source 'campaign'), made and
 * listed through admin-only database functions (migration 20261110150000).
 * The app redeems them on Android and web as server trial days. Google Play
 * is not involved.
 */
import { revalidatePath } from 'next/cache';
import { isAdmin } from '@/lib/admin-check';
import { getSupabaseServerClient } from '@/lib/supabase';

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function makeServerCode(input: {
  days: number;
  uses: number;
  to: string;
  note: string;
  code: string;
}): Promise<Result<{ code: string }>> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const days = Math.round(input.days);
  const uses = Math.round(input.uses);
  if (!(days >= 1 && days <= 366)) return { ok: false, error: 'Free time must be 1 to 366 days.' };
  if (!(uses >= 1 && uses <= 100000)) return { ok: false, error: 'People must be 1 to 100000.' };
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code && (code.length < 8 || code.length > 16)) {
    return { ok: false, error: 'A code you choose must be 8 to 16 letters or numbers.' };
  }
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('admin_make_server_code', {
    p_days: days,
    p_uses: uses,
    p_to: input.to,
    p_note: input.note,
    p_code: code || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/coupons');
  return { ok: true, code: data as string };
}

/** The code ends now. People who already used it keep their free time. */
export async function turnOffServerCode(code: string): Promise<Result> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc('admin_turn_off_server_code', { p_code: code });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/coupons');
  return { ok: true };
}
