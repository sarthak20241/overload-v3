/**
 * Which moment each person would get right now, with NOTHING written: the same
 * get_drona_moment_candidates read and decideMoment the card worker runs.
 *
 *   npx tsx scripts/drona-facts/moments-dryrun.mts
 *   AT=2026-10-15T04:00:00Z npx tsx scripts/drona-facts/moments-dryrun.mts   # as of another moment
 *
 * Prints the card words (numbers and exercise names only), never messages.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { decideMoment, type MomentPerson } from '../../supabase/functions/_shared/dronaMoments.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const at = process.env.AT ?? new Date().toISOString();
const { data, error } = await db.rpc('get_drona_moment_candidates', { p_now: at });
if (error) throw error;
const people = (data ?? []) as MomentPerson[];
const tally: Record<string, number> = {};
for (const p of people) {
  const card = decideMoment(p);
  const found = p.candidates.map((c) => c.type).join(', ');
  const key = card ? card.topic : 'nothing (caps, cooldown or quiet)';
  tally[key] = (tally[key] ?? 0) + 1;
  console.log(`\n${p.user_id.slice(0, 13)} (local ${p.today}) found: ${found}`);
  console.log(card ? `  -> [${card.kind}] ${card.title}\n     ${card.body}` : '  -> nothing');
}
console.log(`\nAs of ${at}: ${people.length} people with something found.`, tally);
