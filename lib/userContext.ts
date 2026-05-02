/**
 * Shape of the JSON returned by the Postgres `get_user_coach_context()` RPC.
 *
 * The edge function calls the RPC server-side and embeds the result in the
 * <user_context> block of the AI Coach system prompt. Client code can also
 * call it (e.g., to surface PRs in the UI), but the source of truth lives
 * in Postgres so personalization stays consistent across surfaces.
 */
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import type { CoachGoal, ExperienceLevel } from '@/lib/types';

export interface CoachContextProfile {
  goal?: CoachGoal;
  experience_level?: ExperienceLevel;
  training_age_months?: number;
  weekly_target_sessions?: number;
  weight_kg?: number;
  height_cm?: number;
  body_fat_percent?: number;
  gender?: 'M' | 'F' | 'O';
  age_years?: number;
  level?: number;
  xp?: number;
  streak?: number;
}

export interface CoachContextActivity {
  sessions_last_7d: number;
  sessions_last_28d: number;
  sessions_last_90d: number;
  last_finished_at?: string | null;
  volume_last_7d: number;
  volume_last_28d: number;
}

export interface CoachContextLift {
  exercise: string;
  muscle: string;
  estimated_1rm_kg: number;
  top_set: { weight_kg: number; reps: number };
  last_performed_at: string;
  sessions_last_28d: number;
}

export interface CoachContextWeeklyVolume {
  muscle: string;
  volume_kg: number;
  set_count: number;
  week_start: string;
}

export interface CoachContextRoutine {
  name: string;
  description?: string;
  exercises: {
    name: string;
    muscle: string;
    sets: number;
    reps: string;
    rest_s: number;
  }[];
}

export interface CoachContext {
  profile?: CoachContextProfile;
  activity?: CoachContextActivity;
  top_lifts: CoachContextLift[];
  weekly_volume: CoachContextWeeklyVolume[];
  active_routines: CoachContextRoutine[];
  training_inactive: boolean;
}

/**
 * Fetch the authenticated user's coach context. Returns null in guest mode or
 * when the RPC is unreachable. The edge function does this server-side; this
 * client helper exists for surfacing PRs / volume stats in app screens.
 */
export async function fetchUserCoachContext(): Promise<CoachContext | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.rpc('get_user_coach_context');
  if (error || !data) return null;
  return data as CoachContext;
}
