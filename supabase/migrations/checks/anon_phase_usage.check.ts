// The anon_phase_usage migration (20261128140000) against a real Postgres
// (PGlite). Not in CI: it downloads PGlite. Run before applying it:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/anon_phase_usage.check.ts
//
// What it pins: the phase 1 build before sign-up has its own counter, so it
// never spends the program's slots (0087), and its limits trip in order.

import { assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const SQL = await Deno.readTextFile(new URL("../20261128140000_anon_phase_usage.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;`);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  const check = async (device: string, ip: string) =>
    (await q<{ allowed: boolean; reason: string | null }>(`select * from check_anon_phase_quota($1, $2)`, [device, ip]))[0];
  const use = async (device: string, ip: string, ago = "0 minutes") =>
    await q(`insert into anon_phase_usage (device_id, ip, created_at) values ($1, $2, now() - $3::interval)`, [device, ip, ago]);
  return { q, check, use };
}

Deno.test("a fresh device may build; 2 a day per device, then no", async () => {
  const { check, use } = await db();
  assertEquals(await check("d1", "1.1.1.1"), { allowed: true, reason: null });
  await use("d1", "1.1.1.1");
  assertEquals((await check("d1", "1.1.1.1")).allowed, true);
  await use("d1", "1.1.1.1");
  assertEquals(await check("d1", "1.1.1.1"), { allowed: false, reason: "device_day" });
  // A day later the device may build again, until its lifetime cap.
  assertEquals((await check("d2", "1.1.1.1")).allowed, true);
});

Deno.test("3 a lifetime per device", async () => {
  const { check, use } = await db();
  await use("d1", "2.2.2.2", "3 days");
  await use("d1", "2.2.2.2", "2 days");
  await use("d1", "2.2.2.2", "25 hours");
  assertEquals(await check("d1", "2.2.2.2"), { allowed: false, reason: "device_life" });
});

Deno.test("IP caps: 15 an hour, 40 a day", async () => {
  const { check, use } = await db();
  for (let i = 0; i < 15; i++) await use(`h${i}`, "3.3.3.3");
  assertEquals(await check("new", "3.3.3.3"), { allowed: false, reason: "ip_hour" });
  for (let i = 0; i < 40; i++) await use(`x${i}`, "4.4.4.4", "2 hours");
  assertEquals(await check("new", "4.4.4.4"), { allowed: false, reason: "ip_day" });
});

Deno.test("global breaker: 500 a day across everyone", async () => {
  const { q, check } = await db();
  await q(`insert into anon_phase_usage (device_id, ip) select 'g' || i, 'ip' || i from generate_series(1, 500) i`);
  assertEquals(await check("fresh", "9.9.9.9"), { allowed: false, reason: "global_day" });
});

Deno.test("service role only: no client can read the table or call the check", async () => {
  const { q } = await db();
  const [r] = await q<{ a: boolean; b: boolean; c: boolean; d: boolean }>(`select
    has_function_privilege('anon', 'check_anon_phase_quota(text, text)', 'EXECUTE') a,
    has_function_privilege('authenticated', 'check_anon_phase_quota(text, text)', 'EXECUTE') b,
    has_function_privilege('service_role', 'check_anon_phase_quota(text, text)', 'EXECUTE') c,
    has_table_privilege('anon', 'anon_phase_usage', 'SELECT') d`);
  assertEquals(r, { a: false, b: false, c: true, d: false });
});
