/**
 * The free-build claim owed by a phase 1 plan that was built before sign-up
 * (lib/phasePrebuild.ts). That build ran with no account, so the account's
 * free build was never claimed for the phase; a free account's Refine with
 * Drona (try_claim_free_phase_refine) needs it. The Goal screen claims it as
 * it takes the plan. If that fails, a note stays on the phone, and the claim
 * is tried again when the draft is reopened and before the Drona chat opens,
 * so a network blip never leaves the refine path refused for good.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { track } from '@/lib/analytics';

const key = (phaseId: string) => `phase_prebuild_claim_v1:${phaseId}`;

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/** Claims the free build for the phase: two tries a second apart on an error. '' when claimed, else why not. */
async function claimOnce(supabase: RpcClient, phaseId: string): Promise<string> {
  let reason = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc('try_claim_free_phase_build', { p_phase_id: phaseId });
      const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; reason?: string } | null;
      if (!error && row?.allowed) return '';
      reason = error ? 'rpc_error' : (row?.reason ?? 'unknown');
      // A refusal (not an error) will not change on a retry.
      if (!error) return reason;
    } catch {
      reason = 'threw';
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  return reason;
}

/** The plan was just taken: owe the claim, then try it. */
export async function claimForPrebuiltPlan(supabase: RpcClient, phaseId: string): Promise<void> {
  try { await AsyncStorage.setItem(key(phaseId), '1'); } catch { /* best effort */ }
  await settle(supabase, phaseId, 'taken');
}

/** Tries an owed claim again (draft reopened, Drona chat opening). Nothing owed: nothing to do. */
export async function ensurePrebuildClaim(supabase: RpcClient, phaseId: string): Promise<void> {
  let owed = false;
  try { owed = (await AsyncStorage.getItem(key(phaseId))) === '1'; } catch { owed = false; }
  if (owed) await settle(supabase, phaseId, 'retry');
}

async function settle(supabase: RpcClient, phaseId: string, when: 'taken' | 'retry'): Promise<void> {
  const reason = await claimOnce(supabase, phaseId);
  // Claimed, or refused for good (a refusal will not change): nothing owed.
  if (!reason || (reason !== 'rpc_error' && reason !== 'threw')) {
    try { await AsyncStorage.removeItem(key(phaseId)); } catch { /* best effort */ }
  }
  if (reason) {
    console.warn('[prebuild] free build claim failed', reason);
    // Not claimed: a free account's Refine with Drona will meet the paywall.
    track('phase_prebuild_claim_failed', { reason, when });
  }
}
