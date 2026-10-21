/**
 * coachBlocks: turns a Drona reply into blocks the chat can draw.
 *
 * Drona writes plain markdown, plus two fenced blocks the app draws as UI
 * (the server teaches this format only to clients that send ui: blocks_v1):
 *
 *   ```chart
 *   {"kind":"line","title":"Bench top set","unit":"kg","points":[["Sep 1",80],["Sep 8",82.5]]}
 *   ```
 *   ```stats
 *   [{"label":"Volume","value":"4,915 kg","note":"+12% vs last week"}]
 *   ```
 *   ```progress
 *   [{"label":"Protein","value":105,"target":115,"unit":"g"}]
 *   ```
 *
 * A chart is a line (one trend, or two compared via "series"), a bar chart,
 * or a donut (a split of one whole). Drona can also write ordinary markdown
 * pipe tables. Everything else is a paragraph, a bullet or numbered list, or
 * a heading. Pure TypeScript (no React Native) so the
 * parser runs under `deno test`.
 *
 * Replies stream in, so the last block may be half written. A table or chart
 * that has not finished arriving comes back as `pending` (drawn as a quiet
 * placeholder) instead of flashing raw pipes or JSON.
 */

export type ChartKind = 'line' | 'bar' | 'donut';

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartBlock {
  type: 'chart';
  kind: ChartKind;
  title?: string;
  unit?: string;
  /** The main series (the only one for bar and donut). */
  points: ChartPoint[];
  /** Name of the main series, shown in the legend when there is a second one. */
  name?: string;
  /** A second line drawn under the first, for a comparison (line only). */
  compare?: { name: string; points: ChartPoint[] };
  /** Optional dashed reference line (a target, a previous best). */
  goal?: number;
  goalLabel?: string;
}

export interface StatItem {
  label: string;
  value: string;
  note?: string;
}

export interface ProgressItem {
  label: string;
  value: number;
  target: number;
  unit?: string;
}

export type CoachBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][]; align: ('left' | 'right')[] }
  | ChartBlock
  | { type: 'stats'; items: StatItem[] }
  | { type: 'progress'; items: ProgressItem[] }
  | { type: 'pending'; what: 'chart' | 'stats' | 'table' | 'progress' };

// Limits keep a malformed or oversized block from wrecking the layout.
const MAX_POINTS = 60;
const MAX_STATS = 4;
const MAX_PROGRESS = 4;
const MAX_SLICES = 6;
const MAX_TABLE_COLS = 6;
const MAX_TABLE_ROWS = 40;
const FENCES = new Set(['chart', 'stats', 'progress']);

const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isDividerLine = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l: string) =>
  l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
// A cell reads as a number when it starts with one: "80", "82.5 kg", "+12%", "4,915".
const looksNumeric = (c: string) => /^[+\-−]?\d[\d,.]*\s*(%|[a-zA-Z]{1,4})?$/.test(c.replace(/\*\*/g, '').trim());

function parsePoints(raw: unknown): ChartPoint[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .map((p) => {
      if (Array.isArray(p) && p.length >= 2) return { label: String(p[0]), value: Number(p[1]) };
      if (p && typeof p === 'object') {
        const q = p as Record<string, unknown>;
        return { label: String(q.label ?? q.x ?? ''), value: Number(q.value ?? q.y) };
      }
      return null;
    })
    .filter((p): p is ChartPoint => !!p && Number.isFinite(p.value))
    .slice(0, MAX_POINTS);
}

function parseChart(raw: string): ChartBlock | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const kind: ChartKind = o.kind === 'bar' ? 'bar' : o.kind === 'donut' || o.kind === 'pie' ? 'donut' : 'line';
  const base = {
    type: 'chart' as const,
    kind,
    title: typeof o.title === 'string' ? o.title : undefined,
    unit: typeof o.unit === 'string' ? o.unit : undefined,
  };

  if (kind === 'donut') {
    // A split of one whole: positive slices only, at least two of them.
    const points = parsePoints(o.points).filter((p) => p.value > 0).slice(0, MAX_SLICES);
    return points.length >= 2 ? { ...base, points } : null;
  }

  // Two series compare (this month vs last month). The first one leads.
  let points = parsePoints(o.points);
  let name: string | undefined;
  let compare: ChartBlock['compare'];
  if (kind === 'line' && Array.isArray(o.series)) {
    const series = (o.series as unknown[])
      .map((sr) => {
        if (!sr || typeof sr !== 'object') return null;
        const q = sr as Record<string, unknown>;
        return { name: String(q.name ?? ''), points: parsePoints(q.points) };
      })
      .filter((sr): sr is { name: string; points: ChartPoint[] } => !!sr && sr.points.length >= 2);
    if (series.length > 0) {
      points = series[0].points;
      name = series[0].name || undefined;
      if (series[1]) compare = { name: series[1].name, points: series[1].points };
    }
  }
  // A line needs two points to be a line; one bar is still a fact.
  if (points.length < (kind === 'line' ? 2 : 1)) return null;
  const goal = Number(o.goal);
  return {
    ...base,
    points,
    name,
    compare,
    goal: Number.isFinite(goal) && o.goal !== null && o.goal !== undefined ? goal : undefined,
    goalLabel: typeof o.goal_label === 'string' ? o.goal_label : undefined,
  };
}

function parseProgress(raw: string): ProgressItem[] | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(j)) return null;
  const items: ProgressItem[] = [];
  for (const it of j) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const value = Number(o.value);
    const target = Number(o.target);
    // No target, no progress: a bar needs something to fill toward.
    if (o.label == null || !Number.isFinite(value) || !Number.isFinite(target) || target <= 0) continue;
    items.push({ label: String(o.label), value, target, unit: typeof o.unit === 'string' ? o.unit : undefined });
    if (items.length === MAX_PROGRESS) break;
  }
  return items.length > 0 ? items : null;
}

function parseStats(raw: string): StatItem[] | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  const arr = Array.isArray(j) ? j : (j && typeof j === 'object' && Array.isArray((j as Record<string, unknown>).items))
    ? (j as { items: unknown[] }).items : null;
  if (!arr) return null;
  const items: StatItem[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (o.label == null || o.value == null) continue;
    items.push({
      label: String(o.label),
      value: String(o.value),
      note: o.note != null && String(o.note).trim() ? String(o.note) : undefined,
    });
    if (items.length === MAX_STATS) break;
  }
  return items.length > 0 ? items : null;
}

function tableFrom(lines: string[]): CoachBlock | null {
  const header = splitRow(lines[0]).slice(0, MAX_TABLE_COLS);
  const body = lines.slice(2).map((l) => {
    const cells = splitRow(l).slice(0, header.length);
    while (cells.length < header.length) cells.push('');
    return cells;
  }).slice(0, MAX_TABLE_ROWS);
  if (header.length < 2 || body.length === 0) return null;
  // A column is right-aligned when every filled cell in it is a number.
  const align = header.map((_, ci) => {
    const filled = body.map((r) => r[ci]).filter((c) => c !== '' && c !== '-');
    return filled.length > 0 && filled.every(looksNumeric) ? 'right' : 'left';
  }) as ('left' | 'right')[];
  return { type: 'table', header, rows: body, align };
}

/**
 * Split a reply into blocks. `streaming` is true while the reply is still
 * arriving: an unclosed fence or a table still growing at the end becomes a
 * `pending` block instead of raw text.
 */
export function parseCoachBlocks(content: string, streaming = false): CoachBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const out: CoachBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    const text = para.join('\n').trim();
    if (text) out.push({ type: 'paragraph', text });
    para = [];
  };
  const flushList = () => {
    if (list && list.items.length) out.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced block: ```chart / ```stats (any other fence is shown as text).
    const fence = /^```\s*([a-zA-Z_-]+)?\s*$/.exec(trimmed);
    if (fence) {
      const lang = (fence[1] ?? '').toLowerCase();
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '```') j++;
      let closed = j < lines.length;
      // A finished reply whose fence never closed (the model forgot the
      // closing ```): the block ends at the first blank line, and everything
      // after it is still the reply. Dropping to the end would lose the answer.
      let resumeAt = closed ? j + 1 : lines.length;
      if (!closed && !streaming) {
        let k = i + 1;
        while (k < lines.length && lines[k].trim() !== '') k++;
        j = k;
        resumeAt = k;
        closed = true;
      }
      const inner = lines.slice(i + 1, j).join('\n');
      flush();
      if (FENCES.has(lang)) {
        if (!closed) {
          // Still arriving: a quiet placeholder, never raw JSON.
          out.push({ type: 'pending', what: lang as 'chart' | 'stats' | 'progress' });
        } else if (lang === 'chart') {
          const c = parseChart(inner);
          if (c) out.push(c);
        } else if (lang === 'progress') {
          const items = parseProgress(inner);
          if (items) out.push({ type: 'progress', items });
        } else {
          const items = parseStats(inner);
          if (items) out.push({ type: 'stats', items });
        }
      } else if (inner.trim()) {
        out.push({ type: 'paragraph', text: inner.trim() });
      }
      i = resumeAt;
      continue;
    }

    // Pipe table: a header row, a divider row, then body rows.
    if (isTableLine(line)) {
      let j = i;
      while (j < lines.length && isTableLine(lines[j])) j++;
      const rows = lines.slice(i, j);
      const atEnd = j >= lines.length;
      if (rows.length >= 2 && isDividerLine(rows[1])) {
        flush();
        // The last row may still be arriving: wait for the next line.
        const settled = streaming && atEnd ? rows.slice(0, -1) : rows;
        const t = settled.length >= 3 ? tableFrom(settled) : null;
        if (t) out.push(t);
        else if (streaming && atEnd) out.push({ type: 'pending', what: 'table' });
        i = j;
        continue;
      }
      if (streaming && atEnd && rows.length === 1) {
        // A header with no divider yet: very likely a table on its way.
        flush();
        out.push({ type: 'pending', what: 'table' });
        i = j;
        continue;
      }
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      out.push({ type: 'heading', text: heading[1].trim() });
      i++;
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ? bullet[1] : numbered![2]).trim());
      i++;
      continue;
    }

    if (trimmed === '') {
      flush();
      i++;
      continue;
    }

    flushList();
    para.push(line);
    i++;
  }
  flush();
  return out;
}

/** A reply as plain text, for copy and select: charts and stats become lines. */
export function coachBlocksPlainText(content: string): string {
  return parseCoachBlocks(content)
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
        case 'heading':
          return b.text;
        case 'list':
          return b.items.map((t, n) => (b.ordered ? `${n + 1}. ${t}` : `- ${t}`)).join('\n');
        case 'table':
          return [b.header.join(' | '), ...b.rows.map((r) => r.join(' | '))].join('\n');
        case 'chart': {
          const unit = b.unit ? ` ${b.unit}` : '';
          const head = b.title ? `${b.title}: ` : '';
          const line = (pts: ChartPoint[]) => pts.map((p) => `${p.label} ${p.value}${unit}`).join(', ');
          if (b.compare) {
            return `${head}\n${b.name ?? 'Now'}: ${line(b.points)}\n${b.compare.name || 'Before'}: ${line(b.compare.points)}`;
          }
          return head + line(b.points);
        }
        case 'progress':
          return b.items.map((p) => `${p.label}: ${p.value} / ${p.target}${p.unit ? ` ${p.unit}` : ''}`).join('\n');
        case 'stats':
          return b.items.map((s) => `${s.label}: ${s.value}${s.note ? ` (${s.note})` : ''}`).join('\n');
        case 'pending':
          return '';
      }
    })
    .filter((t) => t !== '')
    .join('\n\n');
}
