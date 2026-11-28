/**
 * Read aloud for Drona's replies: what is said, from what is written.
 *
 * Drona writes markdown plus fenced blocks the app draws as tables, charts
 * and stats (lib/coachBlocks.ts). Read raw, a voice says "pipe Mon pipe 2100"
 * and every asterisk. So the speakable text keeps the sentences and drops the
 * rest: fenced blocks, table rows, heading and list marks, link targets, and
 * emphasis marks. Each line becomes one sentence.
 *
 * No imports, so Deno tests it (lib/voiceInput.test.ts). The speaking is
 * components/voice/ReadAloudToggle.tsx, on-device, through expo-speech.
 */

/** A long reply is read up to here, ending on a whole sentence. */
export const MAX_SPOKEN_CHARS = 1500;

export function speakableText(markdown: string, max = MAX_SPOKEN_CHARS): string {
  const withoutBlocks = markdown.replace(/```[\s\S]*?```/g, '\n');
  const sentences: string[] = [];
  for (const raw of withoutBlocks.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('|')) continue; // table row or rule
    if (/^([-*_])\1{2,}$/.test(line)) continue; // horizontal rule
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    sentences.push(/[.!?:;]$/.test(line) ? line : `${line}.`);
  }
  const text = sentences.join(' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end > 0) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space) : cut;
}
