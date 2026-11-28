// The anon_phase_usage migration (20261128140000) against a real Postgres
// (PGlite). Not in CI: it downloads PGlite. Run before applying it:
//
//   deno test --allow-all --node-modules-dir=none supabase/migrations/checks/anon_phase_usage.check.ts
//
// What it pins: the phase 1 build before sign-up has its own counter, so it
// never spends the program's slots (0087); a slot is reserved BEFORE the
// build (so a burst cannot all pass the check), given back when the build
// fails, and the limits trip in order.

import { assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const SQL = await Deno.readTextFile(new URL("../20261128140000_anon_phase_usage.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;`);
  await pg.exec(SQL);
  await pg.exec(SQL); // re-runnable
  const q = async <T = Record<string, any>>(s: string, p: unknown[] = []) => (await pg.query<T>(s, p)).rows;
  const check = async (device: string, ip: string) => {
    const r = (await q<{ allowed: boolean; reason: string | null; slot_id: number | null }>(
      `select * from reserve_anon_phase_slot($1, $2)`, [device, ip]))[0];
    // Reserving spends the slot; give it back so these checks only look.
    if (r.slot_id != null) await q(`select release_anon_phase_slot($1)`, [r.slot_id]);
    return { allowed: r.allowed, reason: r.reason };
  };
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

Deno.test("a reservation takes the slot at once; a failed build gives it back", async () => {
  const { q } = await db();
  const reserve = async () =>
    (await q<{ allowed: boolean; reason: string | null; slot_id: number | null }>(
      `select * from reserve_anon_phase_slot('d1', '5.5.5.5')`))[0];
  const a = await reserve();
  const b = await reserve();
  // Two builds in flight: the third is refused before either one finishes.
  assertEquals([a.allowed, b.allowed], [true, true]);
  assertEquals(await reserve(), { allowed: false, reason: "device_day", slot_id: null });
  // One build fails: its slot comes back, and only that one.
  await q(`select release_anon_phase_slot($1)`, [a.slot_id]);
  assertEquals((await q(`select count(*)::int n from anon_phase_usage`))[0].n, 1);
  assertEquals((await reserve()).allowed, true);
});

Deno.test("service role only: no client can read the table, reserve or release", async () => {
  const { q } = await db();
  const [r] = await q<Record<string, boolean>>(`select
    has_function_privilege('anon', 'reserve_anon_phase_slot(text, text)', 'EXECUTE') a,
    has_function_privilege('authenticated', 'reserve_anon_phase_slot(text, text)', 'EXECUTE') b,
    has_function_privilege('service_role', 'reserve_anon_phase_slot(text, text)', 'EXECUTE') c,
    has_function_privilege('anon', 'release_anon_phase_slot(bigint)', 'EXECUTE') d,
    has_function_privilege('authenticated', 'release_anon_phase_slot(bigint)', 'EXECUTE') e,
    has_function_privilege('service_role', 'release_anon_phase_slot(bigint)', 'EXECUTE') f,
    has_table_privilege('anon', 'anon_phase_usage', 'SELECT') g`);
  assertEquals(r, { a: false, b: false, c: true, d: false, e: false, f: true, g: false });
});
