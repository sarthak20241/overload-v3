/**
 * Knowledge-Base Browser — read-only view of the 50+ promoted research_kb
 * entries. Filterable by topic tag and source, searchable by title/takeaway.
 *
 * v1 is read-only. Editing distillation fields and triggering supersede
 * land in a follow-up commit once the supersede backend is wired.
 */
import { getSupabaseServerClient } from '@/lib/supabase';
import type { ResearchKbEntry } from '@/lib/types';
import { KbInteractive } from './KbInteractive';

export const dynamic = 'force-dynamic';

async function loadKb(): Promise<{ entries: ResearchKbEntry[]; error: string | null }> {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from('research_kb')
      .select('id, source, url, title, authors, journal, pub_year, pub_date, topic_tags, study_design, confidence, population, intervention, key_finding, practical_takeaway, trust_score, license, ingested_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) return { entries: [], error: error.message };
    const entries = (data ?? []).map((p) => ({
      ...p,
      trust_score: Number(p.trust_score),
    })) as ResearchKbEntry[];
    return { entries, error: null };
  } catch (e) {
    return { entries: [], error: String(e) };
  }
}

export default async function KbPage() {
  const { entries, error } = await loadKb();
  return (
    <div className="flex flex-col h-screen">
      <div className="px-8 py-5 border-b border-border">
        <h1 className="text-xl font-semibold text-fg">Knowledge Base</h1>
        <p className="text-xs text-muted-fg mt-0.5">
          {entries.length} promoted papers · what the coach retrieves from at inference time
        </p>
      </div>
      {error ? (
        <div className="mx-8 mt-4 p-3 rounded-md border border-danger/30 bg-danger/10 text-sm text-danger">
          Failed to load: {error}
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <KbInteractive entries={entries} />
        </div>
      )}
    </div>
  );
}
