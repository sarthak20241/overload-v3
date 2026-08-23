export function bodyHeadline(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  if (entries.length === 0) return 'Where the sets went.';

  const total = entries.reduce((s, [, v]) => s + v, 0);
  entries.sort((a, b) => b[1] - a[1]);
  const [topGroup, topSets] = entries[0];

  if (topSets / total > 0.4) return `${topGroup} did the work.`;
  if (entries.length >= 3 && topSets / total < 0.3) return 'Nothing skipped.';
  return 'Where the sets went.';
}

export function recapCoachLine(prCount: number, durationSeconds: number): string {
  if (prCount > 0) return `${prCount} new PR${prCount > 1 ? 's' : ''}. Keep it moving.`;
  if (durationSeconds < 1800) return 'In and out. Still counts.';
  return 'Logged. Onward.';
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}
