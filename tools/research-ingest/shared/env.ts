/**
 * Auto-load .env.local for local dev, then assert required env vars are set.
 * In GitHub Actions the vars come from repo secrets so the .env.local load
 * is a no-op there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = join(HERE, '..', '..', '..', '.env.local');

if (existsSync(ENV_LOCAL)) {
  for (const raw of readFileSync(ENV_LOCAL, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Override if undefined OR empty — some harnesses (Claude Code, CI runners)
    // pre-export blank API keys, and our `if (!ANTHROPIC_API_KEY)` check would
    // then report missing even though the file has the real value.
    if (!process.env[key]) process.env[key] = val;
  }
}

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
export const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Optional: Semantic Scholar API key for higher rate limits on author lookup.
// Pipeline runs without it (lower trust_score signal quality).
export const SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
// Optional: contact email for PubMed E-utilities. Lets NCBI raise our rate
// cap from 3 req/s → 10 req/s. They request (not require) you set this.
export const PUBMED_CONTACT_EMAIL = process.env.PUBMED_CONTACT_EMAIL;

/**
 * Validate the env vars the worker needs to run.
 *
 * `needsVoyage: false` is for --review mode — the auto-review agent reads
 * pending rows, asks Sonnet for a verdict, and applies the decision via
 * Supabase RPCs. It never embeds anything, so demanding VOYAGE_API_KEY
 * would crash the cron's review pass for no benefit (this exact thing
 * happened on the May 20 manual run when the GH Actions YAML didn't
 * forward VOYAGE_API_KEY to the review step).
 */
export function assertRequiredEnv(opts?: { needsVoyage?: boolean }): void {
  const needsVoyage = opts?.needsVoyage !== false; // default true (ingest mode)
  const missing: string[] = [];
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (needsVoyage && !VOYAGE_API_KEY) missing.push('VOYAGE_API_KEY');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL)');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}
