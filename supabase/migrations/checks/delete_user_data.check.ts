// Account delete (delete_user_data) against a real Postgres (PGlite) with the
// live table shapes (fixtures/live_tables.sql). Not in CI: it downloads PGlite.
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/delete_user_data.check.ts
//
// Two test users, A and B, each get one row in EVERY table: a column that
// names an account gets their id, a column with an ON DELETE CASCADE (or NOT
// NULL) foreign key points at their own parent row, and every other column
// gets a made-up value. A row belongs to a user when it names them or hangs
// off their row by such a key. Then a few rows cross between users (B trains
// with A's custom exercise, C redeems A's code). Then delete_user_data(A).
//
// What it pins:
// - every row of A's is gone, except the rows kept on purpose (the cost
//   ledger, used store codes, custom exercises someone else trains with,
//   invite codes someone else redeemed), and those no longer name A;
// - no row in any table holds A's id or A's email anywhere, even in json;
// - every row of B's and every shared row is still there, unchanged;
// - SECURITY DEFINER, search_path, and execute for service_role only;
// - the live body from before this change fails the same check.
//
// A table added later is covered once fixtures/live_tables.sql is regenerated
// (how: top of that file). A new column that names an account needs its name
// in OWNER_COLS below.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const TABLES = await Deno.readTextFile(new URL("./fixtures/live_tables.sql", import.meta.url));
const NEW_FN = await Deno.readTextFile(new URL("../20261121120000_delete_user_data_leftovers.sql", import.meta.url));
const OLD_FN = await Deno.readTextFile(new URL("./fixtures/delete_user_data_live_20261121.sql", import.meta.url));

const A = "user_del_A_7f3c";
const B = "user_del_B_9d1e";
const C = "user_del_C_2b8a";
const D = "user_del_D_5e0f";
const EMAIL: Record<string, string> = { [A]: "del-a@example.test", [B]: "del-b@example.test" };

// Columns that name an account.
const OWNER_COLS = new Set(["user_id", "clerk_user_id", "owner_clerk_user_id", "redeemed_by_clerk_user_id", "created_by"]);
// Same names, but they name an admin, not the account (kept on purpose).
const ADMIN_COLS = new Set([
  "public.admin_users.clerk_user_id",
  "public.redemption_codes.created_by",
  "public.coupon_batches.created_by",
]);
// Tables whose rows of A's stay, with the link to A removed.
const KEPT_TABLES = new Set(["public.token_usage_log", "public.redemption_codes"]);

type Col = { name: string; type: string; notnull: boolean; generated: boolean };
type Fk = { cols: string[]; parent: string; pcols: string[]; cascade: boolean };
type Made = { table: string; owner: string | null; row: Record<string, unknown>; pk: string[] };

async function catalog(pg: PGlite) {
  const tables = (await pg.query<{ t: string }>(`
    select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public', 'food_memory_private') order by 1`)).rows.map((r) => r.t);
  const cols = new Map<string, Col[]>();
  for (const r of (await pg.query<{ t: string; name: string; type: string; notnull: boolean; generated: boolean }>(`
    select n.nspname || '.' || c.relname t, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as notnull, a.attgenerated <> '' as generated
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public', 'food_memory_private') and a.attnum > 0 and not a.attisdropped
    order by 1, a.attnum`)).rows) {
    if (!cols.has(r.t)) cols.set(r.t, []);
    cols.get(r.t)!.push(r);
  }
  const fks = new Map<string, Fk[]>();
  for (const r of (await pg.query<{ t: string; cols: string[]; parent: string; pcols: string[]; del: string }>(`
    select cn.nspname || '.' || c.relname t, pn.nspname || '.' || p.relname parent, con.confdeltype del,
      array(select a.attname from unnest(con.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o) cols,
      array(select a.attname from unnest(con.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o) pcols
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid join pg_namespace cn on cn.oid = c.relnamespace
    join pg_class p on p.oid = con.confrelid join pg_namespace pn on pn.oid = p.relnamespace
    where con.contype = 'f'`)).rows) {
    if (!fks.has(r.t)) fks.set(r.t, []);
    fks.get(r.t)!.push({ cols: r.cols, parent: r.parent, pcols: r.pcols, cascade: r.del === "c" });
  }
  const pks = new Map<string, string[]>();
  for (const r of (await pg.query<{ t: string; cols: string[] }>(`
    select n.nspname || '.' || c.relname t,
      array(select a.attname from unnest(i.indkey) k(n) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n) cols
    from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
    where i.indisprimary and n.nspname in ('public', 'food_memory_private')`)).rows) pks.set(r.t, r.cols);
  return { tables, cols, fks, pks };
}

const isOwnerCol = (t: string, c: string) => OWNER_COLS.has(c) && !ADMIN_COLS.has(`${t}.${c}`);
const q = (t: string) => t.split(".").map((p) => `"${p}"`).join(".");

let n = 0;
function dummy(t: string, c: Col): unknown {
  n++;
  const ty = c.type;
  if (ty.endsWith("[]")) return "{}";
  if (ty === "uuid") return crypto.randomUUID();
  if (ty === "integer" || ty === "bigint" || ty === "smallint") return n;
  if (ty.startsWith("numeric") || ty === "real" || ty === "double precision") return 1;
  if (ty === "boolean") return false;
  if (ty === "date") return "2026-11-01";
  if (ty.startsWith("timestamp")) return "2026-11-01T00:00:00Z";
  if (ty === "jsonb" || ty === "json") return "{}";
  return `${t.split(".")[1]}.${c.name}.${n}`;
}

// Values a made-up text would break: what the function or a constraint reads.
function override(t: string, user: string): Record<string, unknown> {
  switch (t) {
    case "public.user_profiles": return { email: EMAIL[user] };
    case "public.invite_codes": return { source: "old_app", owner_email: `old-${user}@example.test` };
    case "public.token_usage_log": return { metadata: JSON.stringify({ user_id: user, mode: "fast" }) };
    default: return {};
  }
}

async function setup(fn: string) {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;`);
  await pg.exec(TABLES);
  const cat = await catalog(pg);
  const made: Made[] = [];
  // Insert one row; a NOT NULL column left out gets a made-up value.
  const put = async (t: string, given: Record<string, unknown>) => {
    const cols = cat.cols.get(t)!.filter((c) => !c.generated);
    const row = { ...given };
    for (const c of cols) if (c.notnull && !(c.name in row)) row[c.name] = dummy(t, c);
    const names = Object.keys(row);
    const types = names.map((k) => cols.find((c) => c.name === k)!.type.replace(/^vector.*/, "text"));
    const res = await pg.query<{ r: Record<string, unknown> }>(
      `insert into ${q(t)} (${names.map((k) => `"${k}"`).join(", ")})
       values (${names.map((_, i) => `$${i + 1}::${types[i]}`).join(", ")})
       returning to_jsonb(${q(t).split(".")[1]}.*) r`,
      names.map((k) => row[k]),
    );
    return res.rows[0].r;
  };

  // Parents first. Only keys we fill make an edge (nullable non-cascade keys stay null).
  const filled = (t: string) => (cat.fks.get(t) ?? []).filter((f) =>
    f.cascade || f.cols.some((c) => isOwnerCol(t, c) || cat.cols.get(t)!.find((x) => x.name === c)!.notnull));
  const order: string[] = [];
  const left = new Set(cat.tables);
  while (left.size) {
    const next = [...left].find((t) => filled(t).every((f) => f.parent === t || !left.has(f.parent)));
    if (!next) throw new Error(`foreign key cycle among: ${[...left].join(", ")}`);
    order.push(next);
    left.delete(next);
  }

  for (const user of [A, B]) {
    for (const t of order) {
      const cols = cat.cols.get(t)!.filter((c) => !c.generated);
      const fks = filled(t);
      const row: Record<string, unknown> = {};
      let owner: string | null = null;
      for (const c of cols) {
        if (isOwnerCol(t, c.name)) { row[c.name] = user; owner = user; continue; }
        const fk = (cat.fks.get(t) ?? []).find((f) => f.cols.includes(c.name));
        if (fk && !fks.includes(fk)) { row[c.name] = null; continue; }
        if (fk) {
          const parent = made.filter((m) => m.table === fk.parent && (m.owner === user || m.owner === null)).at(-1);
          if (!parent) throw new Error(`${t}.${c.name}: no ${fk.parent} row`);
          row[c.name] = parent.row[fk.pcols[fk.cols.indexOf(c.name)]];
          if (parent.owner) owner = parent.owner;
          continue;
        }
        row[c.name] = dummy(t, c);
      }
      Object.assign(row, override(t, user));
      if (t === "public.token_usage_log") owner = user; // named in metadata
      made.push({ table: t, owner, row: await put(t, row), pk: cat.pks.get(t) ?? [] });
    }
  }
  const mine = (t: string, user: string) => made.find((m) => m.table === t && m.owner === user)!.row;

  // Rows that cross between users.
  await put("public.user_profiles", { clerk_user_id: C });
  await put("public.user_profiles", { clerk_user_id: D });
  await pg.exec(`
    alter table invite_codes add constraint invite_codes_owner_check check (
      (source = 'old_app' and owner_email is not null)
      or (source = 'referral' and owner_email is null)
      or (source = 'campaign' and owner_email is null and owner_clerk_user_id is null));
  `);
  const bWorkout = mine("public.workouts", B).id;
  const bRoutine = mine("public.routines", B).id;
  const ex = async (name: string, by: string) => (await put("public.exercises", { name, created_by: by })).id as string;
  const shared = {
    set: await ex("Leftover hinge", A),
    routine: await ex("Leftover row", A),
    note: await ex("Leftover curl", A),
    wnote: await ex("Leftover fly", A),
    check: await ex("Leftover squat", A),
  };
  await ex("leftover HINGE", B); // B already owns the name
  await ex("Leftover hinge (2)", B); // and the first free suffix
  await put("public.workout_sets", { workout_id: bWorkout, exercise_id: shared.set });
  await put("public.routine_exercises", { routine_id: bRoutine, exercise_id: shared.routine });
  await put("public.user_exercise_notes", { user_id: B, exercise_id: shared.note });
  await put("public.workout_exercise_notes", { workout_id: bWorkout, exercise_id: shared.wnote });
  await put("public.form_checks", { user_id: B, exercise_id: shared.check });
  // A's referral code that C redeemed; an old-app code sent to A's email
  // (case differs) that D redeemed. A's own old-app code (from the fill) has
  // only A's redemption, so it goes.
  await put("public.invite_codes", { code: "REFA", source: "referral", owner_clerk_user_id: A, owner_email: null });
  await put("public.invite_codes", { code: "OLDA", source: "old_app", owner_email: EMAIL[A].toUpperCase() });
  await put("public.invite_redemptions", { clerk_user_id: C, code: "REFA" });
  await put("public.invite_redemptions", { clerk_user_id: D, code: "OLDA" });
  await put("public.token_usage_log", { metadata: JSON.stringify({ user: A, mode: "card" }) });

  await pg.exec(fn);
  return { pg, cat, made, shared };
}

async function run(fn: string) {
  const { pg, cat, made, shared } = await setup(fn);
  const problems: string[] = [];
  try {
    await pg.query(`select public.delete_user_data($1)`, [A]);
  } catch (e) {
    return [`delete_user_data(A) failed: ${(e as Error).message}`];
  }
  const where = (m: Made) =>
    m.pk.length
      ? { sql: m.pk.map((c, i) => `"${c}" = $${i + 1}`).join(" and "), args: m.pk.map((c) => typeof m.row[c] === "object" ? JSON.stringify(m.row[c]) : m.row[c]) }
      : { sql: `to_jsonb(x.*) = $1::jsonb`, args: [JSON.stringify(m.row)] };
  const current = async (m: Made) => {
    const w = where(m);
    return (await pg.query<{ r: Record<string, unknown> }>(`select to_jsonb(x.*) r from ${q(m.table)} x where ${w.sql}`, w.args)).rows[0]?.r;
  };

  for (const m of made) {
    const now = await current(m);
    if (m.owner === A) {
      if (KEPT_TABLES.has(m.table)) {
        if (!now) problems.push(`${m.table}: A's row deleted, should stay without A`);
      } else if (now) problems.push(`${m.table}: A's row left behind`);
    } else if (JSON.stringify(now) !== JSON.stringify(m.row)) {
      problems.push(`${m.table}: ${m.owner === B ? "B's" : "shared"} row ${now ? "changed" : "deleted"}`);
    }
  }

  // Nothing anywhere names A.
  for (const t of cat.tables) {
    const [{ k }] = (await pg.query<{ k: number }>(
      `select count(*)::int k from ${q(t)} x where to_jsonb(x.*)::text ilike '%' || $1 || '%' or to_jsonb(x.*)::text ilike '%' || $2 || '%'`,
      [A, EMAIL[A]],
    )).rows;
    if (k) problems.push(`${t}: ${k} row(s) still hold A's id or email`);
  }

  // Shared custom exercises: kept, now B's, renamed on a clash.
  const exs = (await pg.query<{ id: string; name: string; created_by: string }>(
    `select id, name, created_by from exercises where id = any($1)`, [Object.values(shared)])).rows;
  if (exs.length !== 5 || exs.some((e) => e.created_by !== B)) problems.push(`shared exercises not kept as B's: ${JSON.stringify(exs)}`);
  if (exs.find((e) => e.id === shared.set)?.name !== "Leftover hinge (3)") problems.push("name clash on hand-on not solved");
  const sets = (await pg.query(`select 1 from workout_sets where exercise_id = $1`, [shared.set])).rows.length;
  const fc = (await pg.query(`select 1 from form_checks where exercise_id = $1 and user_id = $2`, [shared.check, B])).rows.length;
  if (sets !== 1 || fc !== 1) problems.push("B lost a set or form check on a shared exercise");

  // Codes someone else redeemed stay; the owner link goes.
  const codes = (await pg.query<{ code: string; owner_email: string | null; owner_clerk_user_id: string | null }>(
    `select code, owner_email, owner_clerk_user_id from invite_codes where code in ('REFA', 'OLDA') order by code`)).rows;
  const want = [{ code: "OLDA", owner_email: "deleted:OLDA", owner_clerk_user_id: null }, { code: "REFA", owner_email: null, owner_clerk_user_id: null }];
  if (JSON.stringify(codes) !== JSON.stringify(want)) problems.push(`codes others used: ${JSON.stringify(codes)}`);
  const reds = (await pg.query(`select 1 from invite_redemptions where clerk_user_id in ($1, $2)`, [C, D])).rows.length;
  if (reds !== 2) problems.push("C's or D's redemption went");

  // The cost ledger keeps its other keys.
  const modes = (await pg.query<{ m: string }>(`select metadata->>'mode' m from token_usage_log where metadata->>'mode' in ('fast', 'card') order by 1`)).rows.map((r) => r.m);
  if (JSON.stringify(modes) !== JSON.stringify(["card", "fast", "fast"])) problems.push(`cost rows lost metadata: ${modes}`);

  return problems;
}

Deno.test("delete_user_data: A is gone everywhere, B and shared rows stay", async () => {
  assertEquals(await run(NEW_FN), []);
});

Deno.test("delete_user_data: the live body from before fails this check", async () => {
  const problems = await run(OLD_FN);
  console.log(`old body: ${problems.length} problems\n  ${problems.join("\n  ")}`);
  assert(problems.some((p) => p.startsWith("public.parse_traces")), "the check no longer catches the old gaps");
});

Deno.test("delete_user_data: definer, fixed search_path, service_role only", async () => {
  const { pg } = await setup(NEW_FN);
  const [p] = (await pg.query<{ sd: boolean; cfg: string[]; anon: boolean; auth: boolean; pub: boolean; svc: boolean }>(`
    select prosecdef sd, proconfig cfg,
      has_function_privilege('anon', oid, 'execute') anon,
      has_function_privilege('authenticated', oid, 'execute') auth,
      exists (select 1 from aclexplode(proacl) where grantee = 0) pub,
      has_function_privilege('service_role', oid, 'execute') svc
    from pg_proc where oid = 'public.delete_user_data(text)'::regprocedure`)).rows;
  assertEquals(p, { sd: true, cfg: ["search_path=public, pg_temp"], anon: false, auth: false, pub: false, svc: true });
});

Deno.test("fixture: every table is filled for both users", async () => {
  const { cat, made } = await setup(NEW_FN);
  for (const t of cat.tables) assertEquals(made.filter((m) => m.table === t).length, 2, t);
  // A row in nearly every table belongs to A; the rest are shared catalogs.
  const shared = cat.tables.filter((t) => !made.some((m) => m.table === t && m.owner === A));
  console.log(`tables: ${cat.tables.length}, shared (no owner): ${shared.join(", ")}`);
});
