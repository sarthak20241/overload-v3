// What Coach Drona carries between conversations, shaped for the prompt.
//
// Four sources, all read with the user's own client (RLS) in index.ts and
// folded into user_context so every mode (chat, refine, discuss, program, the
// plan fan-out) sees them for free:
//
//   coach_memory       facts the coach saved with remember_fact (migration 0127)
//   plan_changes       the database's own diary of plan edits (migration 0123)
//   drona_cards        the weekly proposals and what the user did with them
//   body_measurements  tape measurements, latest per site with the change
//
// Everything here is pure and compact on purpose: these ride the cached
// user_context block on every turn, so a verbose shape is paid for on every
// message. No imports, so `deno test` runs it without the edge runtime.

// ── Memory facts ─────────────────────────────────────────────────────────────

export interface MemoryRow {
  category: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface MemoryFact {
  category: string;
  key: string;
  value: string;
  /** YYYY-MM-DD of the last time this fact was saved or updated. */
  noted: string;
}

const day = (iso: string | null | undefined): string =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "";

export function memoryForContext(rows: MemoryRow[] | null | undefined): MemoryFact[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.key === "string" && typeof r.value === "string")
    .map((r) => ({
      category: String(r.category ?? "other"),
      key: r.key,
      value: r.value,
      noted: day(r.updated_at),
    }));
}

// ── Plan changes ─────────────────────────────────────────────────────────────

export interface PlanChangeRow {
  occurred_at: string;
  entity: string;
  action: string;
  changes: Record<string, unknown> | null;
  source: string;
  label: string | null;
}

const LINE_MAX = 240;

const FIELD_LABELS: Record<string, string> = {
  daily_calorie_target: "calories",
  protein_target_g: "protein g",
  carb_target_g: "carbs g",
  fat_target_g: "fat g",
  diet_calorie_target: "calories",
  diet_protein_g: "protein g",
  diet_carb_g: "carbs g",
  diet_fat_g: "fat g",
  goal_weight_kg: "goal weight kg",
  goal_target_date: "goal date",
  weekly_target_sessions: "sessions per week",
  goal_focus_areas: "focus areas",
  goal_detail: "goal detail",
  target_weight_kg: "target weight kg",
  target_date: "target date",
  start_date: "start date",
  total_weeks: "total weeks",
  duration_weeks: "weeks",
  start_offset_weeks: "starts week",
  diet_directive: "diet directive",
  training_directive: "training directive",
  readiness_directive: "readiness directive",
  training_block: "training block",
  program_phase_id: "program phase",
  reps_min: "reps min",
  reps_max: "reps max",
  rest_seconds: "rest s",
  superset_group: "superset",
};

const label = (field: string): string => FIELD_LABELS[field] ?? field.replace(/_/g, " ");

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}...` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(scalar).join("/") || "none";
  return "changed";
}

/** {"field": {"from": a, "to": b}} -> "calories 1800→1750, protein g 130→135" */
function diffText(changes: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [field, v] of Object.entries(changes)) {
    if (!v || typeof v !== "object") continue;
    const { from, to } = v as { from?: unknown; to?: unknown };
    // Long prose fields (directives, blocks) read badly as before/after.
    if (field.endsWith("_directive") || field === "training_block" || field === "objective") {
      parts.push(`${label(field)} rewritten`);
      continue;
    }
    parts.push(`${label(field)} ${scalar(from)}→${scalar(to)}`);
  }
  return parts.join(", ");
}

function snapshotText(changes: Record<string, unknown>, fields: string[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (changes[f] === undefined || changes[f] === null) continue;
    parts.push(`${label(f)} ${scalar(changes[f])}`);
  }
  return parts.join(", ");
}

function phaseSnapshot(c: Record<string, unknown>): string {
  const parts: string[] = [];
  if (c.duration_weeks != null) parts.push(`${scalar(c.duration_weeks)} wk`);
  if (c.diet_calorie_target != null) {
    parts.push(
      `${scalar(c.diet_calorie_target)} kcal` +
        (c.diet_protein_g != null ? ` / ${scalar(c.diet_protein_g)} g protein` : ""),
    );
  }
  const block = c.training_block;
  if (block && typeof block === "object") {
    const b = block as Record<string, unknown>;
    const bits = [b.split_type, b.days_per_week != null ? `${scalar(b.days_per_week)} days` : null]
      .filter(Boolean)
      .map(scalar);
    if (bits.length) parts.push(bits.join(" "));
  }
  return parts.join(", ");
}

function programSnapshot(c: Record<string, unknown>): string {
  const parts: string[] = [];
  if (c.total_weeks != null) parts.push(`${scalar(c.total_weeks)} weeks`);
  if (c.goal != null) parts.push(`goal ${scalar(c.goal)}`);
  if (c.target_weight_kg != null) {
    parts.push(
      `target ${scalar(c.target_weight_kg)} kg` +
        (c.target_date != null ? ` by ${scalar(c.target_date)}` : ""),
    );
  } else if (c.target_date != null) {
    parts.push(`by ${scalar(c.target_date)}`);
  }
  if (c.status != null && c.status !== "active") parts.push(`status ${scalar(c.status)}`);
  return parts.join(", ");
}

function exerciseName(e: unknown): string {
  if (!e || typeof e !== "object") return "?";
  const n = (e as { name?: unknown }).name;
  return typeof n === "string" && n ? n : "?";
}

function routineExercisesText(c: Record<string, unknown>): string {
  const parts: string[] = [];
  const added = Array.isArray(c.added) ? c.added.map(exerciseName) : [];
  const removed = Array.isArray(c.removed) ? c.removed.map(exerciseName) : [];
  if (added.length) parts.push(`added ${added.join(", ")}`);
  if (removed.length) parts.push(`removed ${removed.join(", ")}`);
  if (Array.isArray(c.changed)) {
    const ch = c.changed
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const fields = (x as { fields?: unknown }).fields;
        const inner = fields && typeof fields === "object"
          ? diffText(fields as Record<string, unknown>)
          : "";
        return `${exerciseName(x)}${inner ? ` (${inner})` : ""}`;
      })
      .filter(Boolean);
    if (ch.length) parts.push(`changed ${ch.join("; ")}`);
  }
  if (c.reordered === true) parts.push("reordered");
  return parts.join("; ");
}

/**
 * One plan_changes row as one line for the prompt:
 *   "2026-09-16 (chat) targets: calories 2250→2100"
 *   "2026-09-14 (manual) routine 'Push': added Cable Fly; removed Pec Deck"
 * Returns null for a row with nothing worth saying.
 */
export function formatPlanChange(row: PlanChangeRow): string | null {
  if (!row || typeof row !== "object") return null;
  const c = (row.changes && typeof row.changes === "object" ? row.changes : {}) as Record<string, unknown>;
  const when = day(row.occurred_at);
  const src = row.source || "system";
  const name = row.label ? ` '${row.label}'` : "";
  let body: string;

  switch (row.entity) {
    case "targets":
      body = row.action === "changed"
        ? `targets: ${diffText(c)}`
        : `targets ${row.action === "removed" ? "removed" : "set"}: ${
          snapshotText(c, ["daily_calorie_target", "protein_target_g", "carb_target_g", "fat_target_g"])
        }`;
      break;
    case "goal":
      body = row.action === "changed"
        ? `goal: ${diffText(c)}`
        : `goal set: ${
          snapshotText(c, [
            "goal", "goal_detail", "goal_weight_kg", "goal_target_date",
            "weekly_target_sessions", "goal_focus_areas",
          ])
        }`;
      break;
    case "program":
      body = row.action === "changed"
        ? `program${name}: ${diffText(c)}`
        : `program${name} ${row.action}${row.action === "created" ? `: ${programSnapshot(c)}` : ""}`;
      break;
    case "phase":
      body = row.action === "changed"
        ? `phase${name}: ${diffText(c)}`
        : `phase${name} ${row.action}${row.action === "created" ? `: ${phaseSnapshot(c)}` : ""}`;
      break;
    case "routine":
      body = row.action === "changed"
        ? `routine${name}: ${diffText(c)}`
        : `routine${name} ${row.action}`;
      break;
    case "routine_exercises":
      body = `routine${name}: ${routineExercisesText(c)}`;
      break;
    default:
      body = `${row.entity}${name} ${row.action}`;
  }

  body = body.replace(/:\s*$/, "").replace(/\s+/g, " ").trim();
  if (!body) return null;
  const line = `${when} (${src}) ${body}`;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 3)}...` : line;
}

export function planChangesForContext(rows: PlanChangeRow[] | null | undefined, max = 25): string[] {
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const r of rows) {
    const line = formatPlanChange(r);
    if (line) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

// ── Weekly cards ─────────────────────────────────────────────────────────────

export interface CardRow {
  week_start: string;
  kind: string;
  topic: string;
  title: string;
  status: string;
  summary: string | null;
}

export interface CardDecision {
  week: string;
  kind: string;
  topic: string;
  title: string;
  status: string;
  summary?: string;
}

export function cardsForContext(rows: CardRow[] | null | undefined): CardDecision[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.topic === "string")
    .map((r) => {
      const out: CardDecision = {
        week: day(r.week_start),
        kind: r.kind,
        topic: r.topic,
        title: r.title ?? "",
        status: r.status,
      };
      if (typeof r.summary === "string" && r.summary.trim()) out.summary = r.summary.trim();
      return out;
    });
}

// ── Tape measurements ────────────────────────────────────────────────────────

export interface MeasurementRow {
  measured_on: string;
  site: string;
  value_cm: number | string;
}

export interface SiteSummary {
  site: string;
  cm: number;
  on: string;
  /** The oldest reading in the window, when it is on a different day. */
  prev_cm?: number;
  prev_on?: string;
}

export interface MeasurementsSummary {
  latest_on: string;
  /** Distinct days with at least one tape reading in the window. */
  days_logged: number;
  sites: SiteSummary[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};

/**
 * Latest reading per site plus the oldest one in the window, so the coach can
 * say "waist 82.5, down from 84 in July" without a tool call. Rows may arrive
 * in any order. Null when there is nothing.
 */
export function summarizeMeasurements(rows: MeasurementRow[] | null | undefined): MeasurementsSummary | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const latest = new Map<string, { cm: number; on: string }>();
  const oldest = new Map<string, { cm: number; on: string }>();
  const days = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r.site !== "string") continue;
    const cm = num(r.value_cm);
    const on = day(r.measured_on);
    if (cm === null || !on) continue;
    days.add(on);
    const l = latest.get(r.site);
    if (!l || on > l.on) latest.set(r.site, { cm, on });
    const o = oldest.get(r.site);
    if (!o || on < o.on) oldest.set(r.site, { cm, on });
  }
  if (latest.size === 0) return null;
  const sites: SiteSummary[] = [];
  for (const [site, l] of latest) {
    const s: SiteSummary = { site, cm: l.cm, on: l.on };
    const o = oldest.get(site);
    if (o && o.on !== l.on) {
      s.prev_cm = o.cm;
      s.prev_on = o.on;
    }
    sites.push(s);
  }
  sites.sort((a, b) => a.site.localeCompare(b.site));
  const latestOn = sites.reduce((m, s) => (s.on > m ? s.on : m), "");
  return { latest_on: latestOn, days_logged: days.size, sites };
}

/**
 * Why a memory tool call did NOT change anything, or null when it did.
 *
 * coach_remember_fact / coach_forget_fact never raise for bad input: they
 * return {saved:false, reason} or {forgotten:0, reason}. Without this the
 * trace logged those as a plain "remember_fact", so a save the database
 * refused looked the same as one it kept.
 */
export function memoryRefusalOf(name: string, result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { saved?: unknown; forgotten?: unknown; reason?: unknown };
  const refused = (name === "remember_fact" && r.saved === false) ||
    (name === "forget_fact" && r.forgotten === 0);
  if (!refused) return null;
  return typeof r.reason === "string" && r.reason ? r.reason : "nothing changed";
}
