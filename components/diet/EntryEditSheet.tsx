/** Logged foods use the same portion and macro editor as Drona proposals. */
import { useEffect, useMemo, useState } from 'react';
import { Keyboard } from 'react-native';
import { ParsedItemEditor } from './ParsedItemEditor';
import { deleteMealEntry, updateLoggedEntry, type LoggedEntry, type ParsedMealItem } from '@/lib/dietData';
import { useSupabaseClient } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { track } from '@/lib/analytics';

interface Props {
  entry: LoggedEntry | null;
  date: Date;
  onClose: () => void;
  onSaved: () => void;
}

export function EntryEditSheet({ entry, date, onClose, onSaved }: Props) {
  const supabase = useSupabaseClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setBusy(false); setError(null); }, [entry]);
  // Stable identity keeps the draft intact through pending or failed saves.
  const item = useMemo<ParsedMealItem | null>(() => entry ? {
    food_id: entry.food_id ?? null, food_name: entry.food_name,
    quantity: entry.quantity, serving_label: entry.serving_unit,
    grams: entry.grams_logged ?? 0, kcal: entry.kcal,
    protein_g: entry.protein_g, carb_g: entry.carb_g, fat_g: entry.fat_g,
    fiber_g: null, source: entry.source ?? 'manual', assumption: null,
    confidence: 'high', meal_type: entry.meal_type,
  } : null, [entry]);

  const mutate = async (patch?: ParsedMealItem) => {
    if (!entry || busy) return;
    if (!supabase) { setError('Reconnect before saving this food.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = patch ? await updateLoggedEntry(supabase, entry, patch, date)
        : await deleteMealEntry(supabase, entry);
      if (result.error) { setError(result.error); haptics.warning(); return; }
      track(patch ? 'meal_entry_updated' : 'meal_entry_deleted', patch ? {
        rescaled: patch.quantity !== entry.quantity, moved: patch.meal_type !== entry.meal_type,
        from_meal: entry.meal_type, to_meal: patch.meal_type,
      } : { meal_type: entry.meal_type, kcal: Math.round(entry.kcal) });
      Keyboard.dismiss();
      haptics.success();
      onSaved();
    } catch {
      setError('Could not save this food. Your edits are still here — try again.');
      haptics.warning();
    } finally { setBusy(false); }
  };

  return <ParsedItemEditor item={item} onCancel={onClose} onSave={patch => { void mutate(patch); }}
    onDelete={() => { void mutate(); }} busy={busy} error={error} preserveSnapshot />;
}
