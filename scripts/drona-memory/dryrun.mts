/**
 * What the daily memory sweep would save, with NOTHING written: no fact, no
 * "seen" mark. Live Jev and the live writer (about $0.0001 a text, $0.001 a yes).
 *
 *   DAYS=3 npx tsx scripts/drona-memory/dryrun.mts
 *
 * Prints facts in full only for OWNER_IDS (the owner's own accounts); everyone
 * else is counts by category. Messages are never printed.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { catchMemory, type MemoryFactIn } from '../../supabase/functions/_shared/dronaMemory.ts';

const env = Object.fromEntries(readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const db = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const OWNER_PREFIXES = (process.env.OWNER_IDS ?? 'user_3HgbHlVP,user_3HKAcd0G').split(',');

const since = new Date(Date.now() - Number(process.env.DAYS ?? 3) * 86_400_000).toISOString().slice(0, 10);
const { data, error } = await db.rpc('get_drona_memory_unseen', { p_since: since, p_limit: 300 });
if (error) throw error;
const texts = (data ?? []) as { user_id: string; id: string; kind: string; text: string }[];
const outcomes: Record<string, number> = {};
const byKind: Record<string, number> = {};
const categories: Record<string, number> = {};
const owner: string[] = [];
for (let i = 0; i < texts.length; i += 5) {
  await Promise.all(texts.slice(i, i + 5).map(async (t) => {
    byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
    const facts: MemoryFactIn[] = [];
    const r = await catchMemory(t.text, t.kind, {
      jev: { apiKey: env.JEV_API_KEY ?? '', timeoutMs: 20_000, fetchFn: fetch },
      anthropicKey: env.ANTHROPIC_API_KEY ?? '', fetchFn: fetch, today: new Date().toISOString().slice(0, 10),
      readMemory: async () => [],
      saveFact: async (f) => { facts.push(f); return true; },
    });
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    for (const f of facts) {
      categories[f.category] = (categories[f.category] ?? 0) + 1;
      if (OWNER_PREFIXES.some((p) => t.user_id.startsWith(p))) owner.push(`${t.user_id.slice(0, 13)} [${t.kind}] ${f.category} / ${f.key}: ${f.value}`);
    }
  }));
}
console.log(`${texts.length} unseen texts since ${since}, by kind:`, byKind);
console.log('outcomes:', outcomes);
console.log('facts by category (everyone):', categories);
console.log('\nOwner accounts, in full:');
for (const l of owner) console.log('  ' + l);
