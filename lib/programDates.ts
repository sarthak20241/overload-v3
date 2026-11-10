/**
 * Local-date helpers for programs. Pure, so lib/programData and the
 * dashboard's program helpers share one copy and tests can import it directly.
 */

// ── Local-date helpers (mirror lib/readinessSync.ts; never UTC) ───────────────
export function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function todayLocalISO(): string {
  return toLocalISO(new Date());
}
// The active-phase math lives in lib/phasePick (pure as well); re-exported so
// the dashboard's program helpers import dates and phases from one place.
export { computeActivePhaseSeq, daysBetweenISO } from '@/lib/phasePick';
