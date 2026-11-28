// Scoring for the speech engine comparison (run.ts). No imports.
//
// Three numbers per clip, all against what the owner wrote down as said:
//   wer          word error rate after normalising case and punctuation
//                (edits / words said; 0 is perfect, can pass 1)
//   term_recall  of the food and training words that matter (must_have),
//                how many came back spelled right
//   latin        the transcript has no Devanagari. Hinglish must come back
//                in Latin letters, the way parse_meal and Drona read it.

export function norm(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function wer(said: string, heard: string): number {
  const a = norm(said);
  const b = norm(heard);
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/** Share of `terms` found in `heard`, each as a whole word run. 1 with no terms. */
export function termRecall(terms: string[], heard: string): number {
  if (terms.length === 0) return 1;
  const h = ` ${norm(heard).join(" ")} `;
  const found = terms.filter((t) => h.includes(` ${norm(t).join(" ")} `)).length;
  return found / terms.length;
}

export function isLatin(heard: string): boolean {
  return !/[ऀ-ॿ]/.test(heard);
}

export interface ClipScore {
  wer: number;
  term_recall: number;
  latin: boolean;
}

export function scoreClip(said: string, mustHave: string[], heard: string): ClipScore {
  return { wer: wer(said, heard), term_recall: termRecall(mustHave, heard), latin: isLatin(heard) };
}

/** Cost at a per-minute price, from the clips' own lengths. */
export function costUsd(totalSeconds: number, perMinuteUsd: number): number {
  return (totalSeconds / 60) * perMinuteUsd;
}
