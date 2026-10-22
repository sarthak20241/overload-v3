import { assertEquals } from "jsr:@std/assert@1";
import { type Db, metricsStep } from "./metrics.ts";

/**
 * A fake PostgREST client: every chained call returns the builder, and
 * awaiting it resolves to the next scripted answer for that table. Writes
 * (update) are recorded with the filters that followed them.
 */
type Answer = { data: unknown; error: { message: string } | null };
interface Written { table: string; patch: Record<string, unknown>; eq: [string, unknown][] }
interface Read { table: string; eq: [string, unknown][] }

function fakeDb(script: Record<string, Answer[]>) {
  const writes: Written[] = [];
  const reads: Read[] = [];
  const from = (table: string) => {
    let patch: Record<string, unknown> | null = null;
    const eqs: [string, unknown][] = [];
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["select", "in", "gte", "lte", "lt", "gt", "or", "order", "limit", "maybeSingle", "not", "range"]) b[m] = self;
    b.eq = (k: string, v: unknown) => { eqs.push([k, v]); return b; };
    b.update = (p: Record<string, unknown>) => { patch = p; return b; };
    b.then = (resolve: (a: Answer) => unknown) => {
      if (patch) {
        writes.push({ table, patch, eq: [...eqs] });
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      reads.push({ table, eq: [...eqs] });
      const queue = script[table] ?? [];
      const a = queue.length > 0 ? queue.shift()! : { data: null, error: null };
      return Promise.resolve(a).then(resolve);
    };
    return b;
  };
  return { db: { from } as unknown as Db, writes, reads };
}

const program = { id: "prog", title: "Summer Cut", start_date: "2026-10-05" };
const phases = [
  { id: "ph0", seq: 0, name: "Foundation", duration_weeks: 4, start_offset_weeks: 0, diet_protein_g: 150, job_text: "Bring weight 72 to 71 kg" },
];
const rows = [
  { id: "m-bw", seq: 0, is_hero: true, kind: "bodyweight", ref: null, unit: "kg", direction: "down", start_value: 72, target_value: 71, current_value: 71.8, status: "on_track", checked_at: "2026-10-12T06:00:00Z" },
  { id: "m-pd", seq: 1, is_hero: false, kind: "protein_days", ref: null, unit: "days", direction: "up", start_value: null, target_value: 5, current_value: 4, status: "close", checked_at: "2026-10-12T06:00:00Z" },
];
// Week 3 of the phase: Monday 2026-10-19.
const DAY = "2026-10-20";
const WEEK = "2026-10-19";

Deno.test("a clean week writes every metric and the coach line", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    daily_metrics: [{ data: { value: 71.4 }, error: null }],
    user_nutrition_stats: [{ data: [{ protein_g: 155 }, { protein_g: 160 }, { protein_g: 120 }, { protein_g: 151 }, { protein_g: 149 }], error: null }],
  });
  const fetchFn = (() => Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "phase_line", input: { line: "On pace. Protein is the one slipping; three of five days hit." } }],
  }), { status: 200 }))) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn);
  assertEquals(out, { checked: 2, line: true });
  const metricWrites = writes.filter((w) => w.table === "coach_program_phase_metrics");
  assertEquals(metricWrites.map((w) => [w.eq[0][1], w.patch.current_value, w.patch.status]), [
    ["m-bw", 71.4, "on_track"],   // 0.6 of 1 kg gone at half the phase: on pace
    ["m-pd", 3, "slipping"],      // 3 of 5 days: 60%
  ]);
  assertEquals(metricWrites.every((w) => typeof w.patch.checked_at === "string"), true);
  const line = writes.find((w) => w.table === "coach_program_phases");
  assertEquals(line?.patch.coach_line, "On pace. Protein is the one slipping; three of five days hit.");
  assertEquals(line?.eq, [["id", "ph0"]]);
});

Deno.test("a source that fails to read leaves its metric untouched, the rest are written, the line waits", async () => {
  const { db, writes } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows, error: null }],
    // Three times: retried() tries a transient failure three times.
    daily_metrics: Array.from({ length: 3 }, () => ({ data: null, error: { message: "504 gateway" } })),
    user_nutrition_stats: [{ data: [{ protein_g: 155 }, { protein_g: 160 }, { protein_g: 120 }, { protein_g: 151 }, { protein_g: 149 }], error: null }],
  });
  let modelCalls = 0;
  const fetchFn = (() => { modelCalls += 1; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  const out = await metricsStep(db, "user-1", DAY, WEEK, "key", fetchFn);
  assertEquals(out.checked, 1);
  assertEquals(out.line, false);
  assertEquals(out.error, "read failed for bodyweight");
  const metricWrites = writes.filter((w) => w.table === "coach_program_phase_metrics");
  // Only protein days was written; bodyweight keeps its row (and its old
  // checked_at), so the next run tries it again.
  assertEquals(metricWrites.map((w) => w.eq[0][1]), ["m-pd"]);
  assertEquals(writes.some((w) => w.table === "coach_program_phases"), false);
  assertEquals(modelCalls, 0);
});

Deno.test("nothing to do: no program, or every metric already checked this week", async () => {
  const none = fakeDb({ coach_programs: [{ data: null, error: null }] });
  assertEquals(await metricsStep(none.db, "user-1", DAY, WEEK, "key"), { checked: 0, line: false });
  assertEquals(none.writes.length, 0);

  const done = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: rows.map((r) => ({ ...r, checked_at: "2026-10-19T06:00:00Z" })), error: null }],
  });
  assertEquals(await metricsStep(done.db, "user-1", DAY, WEEK, "key"), { checked: 0, line: false });
  assertEquals(done.writes.length, 0);
});

Deno.test("the metrics read is scoped to the user as well as the phase", async () => {
  const { db, reads } = fakeDb({
    coach_programs: [{ data: program, error: null }],
    coach_program_phases: [{ data: phases, error: null }],
    coach_program_phase_metrics: [{ data: [], error: null }],
  });
  // No rows: nothing written, and the call still succeeded.
  assertEquals(await metricsStep(db, "user-1", DAY, WEEK, "key"), { checked: 0, line: false });
  const metricsRead = reads.find((r) => r.table === "coach_program_phase_metrics");
  assertEquals(metricsRead?.eq, [["user_id", "user-1"], ["phase_id", "ph0"]]);
});
