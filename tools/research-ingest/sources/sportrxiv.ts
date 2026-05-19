/**
 * SportRxiv fetcher (via OSF Preprints API).
 *
 * SportRxiv is the *domain-specific* preprint server for sport, exercise,
 * and health sciences. 100% of papers are on-topic for us. Schoenfeld,
 * Krieger, Refalo, Pak, Helms — the hypertrophy researchers we already
 * cite — often post here first, 6–12 months before journal publication.
 *
 * Historical note: SportRxiv lived on OSF Preprints from launch through
 * late 2023, then migrated to its own Janeway-based site at sportrxiv.org.
 * The OSF endpoint still exposes the historical corpus (~hundreds of
 * preprints) and may continue to surface re-imports / migrated papers.
 * If the new sportrxiv.org platform exposes a public API later, we can
 * add it as a second source route or replace this one.
 *
 * If the OSF endpoint stops returning new papers (we'll see this in the
 * checkpoint's papers_added going to 0 for weeks), the orchestrator's
 * `last_error` field will surface it. For now, this gets us the historical
 * corpus + whatever OSF still proxies.
 *
 * Source name in research_kb: 'sportrxiv'. Matches ingest_checkpoints row.
 *
 * API docs: https://developer.osf.io/#operation/preprints_list
 * Rate limits: 1 req/sec unauth, no key needed.
 */
import type { Checkpoint, Paper, Source } from '../shared/types.js';

const ENDPOINT = 'https://api.osf.io/v2/preprints/';
const PAGE_SIZE = 100; // OSF cap is 100 per page
const MAX_PAGES = 3;   // safety: 300 papers per topic-item

interface OsfContributor {
  embeds?: {
    users?: {
      data?: {
        attributes?: { full_name?: string };
      };
    };
  };
}

interface OsfPreprint {
  id: string;
  attributes: {
    title: string;
    description?: string;      // abstract
    doi?: string;
    date_published?: string;   // ISO datetime
    date_modified?: string;
    subjects?: string[][];
    is_published?: boolean;
    public?: boolean;
    license_record?: { copyright_holders?: string[]; year?: number };
  };
  embeds?: {
    contributors?: {
      data?: OsfContributor[];
    };
  };
  links?: { html?: string; preprint_doi?: string };
}

interface OsfListResponse {
  data?: OsfPreprint[];
  links?: { next?: string | null };
  meta?: { total?: number; per_page?: number };
}

function authorsFrom(p: OsfPreprint): string[] {
  const contribs = p.embeds?.contributors?.data ?? [];
  return contribs
    .map((c) => c.embeds?.users?.data?.attributes?.full_name)
    .filter((n): n is string => !!n)
    .slice(0, 12);
}

function urlFrom(p: OsfPreprint): string {
  if (p.attributes.doi) return `https://doi.org/${p.attributes.doi}`;
  if (p.links?.html) return p.links.html;
  return `https://osf.io/preprints/sportrxiv/${p.id}`;
}

function toPaper(p: OsfPreprint): Paper | null {
  const a = p.attributes;
  const abstract = (a.description ?? '').trim();
  if (!abstract || abstract.length < 100) return null;
  if (!a.title) return null;
  if (a.is_published === false || a.public === false) return null;

  const pubDate = a.date_published ?? a.date_modified ?? '';
  const pubYear = pubDate ? Number(pubDate.slice(0, 4)) : undefined;

  return {
    source: 'sportrxiv',
    url: urlFrom(p),
    title: a.title.trim(),
    abstract,
    authors: authorsFrom(p),
    journal: 'SportRxiv',
    pub_year: Number.isFinite(pubYear) ? pubYear : undefined,
    pub_date: pubDate ? pubDate.slice(0, 10) : undefined,
    identifier: a.doi ?? p.id,
    source_meta: {
      osf_id: p.id,
      doi: a.doi,
      subjects: a.subjects?.flat() ?? [],
      date_modified: a.date_modified,
    },
    license: 'preprint',
  };
}

async function fetchPage(url: string): Promise<OsfListResponse> {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
  if (!res.ok) {
    throw new Error(`OSF API ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

export const sportrxivSource: Source = {
  name: 'sportrxiv',
  async fetch(checkpoint, opts) {
    // OSF filter: published preprints from sportrxiv, ordered by
    // date_modified DESC so the newest re-imports show up first. Embed
    // contributors so we get authors in one round-trip per page instead
    // of N+1.
    const since = checkpoint.last_pub_date ?? '2020-01-01';
    const params = new URLSearchParams({
      'filter[provider]': 'sportrxiv',
      'filter[is_published]': 'true',
      'filter[date_modified][gte]': since,
      'page[size]': String(PAGE_SIZE),
      'sort': '-date_modified',
      'embed': 'contributors',
    });
    let nextUrl: string | null = `${ENDPOINT}?${params.toString()}`;
    const papers: Paper[] = [];
    let pageCount = 0;

    while (nextUrl && papers.length < opts.maxPapers && pageCount < MAX_PAGES) {
      let resp: OsfListResponse;
      try {
        resp = await fetchPage(nextUrl);
      } catch {
        break;
      }
      const items = resp.data ?? [];
      if (items.length === 0) break;
      for (const r of items) {
        const p = toPaper(r);
        if (!p) continue;
        if (checkpoint.last_identifier && p.identifier === checkpoint.last_identifier) {
          continue;
        }
        papers.push(p);
        if (papers.length >= opts.maxPapers) break;
      }
      nextUrl = resp.links?.next ?? null;
      pageCount += 1;
    }
    return papers;
  },
};
