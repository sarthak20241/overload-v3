/**
 * Europe PMC fetcher.
 *
 * Why Europe PMC instead of raw PubMed E-utilities:
 *   - JSON API for both search AND fetch (PubMed only gives JSON for search;
 *     EFetch is XML). Less parsing, fewer footguns.
 *   - Indexes everything PubMed has (`SRC:MED`) PLUS preprints, Agricola,
 *     PMC OA articles — a strict superset.
 *   - Provides `abstractText` and OA license info inline in the result.
 *
 * Source name in research_kb: 'europe_pmc'. Matches ingest_checkpoints row.
 *
 * Query strategy: a broad disjunction of exercise-science terms restricted
 * to English-language journal articles, paginated from the last checkpoint
 * date. We page sortDesc on FIRST_PDATE so the FIRST page has the OLDEST
 * papers we haven't seen yet — that way our checkpoint update at the end
 * captures the high-water mark cleanly.
 *
 * API docs: https://europepmc.org/RestfulWebService
 * Rate limits: 10 req/sec public, no key needed.
 */
import type { Checkpoint, Paper, Source } from '../shared/types.js';
import { PUBMED_CONTACT_EMAIL } from '../shared/env.js';

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const PAGE_SIZE = 25;

// Broad disjunction. Tuned to be a CHEAP first-pass net — the keyword filter
// in shared/relevance.ts re-filters the abstract before we spend Haiku.
// Each term is scoped with TITLE_ABS so we only match papers whose title OR
// abstract literally contains the term. Without this scope, Europe PMC's
// default field includes MeSH terms, author affiliations, and full-text body
// — meaning "training" can match medical-school papers, "exercise" can match
// yoga vascular-function studies, etc. With TITLE_ABS we get actual
// strength-and-conditioning science.
// Each term is a multi-word phrase that's effectively unambiguous to
// strength/conditioning science. We previously had bare 'hypertrophy' here,
// but that matches "cardiac hypertrophy", "mucosal hypertrophy", and other
// non-musculoskeletal uses. Stick to phrases that only show up in
// resistance-exercise abstracts.
const QUERY_TERMS = [
  'TITLE_ABS:"resistance training"',
  'TITLE_ABS:"strength training"',
  'TITLE_ABS:"muscle hypertrophy"',
  'TITLE_ABS:"skeletal muscle hypertrophy"',
  'TITLE_ABS:"muscle protein synthesis"',
  'TITLE_ABS:"progressive overload"',
  'TITLE_ABS:"training to failure"',
  'TITLE_ABS:"repetitions in reserve"',
  'TITLE_ABS:"training volume"',
  'TITLE_ABS:"training frequency"',
  'TITLE_ABS:"1-repetition maximum"',
  'TITLE_ABS:"one-repetition maximum"',
  'TITLE_ABS:"hypertrophic adaptations"',
  'TITLE_ABS:"resistance exercise"',
];

/**
 * Wrap topic-driven query terms with TITLE_ABS scoping. Accepts either:
 *   - already-prefixed: 'TITLE_ABS:"foo bar"' → returned as-is
 *   - bare phrase:      'deload week'          → returned as TITLE_ABS:"deload week"
 *   - bare single word: 'hypertrophy'          → caller responsibility (we still scope)
 * Phrases pass through quoted so PMC does phrase-match, not OR-of-words.
 */
function scopeTerms(terms: string[]): string[] {
  return terms.map((t) => {
    if (t.startsWith('TITLE_ABS:')) return t;
    const trimmed = t.trim();
    if (!trimmed) return '';
    // Already quoted? leave the quotes
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return `TITLE_ABS:${trimmed}`;
    }
    return `TITLE_ABS:"${trimmed}"`;
  }).filter(Boolean);
}

function buildQuery(checkpoint: Checkpoint, queryTerms?: string[]): string {
  const since = (checkpoint.last_pub_date ?? checkpoint.last_fetched_at.slice(0, 10)) || '2024-01-01';
  const today = new Date().toISOString().slice(0, 10);
  // Topic-driven override: a caller (run.ts) hands us specific phrases for
  // this fetch — e.g. ["deload week", "tapering", "fatigue management"].
  // We TITLE_ABS-scope them and OR them, then keep the same language /
  // source / date filters.
  const terms = queryTerms && queryTerms.length > 0
    ? scopeTerms(queryTerms)
    : QUERY_TERMS;
  return [
    `(${terms.join(' OR ')})`,
    'LANG:eng',
    '(SRC:MED OR SRC:PPR OR SRC:PMC)',
    `FIRST_PDATE:[${since} TO ${today}]`,
  ].join(' AND ');
}

interface EpmcResult {
  id: string;
  source: string;
  pmid?: string;
  doi?: string;
  title: string;
  authorString?: string;
  authorList?: { author?: Array<{ fullName?: string }> };
  journalTitle?: string;
  pubYear?: string;
  firstPublicationDate?: string;
  abstractText?: string;
  isOpenAccess?: 'Y' | 'N';
  license?: string;
}

function authorsFrom(r: EpmcResult): string[] {
  const list = r.authorList?.author ?? [];
  if (list.length > 0) {
    return list.map((a) => a.fullName ?? '').filter(Boolean);
  }
  if (r.authorString) {
    return r.authorString
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function urlFrom(r: EpmcResult): string {
  if (r.doi) return `https://doi.org/${r.doi}`;
  if (r.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
  return `https://europepmc.org/abstract/${r.source}/${r.id}`;
}

function toPaper(r: EpmcResult): Paper | null {
  if (!r.abstractText || r.abstractText.length < 100) return null; // can't distill
  if (!r.title) return null;
  return {
    source: 'europe_pmc',
    url: urlFrom(r),
    title: r.title,
    abstract: r.abstractText,
    authors: authorsFrom(r),
    journal: r.journalTitle,
    pub_year: r.pubYear ? Number(r.pubYear) : undefined,
    pub_date: r.firstPublicationDate || undefined,
    identifier: r.pmid ?? r.doi ?? r.id,
    source_meta: {
      epmc_id: r.id,
      epmc_source: r.source,
      pmid: r.pmid,
      doi: r.doi,
      is_open_access: r.isOpenAccess === 'Y',
      license: r.license,
    },
    license: r.isOpenAccess === 'Y' ? (r.license ?? 'OA') : 'abstract-only',
  };
}

async function fetchPage(query: string, cursorMark: string): Promise<{
  results: EpmcResult[];
  nextCursorMark: string | null;
  hitCount: number;
}> {
  const params = new URLSearchParams({
    query,
    format: 'json',
    resultType: 'core',
    pageSize: String(PAGE_SIZE),
    cursorMark,
    sort: 'FIRST_PDATE_D asc',
  });
  if (PUBMED_CONTACT_EMAIL) {
    params.set('email', PUBMED_CONTACT_EMAIL);
  }
  const res = await fetch(`${ENDPOINT}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Europe PMC ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return {
    results: body?.resultList?.result ?? [],
    nextCursorMark: body?.nextCursorMark ?? null,
    hitCount: body?.hitCount ?? 0,
  };
}

export const europepmcSource: Source = {
  name: 'europe_pmc',
  async fetch(checkpoint, opts) {
    // Use topic-driven phrases when the orchestrator passed them, else fall
    // back to the broad disjunction (the 'trending' bucket case).
    const query = buildQuery(checkpoint, opts.queryTerms);
    const papers: Paper[] = [];
    let cursor = '*';
    let pageCount = 0;
    const MAX_PAGES = 8; // safety

    while (papers.length < opts.maxPapers && pageCount < MAX_PAGES) {
      const { results, nextCursorMark } = await fetchPage(query, cursor);
      if (results.length === 0) break;
      for (const r of results) {
        const p = toPaper(r);
        if (!p) continue;
        // Skip identifiers we already processed in a prior run. last_identifier
        // is the *highest* identifier we've seen — for cursor-paginated APIs
        // this is approximate but defensive.
        if (checkpoint.last_identifier && p.identifier === checkpoint.last_identifier) {
          continue;
        }
        papers.push(p);
        if (papers.length >= opts.maxPapers) break;
      }
      if (!nextCursorMark || nextCursorMark === cursor) break;
      cursor = nextCursorMark;
      pageCount += 1;
    }
    return papers;
  },
};
