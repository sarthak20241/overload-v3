// Add protein/carb/fat to an existing candidates.json snapshot WITHOUT
// re-running search (ids and order stay exactly as labelled). Read only.
//   npx tsx scripts/precise-match/add-macros.mts
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const dotenv: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const admin = createClient(dotenv.EXPO_PUBLIC_SUPABASE_URL, dotenv.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const path = "scripts/precise-match/candidates.json";
const snap: Record<string, any[]> = JSON.parse(readFileSync(path, "utf8"));
const ids = [...new Set(Object.values(snap).flat().map((c) => c.id))];
const { data, error } = await admin.from("foods").select("id, protein_g, carb_g, fat_g").in("id", ids);
if (error) throw new Error(error.message);
const byId = new Map((data ?? []).map((r: any) => [r.id, r]));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
for (const list of Object.values(snap)) {
  for (const c of list) {
    const r = byId.get(c.id);
    c.protein_g = num(r?.protein_g);
    c.carb_g = num(r?.carb_g);
    c.fat_g = num(r?.fat_g);
  }
}
writeFileSync(path, JSON.stringify(snap, null, 2) + "\n");
console.log(`macros added for ${byId.size}/${ids.length} rows`);
