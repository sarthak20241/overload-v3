// Live smoke test of matchOurSources: real catalog search + real Jev, reads only.
//   npx tsx scripts/precise-match/live-smoke.mts
// Costs Jev + one Voyage embedding per food; no Anthropic credit, no writes.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { matchOurSources, selectMatchRows } from "../../supabase/functions/ai-coach/ourSources";

const env: Record<string, string> = {};
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const admin = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function embed(q: string) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://api.voyageai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: [q], model: "voyage-3", input_type: "query" }) });
    if (r.ok) return (await r.json()).data[0].embedding;
    if (r.status !== 429) return null;
    await new Promise((res) => setTimeout(res, 22000));
  }
  return null;
}
async function findCandidates(item: { name: string; brand: string | null }) {
  const q = item.brand && !item.name.toLowerCase().includes(item.brand.toLowerCase()) ? `${item.brand} ${item.name}` : item.name;
  const tri = ((await admin.rpc("search_foods_ranked_with_servings", { q, lim: 30 })).data ?? []) as any[];
  const vec = await embed(q);
  const sem = vec ? (((await admin.rpc("search_foods_semantic_with_servings", { p_query_embedding: JSON.stringify(vec), lim: 6 })).data ?? []) as any[]) : [];
  const ids = [...new Set([...tri, ...sem].map((r) => String(r.id)))];
  const { data: src } = await admin.from("foods").select("id, source").in("id", ids);
  const sourceOf = new Map((src ?? []).map((r: any) => [r.id, r.source]));
  return selectMatchRows(tri.map((r) => ({ ...r, id: String(r.id) })), sem.map((r) => ({ ...r, id: String(r.id) })), (id) => sourceOf.get(id))
    .map((r: any) => ({ food: r, meta: { id: r.id, name: r.name, brand: r.brand ?? null, source: sourceOf.get(r.id) ?? "catalog", kcal: Number(r.kcal), protein_g: Number(r.protein_g) } }));
}
for (const item of [
  { name: "rolled oats", brand: null }, { name: "cashews", brand: null }, { name: "Parle-G biscuits", brand: "Parle" },
  { name: "chole bhature", brand: null }, { name: "boiled egg", brand: null },
]) {
  const r = await matchOurSources({ jev: { apiKey: env.JEV_API_KEY, timeoutMs: 20000 }, findCandidates }, item);
  const t = r.trace as any;
  console.log(`\n## ${item.brand ? item.brand + " | " : ""}${item.name}  kind=${t.kind} (${t.kind_answer?.conf})  candidates=${t.candidates}`);
  for (const row of (t.rows ?? []).slice(0, 12)) console.log(`   ${String(row.score).padEnd(5)} ${row.source.padEnd(12)} ${String(row.kcal).padEnd(6)} ${row.name}`);
  if (t.tiebreak) console.log(`   TIE ${JSON.stringify(t.tiebreak)}`);
  console.log(`   => ${JSON.stringify(t.decision)}`);
}
