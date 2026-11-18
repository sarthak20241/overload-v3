// Swap tags on exercises (20261117120000) against a real Postgres (PGlite).
// Not in CI: it downloads PGlite. Run before applying the migration:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/exercise_swap_tags.check.ts
//
// What it pins: a catalog row and a user's row with the same name both get the
// tags; a name the file does not list stays untagged; muscle_group and the form
// checker's movement_pattern are not touched; a pattern outside the list is
// refused; the migration runs twice.

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const TAGS = await Deno.readTextFile(new URL("../20261117120000_exercise_swap_tags.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`create table public.exercises (
      id serial primary key, name text not null, muscle_group text, movement_pattern text, created_by text,
      name_lower text generated always as (lower(name)) stored);
    insert into exercises (name, muscle_group, movement_pattern, created_by) values
      ('Incline Dumbbell Press', 'Chest', 'horizontal_press', null),
      ('incline dumbbell press', 'Other', null, 'user_1'),
      ('Lateral Raise', 'Shoulders', 'none', null),
      ('Farmer''s Walk', 'Biceps', null, null),
      ('my own lift', 'Other', null, 'user_1');`);
  await pg.exec(TAGS);
  await pg.exec(TAGS); // re-runnable
  const q = async <T = Record<string, unknown>>(s: string) => (await pg.query<T>(s)).rows;
  return { pg, q };
}

Deno.test("catalog names get their tags; nothing else on the row moves", async () => {
  const { q } = await db();
  assertEquals(
    await q(`select name, muscle_group, movement_pattern, target_muscle, swap_pattern from exercises order by id`),
    [
      { name: "Incline Dumbbell Press", muscle_group: "Chest", movement_pattern: "horizontal_press", target_muscle: "Upper Chest", swap_pattern: "horizontal_press" },
      { name: "incline dumbbell press", muscle_group: "Other", movement_pattern: null, target_muscle: "Upper Chest", swap_pattern: "horizontal_press" },
      { name: "Lateral Raise", muscle_group: "Shoulders", movement_pattern: "none", target_muscle: "Side Delts", swap_pattern: "raise" },
      { name: "Farmer's Walk", muscle_group: "Biceps", movement_pattern: null, target_muscle: "Grip", swap_pattern: "carry" },
      { name: "my own lift", muscle_group: "Other", movement_pattern: null, target_muscle: null, swap_pattern: null },
    ],
  );
});

Deno.test("a pattern outside the list is refused", async () => {
  const { pg } = await db();
  await assertRejects(() => pg.exec(`update exercises set swap_pattern = 'bench' where id = 1`));
});
