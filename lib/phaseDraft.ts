/**
 * The phase draft store: a built phase plan kept on the device until the user
 * taps Save. Rules (staleness, keys) are in lib/phaseBuildRules.ts.
 *
 * Device-only on purpose. A draft is the user's to accept or change; nothing
 * about it should reach the database until they say so, and Save is the one
 * write path (the coach sheet's handleSaveRoutines).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GeneratedPlan } from '@/lib/generatedPlan';
import { parseStoredDraft, phaseDraftKey, type StoredDraft } from '@/lib/phaseBuildRules';

// Readers in other screens (the dashboard card) learn about a change at once.
type Listener = (phaseId: string) => void;
const listeners = new Set<Listener>();
function emit(phaseId: string) {
  listeners.forEach((l) => {
    try { l(phaseId); } catch { /* a listener's bug is not the writer's */ }
  });
}
export function onPhaseDraftChange(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export async function readPhaseDraft(phaseId: string): Promise<StoredDraft<GeneratedPlan> | null> {
  try {
    const raw = await AsyncStorage.getItem(phaseDraftKey(phaseId));
    return parseStoredDraft<GeneratedPlan>(raw, Date.now());
  } catch {
    return null;
  }
}

export async function writePhaseDraft(phaseId: string, plan: GeneratedPlan, source: 'build' | 'auto' = 'build'): Promise<void> {
  try {
    const d: StoredDraft<GeneratedPlan> = { plan, builtAt: Date.now(), source };
    await AsyncStorage.setItem(phaseDraftKey(phaseId), JSON.stringify(d));
    emit(phaseId);
  } catch { /* no draft is the same as before drafts existed */ }
}

export async function clearPhaseDraft(phaseId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(phaseDraftKey(phaseId));
    emit(phaseId);
  } catch { /* a stale draft is dropped when the phase has routines anyway */ }
}

/** Which of these phases have a draft waiting. */
export async function phasesWithDrafts(phaseIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(phaseIds.map(async (id) => {
    if (await readPhaseDraft(id)) out.add(id);
  }));
  return out;
}
