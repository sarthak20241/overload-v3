// What a voice clip is and how long it is, read from the file itself.
//
// The app says how long it recorded, but a client can say anything, and the
// vendor bills by the minute. So the length cap reads the clip's own header:
//   m4a (what the app records): ftyp first, then moov/mvhd holds the
//     timescale and the duration, wherever moov sits among the top boxes.
//   wav (what a Wispr Flow engine would need: 16 kHz PCM): the fmt chunk's
//     byte rate and the data chunk's size.
// Anything else is refused before a slot is reserved or a vendor is paid.
//
// No Deno or network imports, so the tests run it directly.

/** A minute of speech, plus slack for the app's stop landing a moment late.
 *  The app stops itself at 60 s (lib/voiceInput.ts MAX_CLIP_MS). */
export const MAX_AUDIO_SECONDS = 62;

/** A tap that recorded nothing. The app drops these itself; this is the guard. */
export const MIN_AUDIO_SECONDS = 0.4;

/** 60 s of mono AAC at 32 kbps is about 240 KB. 1 MB leaves room for a phone
 *  that records richer than asked, and no room for a long file. */
export const MAX_AUDIO_BYTES = 1_000_000;

export type AudioFormat = "m4a" | "wav";

export type AudioCheck =
  | { ok: true; format: AudioFormat; seconds: number }
  | { ok: false; reason: "bad_audio" };

const BAD: AudioCheck = { ok: false, reason: "bad_audio" };

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

/** Two decimals: enough for a cap, and stable to compare in tests. */
function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/** Walk the boxes in [start, end). Calls `visit` with each box's type and its
 *  payload range. A box whose size runs past `end` stops the walk as broken. */
function walkBoxes(
  b: Uint8Array,
  start: number,
  end: number,
  visit: (type: string, from: number, to: number) => boolean | void,
): boolean {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = start;
  while (at + 8 <= end) {
    let size = v.getUint32(at);
    const type = fourcc(b, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return false;
      const big = v.getBigUint64(at + 8);
      if (big > BigInt(end - at)) return false;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - at; // runs to the end of the enclosing range
    }
    if (size < header || at + size > end) return false;
    if (visit(type, at + header, at + size) === true) return true;
    at += size;
  }
  return at === end;
}

function m4aSeconds(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let seconds: number | null = null;
  let broken = false;
  const ok = walkBoxes(b, 0, b.length, (type, from, to) => {
    if (type !== "moov") return;
    const inner = walkBoxes(b, from, to, (t, f, e) => {
      if (t !== "mvhd") return;
      const version = b[f];
      if (version === 1) {
        if (f + 32 > e) return (broken = true);
        const timescale = v.getUint32(f + 20);
        const duration = Number(v.getBigUint64(f + 24));
        if (timescale > 0) seconds = duration / timescale;
      } else {
        if (f + 20 > e) return (broken = true);
        const timescale = v.getUint32(f + 12);
        const duration = v.getUint32(f + 16);
        if (timescale > 0) seconds = duration / timescale;
      }
      return true;
    });
    if (!inner && seconds === null) broken = true;
    return true;
  });
  if (broken || (!ok && seconds === null)) return null;
  return seconds;
}

function wavSeconds(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  let byteRate = 0;
  let dataBytes = -1;
  while (at + 8 <= b.length) {
    const id = fourcc(b, at);
    const size = v.getUint32(at + 4, true);
    if (id === "fmt " && at + 20 <= b.length) {
      byteRate = v.getUint32(at + 16, true);
    } else if (id === "data") {
      // Some recorders write the data size as 0 or past the end while
      // streaming; what is actually in the file is the honest length.
      dataBytes = Math.min(size, b.length - at - 8);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (byteRate <= 0 || dataBytes < 0) return null;
  return dataBytes / byteRate;
}

/** The clip's format and its length in seconds, or bad_audio. */
export function inspectAudio(bytes: Uint8Array): AudioCheck {
  if (bytes.length < 12) return BAD;
  if (fourcc(bytes, 0) === "RIFF" && fourcc(bytes, 8) === "WAVE") {
    const s = wavSeconds(bytes);
    return s === null ? BAD : { ok: true, format: "wav", seconds: round(s) };
  }
  if (fourcc(bytes, 4) === "ftyp") {
    const s = m4aSeconds(bytes);
    return s === null ? BAD : { ok: true, format: "m4a", seconds: round(s) };
  }
  return BAD;
}
