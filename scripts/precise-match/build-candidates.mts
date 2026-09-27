// Snapshot what our search returns for every eval line, so the eval measures
// Jev against a FIXED candidate list: a catalog load or a ranking change must
// not silently move the goalposts between two runs.
//
//   npx tsx scripts/precise-match/build-candidates.mts
//
// Mirrors production retrieval (searchCatalogWithServings in ai-coach
// index.ts): trigram top 8 + semantic top 6, trigram first, merged to 8. Reads
// only; writes scripts/precise-match/candidates.json. Costs one Voyage query
// embedding per line (fractions of a cent).
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { QUERIES } from "./queries";

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

const out: Record<string, Array<{ id: string; name: string; brand: string | null; source: string; kcal: number | null }>> = {};
for (const q of QUERIES) {
  const text = q.brand && !q.name.toLowerCase().includes(q.brand.toLowerCase()) ? `${q.brand} ${q.name}` : q.name;
  const tri = await admin.rpc("search_foods_ranked", { q: text, lim: 8 });
  if (tri.error) console.error(`trigram error for "${text}": ${tri.error.message}`);
  const vec = await embed(text);
  const sem = vec
    ? await admin.rpc("search_foods_semantic", { p_query_embedding: JSON.stringify(vec), lim: 6 })
    : { data: [], error: null };
  if (sem.error) console.error(`semantic error for "${text}": ${sem.error.message}`);

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of [...(tri.data ?? []), ...(sem.data ?? [])] as Array<{ id: string }>) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    ids.push(r.id);
    if (ids.length >= 8) break;
  }
  // The search RPCs do not return `source`; read it, keeping search order.
  const { data: rows } = await admin.from("foods").select("id, name, brand, source, kcal").in("id", ids);
  const byId = new Map((rows ?? []).map((r: any) => [r.id, r]));
  out[q.id] = ids.map((id) => byId.get(id)).filter(Boolean).map((r: any) => ({
    id: r.id, name: r.name, brand: r.brand, source: r.source, kcal: r.kcal === null ? null : Number(r.kcal),
  }));
  console.log(`${q.id.padEnd(20)} ${out[q.id].length} candidates`);
  // Voyage free tier is rate limited; a short gap keeps the snapshot whole.
  await new Promise((r) => setTimeout(r, 400));
}
writeFileSync("scripts/precise-match/candidates.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote scripts/precise-match/candidates.json");
