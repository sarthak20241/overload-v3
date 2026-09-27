/**
 * Nightly cache-to-catalog promotion (Phase 7d). The IO half; every rule it
 * applies lives in supabase/functions/ai-coach/promoteCache.ts, unit tested.
 *
 * WHY IT IS A JOB AND NOT PART OF A PARSE. Promotion writes to the shared catalog,
 * which every user searches. That work has no business happening on a person's
 * latency budget, and a mistake made at 3am can be found before thousands of meals
 * are logged against it. "Never inline with a parse" is a rule from the plan, and
 * this file is how it is kept.
 *
 * WHY DENO AND NOT tsx LIKE tools/research-ingest. The rules it enforces are shared
 * with the edge function that writes the cache in the first place, and those live
 * in the Deno tree. One runtime means one import graph and one `deno check`, rather
 * than a Node copy of the bar that can drift away from the copy Super uses.
 *
 * Run:
 *   deno run --node-modules-dir=none --allow-env --allow-net \
 *     tools/promote-food-cache/run.ts [--dry-run] [--limit=N]
 * The --node-modules-dir=none is not optional locally: the repo root holds the
 * React Native node_modules, and Deno otherwise tries to resolve supabase-js's npm
 * dependencies out of it and fails. Same flag for `deno check`.
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: precise_cache is granted to
 * service_role and nobody else (see migration 0109).
 *
 * And JEV_API_KEY. Before a row is published, Jev is asked the same "is one of
 * these catalog rows this food?" questions Precise asks live (ourSources.ts), so
 * "eggs" links to USDA's egg instead of becoming a second egg. Without the key,
 * or when Jev cannot answer, NOTHING new is published (skip:match-unavailable);
 * links and refreshes of rows already published still run.
 *
 * --audit: also ask Jev about rows ALREADY published, and print the ones that
 * duplicate another catalog row. Prints only; retiring a row is a human's call.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  applyCatalogMatch,
  brandFromName,
  type CatalogMatch,
  type CatalogRow,
  type PromotionCandidate,
  promotionDecision,
} from "../../supabase/functions/ai-coach/promoteCache.ts";
import { matchOurSources, selectMatchRows } from "../../supabase/functions/ai-coach/ourSources.ts";
import type { MatchCandidate } from "../../supabase/functions/ai-coach/preciseMatch.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}

const JEV_API_KEY = Deno.env.get("JEV_API_KEY") ?? "";

const args = Deno.args;
const DRY_RUN = args.includes("--dry-run");
const AUDIT = args.includes("--audit");
// Validated, not just parsed. The workflow passes whatever an operator typed
// into the Actions box straight through, and `Number("200 --dry-run")` is NaN,
// which PostgREST turns into `.limit(NaN)` - a request that either errors far
// from here or silently returns nothing. A bad value should stop the run where
// it was typed, with the value in the message.
const rawLimit = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = rawLimit === undefined ? 200 : Number(rawLimit);
if (!Number.isInteger(LIMIT) || LIMIT < 1 || LIMIT > 5000) {
  console.error(`--limit must be a whole number between 1 and 5000, got ${JSON.stringify(rawLimit)}`);
  Deno.exit(2);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** Catalog rows the promotion decision needs to see: what plain search would find
 *  for this name, plus the row we already published if there is one. Search is the
 *  right lens because the duplicate that matters is the one that would COMPETE
 *  with ours in the ranking. */
async function catalogNeighbours(cand: PromotionCandidate): Promise<CatalogRow[]> {
  const query = cand.brand && !cand.display_name.toLowerCase().includes(cand.brand.toLowerCase())
    ? `${cand.brand} ${cand.display_name}`
    : cand.display_name;

  const ids = new Set<string>();
  const { data: hits, error } = await db.rpc("search_foods_ranked", { q: query, lim: 10 });
  if (error) throw new Error(`search_foods_ranked failed for "${query}": ${error.message}`);
  for (const h of hits ?? []) ids.add((h as { id: string }).id);
  if (cand.promoted_food_id) ids.add(cand.promoted_food_id);
  if (ids.size === 0) return [];

  // search_foods_ranked does not return `source` or `last_verified_at`, and the
  // decision needs both (one to say what it would be overwriting, one to know
  // whether our evidence is newer). One extra read per candidate, off the hot path.
  const { data: rows, error: rowsErr } = await db
    .from("foods")
    .select("id,name,brand,kcal,protein_g,carb_g,fat_g,source,last_verified_at")
    .in("id", [...ids]);
  if (rowsErr) throw new Error(`foods lookup failed: ${rowsErr.message}`);
  return (rows ?? []) as CatalogRow[];
}

/** Every page of a query, 1000 rows at a time (PostgREST's cap). */
// deno-lint-ignore no-explicit-any
async function allRows<T>(build: () => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) return out;
  }
}

const foldBrand = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** What brandFromName needs: every brand the catalog and the cache know, and
 *  every word of a lab or curated food name. Read once per run. */
async function brandLexicon(): Promise<{ brands: Set<string>; foodWords: Set<string> }> {
  const [catalogBrands, cacheBrands, labNames] = await Promise.all([
    allRows<{ brand: string }>(() => db.from("foods").select("brand").not("brand", "is", null).is("created_by", null)),
    allRows<{ brand: string }>(() => db.from("precise_cache").select("brand").not("brand", "is", null)),
    allRows<{ name: string }>(() => db.from("foods").select("name").in("source", ["usda", "cofid", "ciqual", "curated"])),
  ]);
  const brands = new Set<string>();
  for (const r of [...catalogBrands, ...cacheBrands]) {
    const b = foldBrand(r.brand);
    if (b.length >= 3) brands.add(b);
  }
  const foodWords = new Set<string>();
  for (const r of labNames) for (const w of foldBrand(r.name).split(" ")) if (w) foodWords.add(w);
  return { brands, foodWords };
}

/** Catalog rows Jev judges for this cache row: the same trigram + semantic mix
 *  Precise's live match uses (selectMatchRows), minus `exclude` (the row we
 *  published from it, when auditing). Semantic search uses the row's own 0141
 *  embedding, so no embedding call is made here. */
async function matchCandidates(
  cand: PromotionCandidate,
  exclude: string | null,
): Promise<Array<{ food: MatchCandidate; meta: MatchCandidate }>> {
  const query = cand.brand && !cand.display_name.toLowerCase().includes(cand.brand.toLowerCase())
    ? `${cand.brand} ${cand.display_name}`
    : cand.display_name;
  const { data: embRow } = await db.from("precise_cache").select("embedding").eq("id", cand.id).maybeSingle();
  const embedding = (embRow as { embedding?: string | null } | null)?.embedding ?? null;
  const [tri, sem] = await Promise.all([
    db.rpc("search_foods_ranked_with_servings", { q: query, lim: 30 }),
    embedding
      ? db.rpc("search_foods_semantic_with_servings", { p_query_embedding: embedding, lim: 6 })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (tri.error) throw new Error(`trigram search failed for "${query}": ${tri.error.message}`);
  if (sem.error) throw new Error(`semantic search failed for "${query}": ${sem.error.message}`);
  type Hit = { id: string; name: string; brand: string | null; kcal: number | null; protein_g: number | null };
  const keep = (rows: unknown) => ((rows ?? []) as Hit[]).filter((r) => r.id !== exclude);
  const trigram = keep(tri.data);
  const semantic = keep(sem.data);
  const ids = [...new Set([...trigram, ...semantic].map((r) => r.id))];
  if (ids.length === 0) return [];
  const { data: srcRows, error } = await db.from("foods").select("id, source").in("id", ids);
  if (error) throw new Error(`foods source lookup failed: ${error.message}`);
  const sourceOf = new Map(((srcRows ?? []) as Array<{ id: string; source: string }>).map((r) => [r.id, r.source]));
  return selectMatchRows(trigram, semantic, (id) => sourceOf.get(id)).map((r) => {
    const meta: MatchCandidate = {
      id: r.id,
      name: r.name,
      brand: r.brand,
      source: sourceOf.get(r.id) ?? "catalog",
      kcal: r.kcal === null ? null : Number(r.kcal),
      protein_g: r.protein_g === null ? null : Number(r.protein_g),
    };
    return { food: meta, meta };
  });
}

/** Jev's verdict on "is this food already in the catalog?". Anything short of a
 *  clear answer is "unavailable", which publishes nothing. An unsure KIND counts
 *  as unclear too: the match then falls back to the packaged rule, which can
 *  never pick an unbranded lab row, so a plain food would look new every time. */
async function catalogMatch(cand: PromotionCandidate, exclude: string | null = null): Promise<CatalogMatch> {
  if (!JEV_API_KEY) return { status: "unavailable", detail: "no JEV_API_KEY" };
  let searchError: string | null = null;
  const res = await matchOurSources<MatchCandidate>({
    jev: { apiKey: JEV_API_KEY, timeoutMs: 20_000 },
    findCandidates: () =>
      matchCandidates(cand, exclude).catch((e) => {
        searchError = String(e instanceof Error ? e.message : e).slice(0, 160);
        throw e;
      }),
  }, { name: cand.display_name, brand: cand.brand });
  if (searchError) return { status: "unavailable", detail: searchError };
  const t = res.trace as { kind?: string | null; candidates?: number; decision?: { reason?: string } };
  if (res.match) {
    const m = res.match.meta;
    return { status: "matched", row: { id: m.id, name: m.name, source: m.source, kcal: Number(m.kcal ?? NaN) } };
  }
  if (t.candidates === 0) return { status: "none" };
  if (!t.kind) return { status: "unavailable", detail: "Jev unsure what kind of food this is" };
  const reason = t.decision?.reason ?? "";
  if (reason.startsWith("jev")) return { status: "unavailable", detail: reason };
  return { status: "none" };
}

async function markPromoted(cacheId: string, foodId: string) {
  const { error } = await db
    .from("precise_cache")
    .update({ promoted_food_id: foodId, promoted_at: new Date().toISOString() })
    .eq("id", cacheId);
  if (error) throw new Error(`marking cache row ${cacheId} promoted failed: ${error.message}`);
}

async function insertFood(cand: PromotionCandidate, agreeing: string[]): Promise<string> {
  const { data, error } = await db
    .from("foods")
    .insert({
      name: cand.display_name,
      brand: cand.brand,
      base_unit: cand.base_unit,
      kcal: cand.kcal,
      protein_g: cand.protein_g,
      carb_g: cand.carb_g,
      fat_g: cand.fat_g,
      fiber_g: cand.fiber_g,
      source: "web_verified",
      // Which datasets contributed. Keeps an OFF-derived row identifiable for
      // ODbL after promotion, the same reason `foods.sources` exists (0066).
      sources: agreeing,
      last_verified_at: cand.last_verified_at,
      // Explicitly global. The column default is auth.jwt()->>'sub', and a row
      // accidentally tagged to a caller is private to them (the bug 0036 fixed
      // for exercises).
      created_by: null,
    })
    .select("id")
    .single();

  if (error) {
    // uq_foods_name_global. Something with this exact name arrived between our
    // dedup read and this write, so treat it as the duplicate it is.
    if (error.code === "23505") {
      const { data: existing } = await db
        .from("foods")
        .select("id")
        .is("created_by", null)
        .ilike("name", cand.display_name)
        .maybeSingle();
      if (existing?.id) return existing.id as string;
    }
    throw new Error(`inserting ${cand.display_name} failed: ${error.message}`);
  }

  const foodId = (data as { id: string }).id;
  const anchors = (cand.servings ?? []).filter((s) => s?.label && s.grams > 0);
  if (anchors.length > 0) {
    const { error: sErr } = await db.from("food_servings").insert(
      anchors.map((s, i) => ({
        food_id: foodId,
        label: s.label,
        grams: s.grams,
        is_default: i === 0,
        source: "web_verified",
        seq: i,
      })),
    );
    // A row with no serving anchors is usable (grams still work), so a failure
    // here is worth reporting but not worth failing the promotion over.
    if (sErr) console.warn(`  servings for ${cand.display_name} failed: ${sErr.message}`);
  }
  return foodId;
}

async function refreshFood(foodId: string, cand: PromotionCandidate, agreeing: string[]) {
  const { error } = await db
    .from("foods")
    .update({
      // Only ever fills a brand in: a published brand is never overwritten.
      ...(cand.brand ? { brand: cand.brand } : {}),
      kcal: cand.kcal,
      protein_g: cand.protein_g,
      carb_g: cand.carb_g,
      fat_g: cand.fat_g,
      fiber_g: cand.fiber_g,
      sources: agreeing,
      last_verified_at: cand.last_verified_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", foodId)
    // Only ever rewrite a row we published. Curated, USDA and OFF rows are not
    // ours to edit from an unattended job.
    .eq("source", "web_verified");
  if (error) throw new Error(`refreshing ${foodId} failed: ${error.message}`);
}

async function main() {
  // UNPROMOTED ROWS FIRST, and the LIMIT is why it matters. The view carries
  // both kinds - rows never promoted, and promoted rows kept in scope so a
  // re-verification can refresh the catalog copy. Re-verifying bumps
  // last_verified_at, so promoted rows keep floating to the top of a
  // recency-only sort. Once there are more than LIMIT of them, every run fills
  // its budget with rows that answer "already-current" and a row that has never
  // reached the catalog is never even looked at. Nothing surfaces that: the run
  // reports success, having promoted nothing.
  //
  // promoted_food_id is null for unpromoted rows, so nullsFirst puts the work
  // that actually publishes ahead of the work that merely re-checks.
  const { data, error } = await db
    .from("precise_cache_promotable")
    .select("*")
    .order("promoted_food_id", { ascending: true, nullsFirst: true })
    .order("last_verified_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw new Error(`reading precise_cache_promotable failed: ${error.message}`);

  const candidates = (data ?? []) as PromotionCandidate[];
  const now = new Date();
  const tally: Record<string, number> = {};
  const count = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);

  console.log(`${candidates.length} cache rows in scope${DRY_RUN ? " (dry run)" : ""}`);
  if (!JEV_API_KEY) console.log("JEV_API_KEY is not set: no new rows will be published this run");

  const { brands, foodWords } = await brandLexicon();

  for (const cand of candidates) {
    if (!cand.brand) {
      const found = brandFromName(cand.display_name, brands, foodWords);
      if (found) {
        console.log(`  brand "${found}" found in "${cand.display_name}"`);
        cand.brand = found;
      }
    }
    const neighbours = await catalogNeighbours(cand);
    let decision = promotionDecision(cand, neighbours, now);
    if (decision.action === "promote") decision = applyCatalogMatch(decision, cand, await catalogMatch(cand));

    if (AUDIT && cand.promoted_food_id && neighbours.find((r) => r.id === cand.promoted_food_id)?.source === "web_verified") {
      const dup = await catalogMatch(cand, cand.promoted_food_id);
      if (dup.status === "matched") {
        console.log(`? ${cand.display_name} (published ${cand.promoted_food_id}) duplicates ${dup.row.name} (${dup.row.source}, ${dup.row.kcal} kcal, ${dup.row.id})`);
      }
    }

    switch (decision.action) {
      case "promote": {
        count("promote");
        console.log(`+ ${cand.display_name}  ${cand.kcal} kcal/100${cand.base_unit}  [${decision.agreeing.join(", ")}]`);
        if (DRY_RUN) break;
        await markPromoted(cand.id, await insertFood(cand, decision.agreeing));
        break;
      }
      case "refresh": {
        count("refresh");
        console.log(`~ ${cand.display_name} -> ${cand.kcal} kcal (re-verified)`);
        if (DRY_RUN) break;
        await refreshFood(decision.food_id, cand, decision.agreeing);
        break;
      }
      case "link": {
        count("link");
        console.log(`= ${cand.display_name} already in the catalog as ${decision.food_id}`);
        if (DRY_RUN) break;
        await markPromoted(cand.id, decision.food_id);
        break;
      }
      case "skip": {
        count(`skip:${decision.reason}`);
        // Conflicts are the only skip a human needs to look at: the catalog and
        // the web disagree about a food we are already serving.
        if (decision.reason === "catalog-conflict") {
          console.log(`! ${cand.display_name}: ${decision.detail}`);
        }
        if (decision.reason === "match-unavailable" || decision.reason === "unverified") {
          console.log(`- ${cand.display_name}: ${decision.reason} (${decision.detail})`);
        }
        break;
      }
    }
  }

  console.log("\nsummary");
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(28)} ${v}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  Deno.exit(1);
});
