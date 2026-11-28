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
  const check = async (device: string, ip: string | null) => {
    const r = (await q<{ allowed: boolean; reason: string | null; slot_id: number | null }>(
      `select * from reserve_anon_phase_slot($1, $2)`, [device, ip]))[0];
    // Reserving spends the slot; give it back so these checks only look.
    if (r.slot_id != null) await q(`select release_anon_phase_slot($1)`, [r.slot_id]);
    return { allowed: r.allowed, reason: r.reason };
  };
  // A finished, successful build (the counts the caps read).
  const use = async (device: string, ip: string | null, ago = "0 minutes", outcome = "ok") =>
    await q(`insert into anon_phase_usage (device_id, ip, created_at, outcome) values ($1, $2, now() - $3::interval, $4)`, [device, ip, ago, outcome]);
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

Deno.test("no IP known: only the device and global caps apply, never one shared bucket", async () => {
  const { check, use } = await db();
  for (let i = 0; i < 20; i++) await use(`n${i}`, null);
  // 20 phones with no IP: a 21st is still let through (no "unknown" IP bucket).
  assertEquals(await check("n21", null), { allowed: true, reason: null });
  // Its device cap still holds.
  await use("n21", null);
  await use("n21", null);
  assertEquals(await check("n21", null), { allowed: false, reason: "device_day" });
});

Deno.test("a build that failed after the model ran: the phone may try again, the daily total still counts it", async () => {
  const { q, check, use } = await db();
  await use("d1", "6.6.6.6", "0 minutes", "failed");
  await use("d1", "6.6.6.6", "0 minutes", "failed");
  await use("d1", "6.6.6.6", "0 minutes", "failed");
  // Three failures: the phone's own caps are untouched.
  assertEquals(await check("d1", "6.6.6.6"), { allowed: true, reason: null });
  // But every paid run counts toward the global breaker.
  await q(`insert into anon_phase_usage (device_id, ip, outcome) select 'f' || i, null, 'failed' from generate_series(1, 497) i`);
  assertEquals(await check("d2", "7.7.7.7"), { allowed: false, reason: "global_day" });
});

Deno.test("finish: ok counts against the phone, failed does not; a stuck pending row stops counting after a few minutes", async () => {
  const { q } = await db();
  const reserve = async () =>
    (await q<{ allowed: boolean; slot_id: number | null }>(`select * from reserve_anon_phase_slot('d9', null)`))[0];
  const a = await reserve();
  await q(`select finish_anon_phase_slot($1, false)`, [a.slot_id]);
  const b = await reserve();
  await q(`select finish_anon_phase_slot($1, true)`, [b.slot_id]);
  assertEquals((await q(`select outcome from anon_phase_usage order by id`)).map((r) => r.outcome), ["failed", "ok"]);
  // One success and one in-flight build fill the day.
  const c = await reserve();
  assertEquals(c.allowed, true);
  assertEquals((await reserve()).allowed, false);
  // An in-flight row whose request died (never finished) frees the phone later.
  await q(`update anon_phase_usage set created_at = now() - interval '10 minutes' where id = $1`, [c.slot_id]);
  assertEquals((await reserve()).allowed, true);
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
    has_function_privilege('anon', 'finish_anon_phase_slot(bigint, boolean)', 'EXECUTE')
      or has_function_privilege('authenticated', 'finish_anon_phase_slot(bigint, boolean)', 'EXECUTE')
      or not has_function_privilege('service_role', 'finish_anon_phase_slot(bigint, boolean)', 'EXECUTE') z,
    has_function_privilege('anon', 'reserve_anon_phase_slot(text, text)', 'EXECUTE') a,
    has_function_privilege('authenticated', 'reserve_anon_phase_slot(text, text)', 'EXECUTE') b,
    has_function_privilege('service_role', 'reserve_anon_phase_slot(text, text)', 'EXECUTE') c,
    has_function_privilege('anon', 'release_anon_phase_slot(bigint)', 'EXECUTE') d,
    has_function_privilege('authenticated', 'release_anon_phase_slot(bigint)', 'EXECUTE') e,
    has_function_privilege('service_role', 'release_anon_phase_slot(bigint)', 'EXECUTE') f,
    has_table_privilege('anon', 'anon_phase_usage', 'SELECT') g`);
  assertEquals(r, { z: false, a: false, b: false, c: true, d: false, e: false, f: true, g: false });
});
