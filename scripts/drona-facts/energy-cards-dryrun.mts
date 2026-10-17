/**
 * What the adaptive calories cards would say this week, for every person, with
 * nothing written: last week's behaviours, the live targets and the recent
 * cards go through the same decideEnergyCard the card worker calls.
 *
 *   npx tsx scripts/drona-facts/energy-cards-dryrun.mts
 *
 * Read only. Unlike the worker it does not rebuild stale facts first.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { decideEnergyCard } from '../../supabase/functions/_shared/dronaEnergy.ts';
import { onCooldown, type DronaFacts } from '../../supabase/functions/_shared/dronaCards.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const monday = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const thisWeek = monday(new Date());
const lastWeek = new Date(Date.parse(thisWeek + 'T00:00:00Z') - 7 * 86_400_000).toISOString().slice(0, 10);

const { data: behs, error } = await db.from('drona_behaviours').select('user_id, behaviour, card_kind, priority, mutes, detail').eq('week_start', lastWeek);
if (error) throw error;
const users = [...new Set((behs ?? []).map((b) => b.user_id))];
let shown = 0;
for (const u of users) {
  const { data: p } = await db.from('user_profiles')
    .select('tier, tier_expires_at, daily_calorie_target, protein_target_g, carb_target_g, fat_target_g').eq('clerk_user_id', u).maybeSingle();
  const { data: cards } = await db.from('drona_cards').select('week_start, kind, topic, status').eq('user_id', u).order('week_start', { ascending: false }).limit(8);
  const facts: DronaFacts = { week_start: thisWeek, cards: cards ?? [] };
  const card = decideEnergyCard({
    as_of: new Date().toISOString().slice(0, 10), week_start: lastWeek, tier: p?.tier, tier_expires_at: p?.tier_expires_at,
    targets: { kcal: p?.daily_calorie_target, protein_g: p?.protein_target_g, carb_g: p?.carb_target_g, fat_g: p?.fat_target_g },
    behaviours: (behs ?? []).filter((b) => b.user_id === u),
  }, (topic) => onCooldown(topic, facts));
  if (!card) continue;
  shown++;
  console.log(`\n${u.slice(0, 13)}  [${card.kind} / ${card.topic}]  ${card.title}\n  ${card.body}\n  ${card.evidence.map((e) => `${e.label}: ${e.value}`).join(' | ')}`);
}
console.log(`\n${shown} of ${users.length} people with behaviours last week (${lastWeek}) would get an adaptive calories card.`);
