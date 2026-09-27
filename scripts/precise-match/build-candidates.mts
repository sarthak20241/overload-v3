// Snapshot what our search returns for every eval line, so the eval measures
// Jev against a FIXED candidate list: a catalog load or a ranking change must
// not silently move the goalposts between two runs.
//
//   npx tsx scripts/precise-match/build-candidates.mts
//
// Mirrors production's our-sources retrieval (findMatchCandidates in ai-coach
// index.ts): trigram top 30 + semantic top 6, merged by selectMatchRows (the
// production helper) into 8 main rows plus up to 4 lab / curated rows. Reads
// only; writes scripts/precise-match/candidates.json, and ONLY when every
// search for every line succeeded: a snapshot with a silently empty leg would
// measure Jev against fewer rows than production offers.
//
// The committed candidates.json predates the extra lab rows (8 rows per line).
// Rebuilding changes candidate ids, so matchLabels.ts must be relabelled by
// hand after a rebuild, never remapped.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { QUERIES } from "./queries";
import { selectMatchRows } from "../../supabase/functions/ai-coach/ourSources";

const dotenv: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";
const admin = createClient(env("EXPO_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Voyage's free tier allows a few requests a minute. A snapshot missing its
 *  semantic leg would understate what production retrieves, so a 429 waits and
 *  retries rather than moving on. */
async function embed(q: string): Promise<number[] | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("VOYAGE_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: [q], model: "voyage-3", input_type: "query" }),
    });
    if (res.ok) {
      const j = await res.json();
      return j?.data?.[0]?.embedding ?? null;
    }
    if (res.status !== 429) {
      console.error(`voyage ${res.status} for "${q}"`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 22_000));
  }
  console.error(`voyage kept rate limiting "${q}"; semantic leg missing`);
  return null;
}

const out: Record<string, Array<{
  id: string; name: string; brand: string | null; source: string; kcal: number | null; protein_g: number | null;
}>> = {};
const failures: string[] = [];
for (const q of QUERIES) {
  const text = q.brand && !q.name.toLowerCase().includes(q.brand.toLowerCase()) ? `${q.brand} ${q.name}` : q.name;
  const tri = await admin.rpc("search_foods_ranked", { q: text, lim: 30 });
  if (tri.error) failures.push(`${q.id}: trigram ${tri.error.message}`);
  const vec = await embed(text);
  if (!vec) failures.push(`${q.id}: no query embedding`);
  const sem = vec
    ? await admin.rpc("search_foods_semantic", { p_query_embedding: JSON.stringify(vec), lim: 6 })
    : { data: [], error: null };
  if (sem.error) failures.push(`${q.id}: semantic ${sem.error.message}`);

  const triRows = ((tri.data ?? []) as Array<{ id: string }>).map((r) => ({ id: String(r.id) }));
  const semRows = ((sem.data ?? []) as Array<{ id: string }>).map((r) => ({ id: String(r.id) }));
  const allIds = [...new Set([...triRows, ...semRows].map((r) => r.id))];
  // The search RPCs do not return `source`; read it for every row, then let
  // the production helper choose.
  const { data: srcRows, error: srcErr } = allIds.length
    ? await admin.from("foods").select("id, source").in("id", allIds)
    : { data: [], error: null };
  if (srcErr) failures.push(`${q.id}: foods read ${srcErr.message}`);
  const sourceOf = new Map((srcRows ?? []).map((r: any) => [r.id, r.source]));
  const ids = selectMatchRows(triRows, semRows, (id) => sourceOf.get(id)).map((r) => r.id);
  const { data: rows, error: rowErr } = ids.length
    ? await admin.from("foods").select("id, name, brand, source, kcal, protein_g").in("id", ids)
    : { data: [], error: null };
  if (rowErr) failures.push(`${q.id}: foods read ${rowErr.message}`);
  const byId = new Map((rows ?? []).map((r: any) => [r.id, r]));
  out[q.id] = ids.map((id) => byId.get(id)).filter(Boolean).map((r: any) => ({
    id: r.id, name: r.name, brand: r.brand, source: r.source, kcal: r.kcal === null ? null : Number(r.kcal),
    protein_g: r.protein_g === null ? null : Number(r.protein_g),
  }));
  console.log(`${q.id.padEnd(20)} ${out[q.id].length} candidates`);
  // Voyage free tier is rate limited; a short gap keeps the snapshot whole.
  await new Promise((r) => setTimeout(r, 400));
}
if (failures.length) {
  console.error(`\n${failures.length} retrieval failure(s); candidates.json NOT written:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
writeFileSync("scripts/precise-match/candidates.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote scripts/precise-match/candidates.json");
