// Prints the SQL that shows, on the live database, what the step 4 clean-up
// (migration 20261107120000) would do to each remembered food. It writes
// nothing: the migration's plan functions are created as TEMPORARY functions
// (pg_temp, gone when the session ends) and only read the tables.
//
//   npx tsx scripts/food-memory-cleanup/dry-run.mts > /tmp/dry-run.sql
//
// Run the printed SQL with the Supabase MCP execute_sql (or psql). It works
// before the migration is applied: the plan reads the new columns through
// to_jsonb(), so a missing column reads as null.
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../supabase/migrations/20261107120000_food_memory_sources.sql", import.meta.url), "utf8");
const start = sql.indexOf("-- >>> plan");
const end = sql.indexOf("-- <<< plan");
if (start < 0 || end < 0) throw new Error("plan markers not found");
const body = sql.slice(start, end)
  // The section opens with its own comment lines; keep only the functions.
  .replace(/food_memory_private\./g, "pg_temp.");
const summary = process.argv.includes("--rows")
  ? `select left(user_id, 12) as user_id, food_name, new_name, old_source, new_origin, copied_from, proof,
       case when action like 'merge%' then 'merge' else action end as action
from pg_temp.plan_food_memory_cleanup() order by user_id, new_origin, proof, food_name;`
  : `
select new_origin, proof, coalesce(old_source, '(none)') as old_source, action like 'merge%' as merged,
       action = 'rename' as renamed, count(*) as rows, count(distinct user_id) as users
from pg_temp.plan_food_memory_cleanup() group by 1, 2, 3, 4, 5 order by 1, 2, 3;`;
process.stdout.write(body + "\n" + summary + "\n");
