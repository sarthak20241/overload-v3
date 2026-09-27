// Give every Precise cache row without one a voyage-3 DOCUMENT embedding of its
// display_name, so the cache's meaning search (migration 0141) can find it.
// New rows get theirs when the edge function writes them; this covers rows
// written before 0141, and any row whose embedding call failed at write time.
//
//   npx tsx scripts/precise-match/backfill-cache-embeddings.mts
//
// Idempotent: only rows with a null embedding are touched. Writes ONLY the
// embedding column. Voyage's free tier rate-limits (429) at a few requests a
// minute, so a 429 waits and retries.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const dotenv: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const env = (k: string) => process.env[k] ?? dotenv[k] ?? "";
const admin = createClient(env("EXPO_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function embed(text: string): Promise<number[] | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("VOYAGE_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: [text.slice(0, 300)], model: "voyage-3", input_type: "document" }),
    });
    if (res.ok) return (await res.json())?.data?.[0]?.embedding ?? null;
    if (res.status !== 429) {
      console.error(`voyage ${res.status} for "${text}"`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 22_000));
  }
  return null;
}

const { data: rows, error } = await admin.from("precise_cache").select("id, display_name").is("embedding", null);
if (error) {
  console.error(`read failed (is migration 0141 applied?): ${error.message}`);
  process.exit(1);
}
let done = 0;
for (const r of rows ?? []) {
  const vec = await embed(r.display_name);
  if (!vec) continue;
  const { error: upErr } = await admin.from("precise_cache").update({ embedding: JSON.stringify(vec) }).eq("id", r.id);
  if (upErr) console.error(`update failed for "${r.display_name}": ${upErr.message}`);
  else done++;
}
console.log(`embedded ${done} of ${(rows ?? []).length} rows`);
