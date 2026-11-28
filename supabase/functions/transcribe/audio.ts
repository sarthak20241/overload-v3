// What a voice clip is and how long it is, read from the file itself.
//
// The app says how long it recorded, but a client can say anything, and the
// vendor bills by the minute. So the length cap reads the file. A file's
// header is also written by the client, so no single field is trusted: every
// reading of the length is taken, and the LONGEST one counts.
//   m4a (what the app records): exactly one moov, audio tracks only. Its
//     mvhd (the movie's length), and for each track its mdhd length and its
//     frame count from stsz, which is what a decoder actually plays (AAC:
//     1024 samples a frame, at the track's timescale, its sample rate).
//   wav (what a Wispr Flow engine would need: 16 kHz PCM): the data chunk's
//     bytes over the slower of the fmt chunk's byte-rate field and the rate
//     its sample format works out to.
// Then a ceiling on bytes per second: no speech clip the app makes comes near
// it, so a big file that claims to be short is refused whatever it says.
// Anything else is refused before a slot is reserved or a vendor is paid.
//
// This bounds what is billed; it is not a decoder. The rate limit (25 clips
// a day free, 200 Pro) bounds whatever gets past it.
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

/** Twice 16 kHz 16-bit mono PCM (32 KB/s), the richest format a voice clip
 *  here comes in. AAC at 32 kbps is 4 KB/s. Small files skip the check: a
 *  half-second m4a is mostly its own header. */
export const MAX_BYTES_PER_SECOND = 64_000;
const BYTE_RATE_CHECK_FROM = 64 * 1024;

/** Samples in one AAC frame (stsz counts frames). */
const AAC_FRAME_SAMPLES = 1024;

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
 *  payload range; `visit` returning true stops the walk. Returns false when a
 *  box's size runs past `end` (a broken or lying file). */
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

/** The first child box of `type` in [from, to), as its payload range. */
function child(b: Uint8Array, from: number, to: number, type: string): [number, number] | null {
  let found: [number, number] | null = null;
  walkBoxes(b, from, to, (t, f, e) => {
    if (t !== type) return;
    found = [f, e];
    return true;
  });
  return found;
}

/** mvhd / mdhd: timescale and duration, version 0 or 1. Null when short. */
function headerSeconds(b: Uint8Array, f: number, e: number): { timescale: number; seconds: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = b[f];
  if (version === 1) {
    if (f + 32 > e) return null;
    const timescale = v.getUint32(f + 20);
    return timescale > 0 ? { timescale, seconds: Number(v.getBigUint64(f + 24)) / timescale } : null;
  }
  if (f + 20 > e) return null;
  const timescale = v.getUint32(f + 12);
  return timescale > 0 ? { timescale, seconds: v.getUint32(f + 16) / timescale } : null;
}

/** How many direct children of `type` sit in [from, to). */
function countChildren(b: Uint8Array, from: number, to: number, type: string): number {
  let n = 0;
  walkBoxes(b, from, to, (t) => {
    if (t === type) n++;
  });
  return n;
}

/** Every length reading in the file; the longest counts. Null (bad_audio)
 *  when a box runs past the end, or the file is not what the app records:
 *  exactly one moov, at least one track, every track audio ('soun'), one
 *  mdia per track. A second moov or a video track is how a file would show a
 *  decoder one length and this check another, so neither is accepted. */
function m4aSeconds(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const readings: number[] = [];
  const moovs: [number, number][] = [];
  const ok = walkBoxes(b, 0, b.length, (type, from, to) => {
    if (type === "moov") moovs.push([from, to]);
  });
  if (!ok || moovs.length !== 1) return null;
  const [mf, mt] = moovs[0];

  let broken = false;
  let tracks = 0;
  const innerOk = walkBoxes(b, mf, mt, (type, f, e) => {
    if (type === "mvhd") {
      const h = headerSeconds(b, f, e);
      if (!h) return (broken = true);
      readings.push(h.seconds);
    } else if (type === "trak") {
      tracks++;
      if (countChildren(b, f, e, "mdia") !== 1) return (broken = true);
      const mdia = child(b, f, e, "mdia")!;
      const hdlr = child(b, mdia[0], mdia[1], "hdlr");
      if (!hdlr || hdlr[0] + 12 > hdlr[1] || fourcc(b, hdlr[0] + 8) !== "soun") return (broken = true);
      const mdhd = child(b, mdia[0], mdia[1], "mdhd");
      const h = mdhd ? headerSeconds(b, mdhd[0], mdhd[1]) : null;
      if (!h) return (broken = true);
      readings.push(h.seconds);
      const minf = child(b, mdia[0], mdia[1], "minf");
      const stbl = minf ? child(b, minf[0], minf[1], "stbl") : null;
      const stsz = stbl ? child(b, stbl[0], stbl[1], "stsz") : null;
      if (stsz) {
        if (stsz[0] + 12 > stsz[1]) return (broken = true);
        readings.push((v.getUint32(stsz[0] + 8) * AAC_FRAME_SAMPLES) / h.timescale);
      }
    }
  });
  if (broken || !innerOk || tracks === 0 || readings.length === 0) return null;
  return Math.max(...readings);
}

function wavSeconds(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  let rate = 0;
  let dataBytes = -1;
  while (at + 8 <= b.length) {
    const id = fourcc(b, at);
    const size = v.getUint32(at + 4, true);
    if (id === "fmt ") {
      if (size < 16 || at + 8 + 16 > b.length) return null; // cut off
      const channels = v.getUint16(at + 10, true);
      const sampleRate = v.getUint32(at + 12, true);
      const byteRateField = v.getUint32(at + 16, true);
      const bits = v.getUint16(at + 22, true);
      const fromFormat = (sampleRate * channels * bits) / 8;
      // The slower rate gives the longer length: never trust the one field.
      const candidates = [byteRateField, fromFormat].filter((r) => r > 0);
      rate = candidates.length ? Math.min(...candidates) : 0;
    } else if (id === "data") {
      // Some recorders write the data size as 0, or past the end, while
      // streaming. Then what is actually in the file is the length.
      const held = b.length - at - 8;
      dataBytes = size === 0 || size > held ? held : size;
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (rate <= 0 || dataBytes < 0) return null;
  return dataBytes / rate;
}

/** The clip's format and its length in seconds, or bad_audio. */
export function inspectAudio(bytes: Uint8Array): AudioCheck {
  if (bytes.length < 12) return BAD;
  let format: AudioFormat;
  let seconds: number | null;
  if (fourcc(bytes, 0) === "RIFF" && fourcc(bytes, 8) === "WAVE") {
    format = "wav";
    seconds = wavSeconds(bytes);
  } else if (fourcc(bytes, 4) === "ftyp") {
    format = "m4a";
    seconds = m4aSeconds(bytes);
  } else {
    return BAD;
  }
  if (seconds === null || !Number.isFinite(seconds)) return BAD;
  if (bytes.length >= BYTE_RATE_CHECK_FROM && bytes.length / Math.max(seconds, 0.01) > MAX_BYTES_PER_SECOND) return BAD;
  return { ok: true, format, seconds: round(seconds) };
}
