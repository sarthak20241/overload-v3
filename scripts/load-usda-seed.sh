#!/usr/bin/env bash
# Load the generated USDA catalog seed into the live DB via the Supabase Management
# API (same endpoint the MCP uses; no psql / DB password needed). The seed is large,
# so it is split at batch boundaries and POSTed one batch at a time.
#
# Usage:
#   SB_PAT=<supabase-access-token> bash scripts/load-usda-seed.sh
#   (create a token at https://supabase.com/dashboard/account/tokens)
#
# Reversible: delete from public.foods where 'usda' = any(sources);
set -euo pipefail

REF="rjmmslierxhvwdjgjilb"
SEED="$(cd "$(dirname "$0")/.." && pwd)/supabase/seed/usda_foods.generated.sql"
API="https://api.supabase.com/v1/projects/${REF}/database/query"

TOKEN="${SB_PAT:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.sb_pat" ]; then TOKEN="$(tr -d '[:space:]' < "$HOME/.sb_pat")"; fi
[ -z "$TOKEN" ] && { echo "Set SB_PAT (or write the token to ~/.sb_pat). Get one at https://supabase.com/dashboard/account/tokens"; exit 1; }
[ -f "$SEED" ] || { echo "Seed not found: $SEED (run: npx tsx scripts/diet-catalog/ingest-usda.ts)"; exit 1; }

post() { # $1 = sql file; echoes "HTTPCODE\nbody"
  curl -s -w '\n%{http_code}' -X POST "$API" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    --data "$(jq -Rs '{query: .}' < "$1")"
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# split before each foods-insert: each chunk = one foods upsert + its servings insert
csplit -s -z -f "$TMP/chunk_" -b '%03d.sql' "$SEED" '/^insert into public.foods/' '{*}'

n=0; ok=0
for f in "$TMP"/chunk_*.sql; do
  grep -q '^insert into' "$f" || continue   # skip the header chunk
  n=$((n+1))
  resp="$(post "$f")"; code="$(printf '%s' "$resp" | tail -1)"
  if [ "$code" = "200" ] || [ "$code" = "201" ]; then
    ok=$((ok+1)); printf 'batch %02d: ok\n' "$n"
  else
    printf 'batch %02d: FAILED (http %s): %s\n' "$n" "$code" "$(printf '%s' "$resp" | sed '$d' | head -c 400)"
    exit 1
  fi
done

echo "loaded $ok/$n batches; verifying..."
printf '%s' '{"query":"select count(*) foods, (select count(*) from public.food_servings) servings, (select count(*) from public.foods where micros is not null) with_micros from public.foods;"}' \
  | curl -s -X POST "$API" -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" --data @-
echo
