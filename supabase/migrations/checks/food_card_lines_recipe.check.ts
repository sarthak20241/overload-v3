// food_card_lines.recipe (20261108120000) against a real Postgres (PGlite).
// Not in CI: it downloads PGlite. Run before applying the migration:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/food_card_lines_recipe.check.ts
//
// What it pins: a dish line's parts are written and read back as they were; a
// line with no parts, or with parts that are not a list, stores none; the
// migration runs twice.

import { assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const THREADS = await Deno.readTextFile(new URL("../20261106120000_food_threads.sql", import.meta.url));
const RECIPE = await Deno.readTextFile(new URL("../20261108120000_food_card_lines_recipe.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table public.user_profiles (clerk_user_id text primary key);`);
  await pg.exec(THREADS);
  await pg.exec(RECIPE);
  await pg.exec(RECIPE); // re-runnable
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  return { q };
}

const PARTS = [
  { name: "low fat paneer", grams: 60, per100: { kcal: 254, protein_g: 25, carb_g: 4, fat_g: 15 }, source: "catalog" },
  { name: "oil", grams: 5, per100: { kcal: 884, protein_g: 0, carb_g: 0, fat_g: 100 }, source: "catalog", assumed: true },
];

Deno.test("food_card_write keeps a dish's parts, and stores none for other lines", async () => {
  const { q } = await db();
  const [t] = await q<{ id: string }>(`insert into food_threads (user_id) values ('u1') returning id`);
  const id = "44444444-4444-4444-8444-444444444444";
  const lines = [
    { line_id: "L1", name: "Paneer sabji", kcal: 197, source: "recipe", recipe: PARTS },
    { line_id: "L2", name: "Rice", kcal: 195, source: "catalog" },
    { line_id: "L3", name: "Odd", kcal: 10, source: "recipe", recipe: { not: "a list" } },
  ];
  await q(`select food_card_create($1, $2, 'meal', $3::jsonb, 'm1', 'lunch')`, [id, t.id, JSON.stringify(lines)]);
  const rows = await q<{ line_id: string; recipe: unknown }>(`select line_id, recipe from food_card_lines where card_id = $1 order by line_no`, [id]);
  assertEquals(rows, [{ line_id: "L1", recipe: PARTS }, { line_id: "L2", recipe: null }, { line_id: "L3", recipe: null }]);
});
