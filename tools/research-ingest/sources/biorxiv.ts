/**
 * bioRxiv fetcher.
 *
 * bioRxiv is the major preprint server for life sciences — papers go up
 * here weeks to months before peer-reviewed publication. We catch exercise
 * physiology, muscle biology, and kinesiology preprints months ahead of
 * when Europe PMC would index them.
 *
 * Caveats this source has to handle:
 *   - bioRxiv API has NO keyword/topic filter. Every fetch returns
 *     EVERYTHING posted in the date range (across all biology). Our shared
 *     relevance keyword filter at the orchestrator level rejects 95%+ of
 *     them before they reach Haiku. So bioRxiv is a "low signal-to-noise
 *     ratio at the API, high after the filter" source.
 *   - Papers are PRE peer-review. Trust v2 scoring penalizes preprints
 *     accordingly (rank 1-2 vs. meta-analyses at rank 5). The supersede
 *     guardrails block preprints from replacing peer-reviewed kb entries.
 *
 * Source name in research_kb: 'biorxiv'. Matches ingest_checkpoints row.
 *
 * API docs: https://api.biorxiv.org/
 * Rate limits: undocumented but generous (no key needed). We're polite —
 * one page at a time, paged by cursor offset.
 */
import type { Checkpoint, Paper, Source } from '../shared/types.js';

const ENDPOINT = 'https://api.biorxiv.org/details/biorxiv';
const PAGE_SIZE = 100;          // bioRxiv's default; not configurable
const MAX_PAGES = 5;            // safety: 500 papers per topic-item is plenty

interface BiorxivResult {
  doi: string;
  title: string;
  /** Semicolon-separated "Lastname, F.; ..." */
  authors: string;
  author_corresponding?: string;
  author_corresponding_institution?: string;
  /** ISO date YYYY-MM-DD */
  date: string;
  /** Version of this preprint (e.g. "1", "2") */
  version: string;
  /** 'new results', 'confirmatory results', 'contradictory results' */
  type?: string;
  /** Creative Commons license slug (e.g. 'cc_by', 'cc_no') */
  license: string;
  /** e.g. 'cell biology', 'physiology'. Useful for the dashboard's audit context. */
  category: string;
  abstract: string;
  /** 'biorxiv' (the API can also return medrxiv records under that endpoint) */
  server: string;
  jatsxml?: string;
}

function parseAuthors(s: string): string[] {
  if (!s) return [];
  return s
    .split(/;|,(?=\s)/)
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 12); // cap to keep source_meta compact
}

function normalizeLicense(license: string): string {
  // bioRxiv uses lowercase slugs. Surface them in a recognizable form.
  switch (license) {
    case 'cc_by':       return 'CC-BY';
    case 'cc_by_nc':    return 'CC-BY-NC';
    case 'cc_by_nc_nd': return 'CC-BY-NC-ND';
    case 'cc_by_nd':    return 'CC-BY-ND';
    case 'cc0':         return 'CC0';
    case 'cc_no':       return 'preprint';
    default:            return license || 'preprint';
  }
}

function toPaper(r: BiorxivResult): Paper | null {
  if (!r.abstract || r.abstract.length < 100) return null;
  if (!r.title || !r.doi) return null;
  // bioRxiv often returns "<jats:p>...</jats:p>" wrappers around the
  // abstract. Strip the most common ones; Haiku can handle the rest.
  const abstract = r.abstract
    .replace(/<\/?jats:[^>]+>/g, '')
    .replace(/<\/?p>/g, '')
    .trim();
  return {
    source: 'biorxiv',
    url: `https://doi.org/${r.doi}`,
    title: r.title.trim(),
    abstract,
    authors: parseAuthors(r.authors),
    journal: 'bioRxiv',
    pub_year: Number(r.date.slice(0, 4)),
    pub_date: r.date,
    identifier: r.doi,
    source_meta: {
      doi: r.doi,
      biorxiv_category: r.category,
      biorxiv_version: r.version,
      biorxiv_type: r.type,
      author_corresponding: r.author_corresponding,
      institution: r.author_corresponding_institution,
      jatsxml_url: r.jatsxml,
    },
    license: normalizeLicense(r.license),
  };
}

interface BiorxivResponse {
  collection?: BiorxivResult[];
  messages?: Array<{ status: string; total?: number; cursor?: number; count?: number }>;
}

async function fetchPage(since: string, until: string, cursor: number): Promise<BiorxivResponse> {
  const url = `${ENDPOINT}/${since}/${until}/${cursor}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`bioRxiv ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

export const biorxivSource: Source = {
  name: 'biorxiv',
  async fetch(checkpoint, opts) {
    // bioRxiv requires both endpoints (date range). We use the checkpoint's
    // last_pub_date as the lower bound and today as the upper. Cold-start
    // (no checkpoint) defaults to 14 days back — going further would pull
    // tens of thousands of irrelevant papers through our filter.
    const today = new Date().toISOString().slice(0, 10);
    const cold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const since = checkpoint.last_pub_date ?? cold;

    const papers: Paper[] = [];
    let cursor = 0;
    let pageCount = 0;

    while (papers.length < opts.maxPapers && pageCount < MAX_PAGES) {
      let resp: BiorxivResponse;
      try {
        resp = await fetchPage(since, today, cursor);
      } catch {
        break; // already logged at the orchestrator; just bail this source
      }
      const items = resp.collection ?? [];
      if (items.length === 0) break;
      for (const r of items) {
        const p = toPaper(r);
        if (!p) continue;
        if (checkpoint.last_identifier && p.identifier === checkpoint.last_identifier) {
          // We've caught up to a paper we processed in a prior run.
          // bioRxiv returns ASC by date, so anything before this is older
          // than our high watermark — safe to stop scanning.
          continue;
        }
        papers.push(p);
        if (papers.length >= opts.maxPapers) break;
      }
      cursor += items.length;
      pageCount += 1;
      // If the API returned fewer than PAGE_SIZE, we're at the end.
      if (items.length < PAGE_SIZE) break;
    }
    return papers;
  },
};
