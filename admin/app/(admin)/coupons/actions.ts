'use server';
/**
 * Coupons: server actions. Every one checks is_admin() first (a server action
 * is a public POST endpoint), then reads and writes with the admin's own
 * token, so the coupon tables' RLS (is_admin()) applies too.
 */
import { revalidatePath } from 'next/cache';
import { isAdmin } from '@/lib/admin-check';
import { getSupabaseServerClient } from '@/lib/supabase';
import {
  BATCH_DAYS, BATCH_SIZE, NAMED_USES, PERIODS, type Period,
  batchCodes, createNamedCode, deactivateNamedCode, ensureOffer, requestBatch,
} from '@/lib/appstore';

export type Coupon = {
  code: string;
  batch_id: string;
  period: Period;
  kind: 'one_time' | 'named';
  expires: string | null;
  sandbox: boolean;
  given_at: string | null;
  given_to: string | null;
  note: string | null;
};

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function isPeriod(p: string): p is Period {
  return (PERIODS as readonly string[]).includes(p);
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Save the codes of every batch Apple has finished. Returns how many are still being made. */
async function saveReadyBatches(): Promise<number> {
  const supabase = await getSupabaseServerClient();
  const { data: making } = await supabase
    .from('coupon_batches')
    .select('id, period, expires, sandbox')
    .eq('status', 'making');
  let left = 0;
  for (const b of making ?? []) {
    const codes = await batchCodes(b.id);
    if (!codes) {
      left++;
      continue;
    }
    const rows = codes.map((code) => ({
      code, batch_id: b.id, period: b.period, kind: 'one_time', expires: b.expires, sandbox: b.sandbox,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await supabase.from('coupons').upsert(rows.slice(i, i + 1000), { onConflict: 'code', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    await supabase.from('coupon_batches').update({ status: 'ready', count: codes.length }).eq('id', b.id);
  }
  return left;
}

/** Called by the page while a batch is being made. */
export async function checkBatches(): Promise<Result<{ making: number }>> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  try {
    const making = await saveReadyBatches();
    revalidatePath('/coupons');
    return { ok: true, making };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Ask Apple for 500 new one-time codes for a period. Waits up to ~90 s for them. */
export async function makeBatch(period: string, sandbox = false): Promise<Result<{ ready: boolean }>> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  if (!isPeriod(period)) return { ok: false, error: 'Unknown period' };
  try {
    const supabase = await getSupabaseServerClient();
    const offerId = await ensureOffer(period);
    const expires = daysFromNow(BATCH_DAYS);
    const id = await requestBatch(offerId, BATCH_SIZE, expires, sandbox);
    const { error } = await supabase.from('coupon_batches').insert({
      id, period, offer_id: offerId, kind: 'one_time', count: BATCH_SIZE, expires, sandbox, status: 'making',
    });
    if (error) throw new Error(`Apple made batch ${id}, but saving it failed: ${error.message}`);
    // Apple usually finishes in under a minute. If not, the page keeps checking.
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if ((await batchCodes(id)) !== null) break;
    }
    const left = await saveReadyBatches();
    revalidatePath('/coupons');
    return { ok: true, ready: left === 0 };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** The next unused code for a period, marked as given. */
export async function giveCode(period: string, to: string, note: string): Promise<Result<{ coupon: Coupon | null }>> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  if (!isPeriod(period)) return { ok: false, error: 'Unknown period' };
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('give_coupon', { p_period: period, p_to: to, p_note: note });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/coupons');
  // A function returning a row gives all-null columns when nothing matched.
  const coupon = data && (data as Coupon).code ? (data as Coupon) : null;
  return { ok: true, coupon };
}

/** Mark one code you picked from the list as given. */
export async function markGiven(code: string, to: string, note: string): Promise<Result> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from('coupons')
    .update({ given_at: new Date().toISOString(), given_to: to.trim() || null, note: note.trim() || null })
    .eq('code', code)
    .is('given_at', null)
    .select('code');
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: 'Someone already gave this code. Pick another.' };
  revalidatePath('/coupons');
  return { ok: true };
}

/** Put a one-time code back as unused (given by mistake, never sent). */
export async function undoGiven(code: string): Promise<Result> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from('coupons')
    .update({ given_at: null, given_to: null, given_by: null, note: null })
    .eq('code', code)
    .eq('kind', 'one_time');
  if (error) return { ok: false, error: error.message };
  revalidatePath('/coupons');
  return { ok: true };
}

/** Make a named code (like RAHUL) for one person. Apple makes it good for 500 uses. */
export async function makeNamedCode(period: string, rawCode: string, to: string, note: string): Promise<Result<{ coupon: Coupon }>> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  if (!isPeriod(period)) return { ok: false, error: 'Unknown period' };
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/.test(code)) return { ok: false, error: 'Use 4 to 30 letters or numbers, no spaces.' };
  try {
    const supabase = await getSupabaseServerClient();
    const { data: taken } = await supabase.from('coupons').select('code').eq('code', code).maybeSingle();
    if (taken) return { ok: false, error: `${code} already exists.` };
    const offerId = await ensureOffer(period);
    const id = await createNamedCode(offerId, code, null);
    const { error: bErr } = await supabase.from('coupon_batches').insert({
      id, period, offer_id: offerId, kind: 'named', count: NAMED_USES, expires: null, status: 'ready',
    });
    if (bErr) throw new Error(`Apple made ${code}, but saving it failed: ${bErr.message}`);
    const coupon = {
      code, batch_id: id, period, kind: 'named' as const, expires: null, sandbox: false,
      given_at: new Date().toISOString(), given_to: to.trim() || null, note: note.trim() || null,
    };
    const { error } = await supabase.from('coupons').insert(coupon);
    if (error) throw new Error(`Apple made ${code}, but saving it failed: ${error.message}`);
    revalidatePath('/coupons');
    return { ok: true, coupon };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Turn a named code off at Apple. It stops working at once; this can't be undone. */
export async function turnOffNamedCode(code: string): Promise<Result> {
  if (!(await isAdmin())) return { ok: false, error: 'Not authorized' };
  try {
    const supabase = await getSupabaseServerClient();
    const { data: row } = await supabase.from('coupons').select('batch_id, kind').eq('code', code).maybeSingle();
    if (!row || row.kind !== 'named') return { ok: false, error: 'Not a named code' };
    await deactivateNamedCode(row.batch_id);
    await supabase.from('coupon_batches').update({ status: 'off' }).eq('id', row.batch_id);
    revalidatePath('/coupons');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
