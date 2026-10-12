// Actual migrations against disposable PostgreSQL; never connects to Supabase.
// deno test --no-lock --node-modules-dir=none --allow-read scripts/coach-memory-eval/migration.test.ts
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const history = Deno.readTextFileSync(
  new URL("20260919023437_coach_memory.sql", migrations),
);
const repair = Deno.readTextFileSync(
  new URL("20261001023134_coach_memory_cleanup_and_cap.sql", migrations),
);
const baseline = Deno.readTextFileSync(
  new URL("0121_drona_cards.sql", migrations),
);
const baselineCleanup = baseline.slice(
  baseline.indexOf("create or replace function public.delete_user_data("),
);

// Only the columns used by account cleanup are needed. Real memory schema,
// RLS and RPC definitions come directly from the migration files above.
const ownedTables = [
  "coach_program_phases",
  "coach_programs",
  "user_exercise_notes",
  "user_lift_stats",
  "user_volume_stats",
  "meals",
  "user_nutrition_stats",
  "daily_metrics",
  "body_measurements",
  "drona_cards",
  "coach_traces",
  "ai_coach_rate_limit",
  "weekly_reports",
  "bug_reports",
];
const optionalTables = [
  "readiness_parts",
  "drona_day_facts",
  "drona_training_day_facts",
  "drona_exercise_week_facts",
  "drona_muscle_week_facts",
  "drona_pick_muscle_day_facts",
  "drona_plan_muscle_week_facts",
  "drona_recovery_day_facts",
  "drona_word_facts",
  "drona_week_facts",
  "plan_changes",
  "routine_snapshots",
];

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create function public.current_clerk_user_id() returns text language sql stable
      as $$ select current_setting('request.jwt.claims', true)::jsonb->>'sub' $$;
    create table workouts (id text primary key, user_id text);
    create table workout_sets (workout_id text references workouts(id));
    create table routines (id text primary key, user_id text);
    create table routine_exercises (routine_id text references routines(id));
    create table coach_trials (clerk_user_id text);
    create table user_profiles (clerk_user_id text primary key);
    ${ownedTables.map((t) => `create table ${t} (user_id text);`).join("\n")}
  `);
  await db.exec(baselineCleanup);
  await db.exec(history);
  return db;
}

async function asUser(db: PGlite, id: string) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: id }),
  ]);
  await db.exec("set role authenticated");
}

async function seedAccounts(db: PGlite, optional: boolean) {
  if (optional) {
    await db.exec(`
      ${
      optionalTables.map((t) => `create table ${t} (user_id text);`).join("\n")
    }
      create table coach_conversations (id text primary key, user_id text);
      create table coach_conversation_messages (conversation_id text references coach_conversations(id));
    `);
  }
  const tables = [...ownedTables, ...(optional ? optionalTables : [])];
  for (const id of ["delete-me", "keep-me"]) {
    for (const table of tables) {
      await db.query(`insert into ${table} values ($1)`, [id]);
    }
    await db.query("insert into user_profiles values ($1)", [id]);
    await db.query("insert into coach_trials values ($1)", [id]);
    await db.query("insert into workouts values ($1, $1)", [id]);
    await db.query("insert into workout_sets values ($1)", [id]);
    await db.query("insert into routines values ($1, $1)", [id]);
    await db.query("insert into routine_exercises values ($1)", [id]);
    await db.query(
      "insert into coach_memory (user_id, category, key, value) values ($1, 'injury', 'acl', 'ACL history')",
      [id],
    );
    if (optional) {
      await db.query("insert into coach_conversations values ($1, $1)", [id]);
      await db.query("insert into coach_conversation_messages values ($1)", [
        id,
      ]);
    }
  }
  return tables;
}

for (const optional of [false, true]) {
  Deno.test(`account deletion is isolated and authorized, with facts tables ${optional ? "present" : "absent"}`, async () => {
    const db = await fixture();
    try {
      const tables = await seedAccounts(db, optional);
      await db.exec(repair);
      // The repair can also be replayed without replacing/removing data.
      await db.exec(repair);
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`set role ${role}`);
        await assertRejects(
          () => db.query("select public.delete_user_data('delete-me')"),
          Error,
          "permission denied",
        );
        await db.exec("reset role");
      }
      await db.exec("set role service_role");
      await db.query("select public.delete_user_data('delete-me')");
      await db.exec("reset role");
      for (
        const table of [
          ...tables,
          "coach_memory",
          "workouts",
          "routines",
          ...(optional ? ["coach_conversations"] : []),
        ]
      ) {
        const { rows } = await db.query(
          `select distinct user_id from ${table}`,
        );
        assertEquals(rows, [{ user_id: "keep-me" }], table);
      }
      for (const table of ["user_profiles", "coach_trials"]) {
        assertEquals((await db.query(`select * from ${table}`)).rows, [{
          clerk_user_id: "keep-me",
        }]);
      }
      assertEquals((await db.query("select * from workout_sets")).rows, [{
        workout_id: "keep-me",
      }]);
      assertEquals((await db.query("select * from routine_exercises")).rows, [{
        routine_id: "keep-me",
      }]);
      if (optional) {
        assertEquals(
          (await db.query("select * from coach_conversation_messages")).rows,
          [{ conversation_id: "keep-me" }],
        );
      }
    } finally {
      await db.close();
    }
  });
}

Deno.test("the forward repair caps reactivated facts and preserves forgotten facts and ownership", async () => {
  const db = await fixture();
  try {
    await db.exec(`
      insert into coach_memory (user_id, category, key, value, status)
        values ('owner', 'injury', 'acl', 'Old ACL fact', 'dismissed'),
               ('owner', 'other', 'forgotten', 'Never re-learn this', 'dismissed'),
               ('someone-else', 'other', 'private', 'Other account', 'active');
      insert into coach_memory (user_id, category, key, value, updated_at)
        select 'owner', 'other', 'fact-' || n, 'Fact ' || n, now() - n * interval '1 minute'
        from generate_series(1, 60) n;
    `);
    await asUser(db, "owner");
    await db.query(
      "select public.coach_remember_fact('injury', 'acl', 'New ACL fact', 'chat')",
    );
    // Reproduces the reviewed bug in the historical function.
    assertEquals(
      (await db.query(
        "select count(*)::int as n from coach_memory where status = 'active'",
      )).rows,
      [{ n: 61 }],
    );
    await db.exec("reset role");
    await db.exec(repair);
    await asUser(db, "owner");
    const { rows } = await db.query<
      { result: { saved: boolean; updated: boolean } }
    >("select public.coach_remember_fact('injury', 'acl', 'Updated ACL fact', 'chat') as result");
    assertEquals(rows[0].result.saved, true);
    assertEquals(rows[0].result.updated, true);
    assertEquals(
      (await db.query(
        "select count(*)::int as n from coach_memory where status = 'active'",
      )).rows,
      [{ n: 60 }],
    );
    assertEquals(
      (await db.query(
        "select value, status from coach_memory where key = 'acl'",
      )).rows,
      [{ value: "Updated ACL fact", status: "active" }],
    );
    assertEquals(
      (await db.query("select key from coach_memory where key = 'fact-60'"))
        .rows,
      [],
    );
    assertEquals(
      (await db.query(
        "select status from coach_memory where key = 'forgotten'",
      )).rows,
      [{ status: "dismissed" }],
    );
    assertEquals(
      (await db.query(
        "select * from coach_memory where user_id = 'someone-else'",
      )).rows,
      [],
    );
    const denied = await db.query<{ result: { saved: boolean } }>(
      "select public.coach_remember_fact('other', 'forgotten', 'Never re-learn this', 'chat') as result",
    );
    assertEquals(denied.rows[0].result.saved, false);
    await assertRejects(
      () => db.query("delete from coach_memory"),
      Error,
      "permission denied",
    );
    await db.query(
      "select public.coach_remember_fact('other', 'new-slot', 'New fact', 'chat')",
    );
    assertEquals(
      (await db.query(
        "select count(*)::int as n from coach_memory where status = 'active'",
      )).rows,
      [{ n: 60 }],
    );
    assert(
      (await db.query("select key from coach_memory where key = 'new-slot'"))
        .rows.length === 1,
    );
    await db.exec("reset role");
    assertEquals(
      (await db.query(
        "select value from coach_memory where user_id = 'someone-else'",
      )).rows,
      [{ value: "Other account" }],
    );
  } finally {
    await db.close();
  }
});

Deno.test("remember and forget acquire the same per-user transaction lock", async () => {
  const db = await fixture();
  try {
    await db.exec(repair);
    await asUser(db, "owner");
    await db.query(
      "select public.coach_remember_fact('injury', 'acl', 'ACL history', 'chat')",
    );
    await db.exec("begin");
    await db.query("select public.coach_forget_fact('acl', 'injury')");
    const forgottenLocks = (await db.query(
      "select classid, objid, objsubid, mode from pg_locks where locktype = 'advisory' and granted",
    )).rows;
    assertEquals(
      forgottenLocks.length,
      1,
      "forget must hold its transaction lock",
    );
    const rejected = await db.query<{ result: { saved: boolean } }>(
      "select public.coach_remember_fact('injury', 'acl', 'ACL history', 'chat') as result",
    );
    assertEquals(rejected.rows[0].result.saved, false);
    const rememberLocks = (await db.query(
      "select classid, objid, objsubid, mode from pg_locks where locktype = 'advisory' and granted",
    )).rows;
    assertEquals(
      rememberLocks,
      forgottenLocks,
      "remember must use the same user lock",
    );
    await db.exec("commit");
    assertEquals(
      (await db.query(
        "select * from pg_locks where locktype = 'advisory' and granted",
      )).rows,
      [],
    );
  } finally {
    await db.close();
  }
});
