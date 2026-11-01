// Precise's label pictures: the pieces of the image read that need no model.
//
// Brand sites and Amazon often print the nutrition label only as a picture,
// so the page text holds no numbers and the text reader has nothing to copy
// (live 2026-10-18: tooyumm.com and amazon.in were the right pages for "Too
// Yum protein masala oats", 0.86-0.97 relevant, and every panel lookup came
// back empty). This file picks which of a page's images to show Jev, fetches
// them, and checks they are in Jev's limits. Jev then says which image is the
// label (a yes/no it is good at), and the parse model copies the numbers off
// that one image. Jev never reads a number.
//
// Runtime-agnostic, like tavily.ts and jev.ts: no Deno globals, no jsr:/https:
// imports, fetch injected.

import type { JevImageAsset, JevQuestion } from "./jev.ts";

/** Jev's yes on "is this image this food's nutrition table" must reach this.
 *  Measured on the two real label pages (tooyumm.com, amazon.in, 17 images):
 *  both label images 0.99; the pack back, where the label is a small part of
 *  the photo, 0.45 and 0.31; everything else 0.02-0.04. 0.7 sits in the empty
 *  gap, and a pack back's tiny print is the one we do not want read anyway. */
export const IMAGE_FLOOR = 0.7;
/** Pages whose images are looked at. The two most relevant are enough for one
 *  reading each, and two agreeing pages earn the verified badge. */
export const MAX_IMAGE_PAGES = 2;
/** Images per page shown to Jev, in page order. Product galleries run 7-10. */
export const MAX_IMAGES_PER_PAGE = 10;
/** Images the reader sees, at most one per page. */
export const MAX_READ_IMAGES = 2;
/** Per image. Above Anthropic's 5 MB image limit once base64'd it is useless. */
export const MAX_IMAGE_BYTES = 3_500_000;
/** All images in one Jev request, before base64. Jev's body limit is 32 MiB. */
export const MAX_TOTAL_IMAGE_BYTES = 16_000_000;

/** Jev's size rules (docs.typesafe.ai/images). Out of range is rejected, not
 *  resized, and one bad image fails the whole request. */
export const JEV_MIN_SIDE = 280;
export const JEV_MAX_SIDE = 1568;
const JEV_MIN_PIXELS = 78_400;
const JEV_MAX_PIXELS = 2_458_624;

export function inJevLimits(width: number, height: number): boolean {
  const px = width * height;
  return width >= JEV_MIN_SIDE && height >= JEV_MIN_SIDE && width <= JEV_MAX_SIDE && height <= JEV_MAX_SIDE &&
    px >= JEV_MIN_PIXELS && px <= JEV_MAX_PIXELS;
}

/** Site furniture, never a label: logos, sprites, icons, spinners, avatars. */
const NOT_A_LABEL = /logo|sprite|icon|loader|loading|spinner|payment|avatar|placeholder/i;

/**
 * A page's image urls -> the ones worth showing Jev, sized for its limits
 * where the image server lets us ask for a size, de-duplicated, page order kept.
 *
 * Code only drops what cannot be a label and asks two CDNs we see on label
 * pages for a size inside Jev's limits. Which kept image IS the label is Jev's
 * call, never a guess from a file name.
 */
export function imageCandidates(images: string[], max = MAX_IMAGES_PER_PAGE): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of images) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    u.protocol = "https:";
    const path = u.pathname.toLowerCase();
    if (/\.(svg|gif|ico|webp|avif)$/.test(path)) continue;
    if (NOT_A_LABEL.test(path)) continue;
    let key: string;
    if (u.hostname === "m.media-amazon.com" || u.hostname.endsWith(".media-amazon.com")) {
      // Product photos live under /images/I/<id>.<size>.jpg; /images/G and
      // /images/S are the site's own chrome. The page lists 38x50 thumbnails,
      // so ask for the 1000 px version, which Amazon caps at the original.
      const m = /^\/images\/I\/([A-Za-z0-9+\-%]+)\.(?:[^/]*\.)?(jpe?g|png)$/i.exec(u.pathname);
      if (!m) continue;
      key = `amazon:${m[1]}`;
      u = new URL(`https://m.media-amazon.com/images/I/${m[1]}._SL1000_.${m[2].toLowerCase()}`);
    } else if (u.pathname.includes("/cdn/shop/") || u.hostname === "cdn.shopify.com") {
      // Shopify serves any width asked for. Its pages list each image at
      // several widths and crops; one 800 px copy is inside Jev's limits and
      // still sharp enough to read a label.
      key = `shopify:${u.hostname}${u.pathname}`;
      for (const p of ["width", "height", "crop"]) u.searchParams.delete(p);
      u.searchParams.set("width", "800");
    } else {
      // A Cloudflare resize (/cdn-cgi/image/<options>/<path>) is the same
      // picture as <path>, usually re-encoded as WebP: Blinkit lists both.
      key = `${u.hostname}${u.pathname.replace(/^\/cdn-cgi\/image\/[^/]+/, "")}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.toString());
    if (out.length >= max) break;
  }
  return out;
}

export interface ImageInfo {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

/**
 * Format and size from the file's own header, never from its name or the
 * server's content-type (a .png url served a PNG with format=jpg asked for).
 * Null for anything Jev would reject on sight: not PNG or JPEG, or an
 * animated PNG.
 */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const width = dv.getUint32(16);
    const height = dv.getUint32(20);
    // An acTL chunk before the image data marks an animated PNG.
    let at = 8;
    while (at + 8 <= b.length) {
      const len = dv.getUint32(at);
      const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
      if (type === "acTL") return null;
      if (type === "IDAT") break;
      at += 12 + len;
    }
    return { format: "png", width, height };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      // Padding and markers with no length.
      if (marker === 0xff) { at++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const len = (b[at + 2] << 8) | b[at + 3];
      // Baseline, extended and progressive. Jev's guide says "baseline JPEG",
      // but Amazon serves every product photo progressive and Jev answered
      // them (measured 2026-11-01: the label at 0.99); refusing them lost the
      // live miss's Amazon label. Lossless and arithmetic kinds are left out.
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { format: "jpeg", height: (b[at + 5] << 8) | b[at + 6], width: (b[at + 7] << 8) | b[at + 8] };
      }
      if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return null;
      if (marker === 0xda) return null;
      at += 2 + len;
    }
  }
  return null;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface FetchedImage extends ImageInfo {
  url: string;
  base64: string;
  bytes: number;
}

export type ImageSkip = "http" | "too_big" | "not_png_or_jpeg" | "out_of_limits" | "timeout";

/** Downloads at once per page. A shop's own image server cut off half of ten
 *  parallel downloads (bagrrys.com, 2026-11-01); four at a time held. */
export const IMAGE_FETCH_CONCURRENCY = 4;

/**
 * A page's images, IMAGE_FETCH_CONCURRENCY at a time, in the order given.
 * A download cut off mid-way is tried once more; an answer the server gave
 * (a 404, a too-big file) is not.
 */
export async function fetchImages(
  urls: string[],
  deps: { fetchFn?: typeof fetch; timeoutMs: number; abortSignal?: AbortSignal },
): Promise<Array<FetchedImage | { skip: ImageSkip }>> {
  const out: Array<FetchedImage | { skip: ImageSkip }> = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      let got = await fetchImage(urls[i], deps);
      if ("skip" in got && got.skip === "http" && got.thrown && !deps.abortSignal?.aborted) {
        got = await fetchImage(urls[i], deps);
      }
      out[i] = "skip" in got ? { skip: got.skip } : got;
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, urls.length) }, worker));
  return out;
}

/** One image, checked against Jev's limits. Never throws. `thrown` marks a
 *  download that broke off rather than one the server refused. */
export async function fetchImage(
  url: string,
  deps: { fetchFn?: typeof fetch; timeoutMs: number; abortSignal?: AbortSignal },
): Promise<FetchedImage | { skip: ImageSkip; thrown?: boolean }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const onAbort = () => controller.abort();
  if (deps.abortSignal?.aborted) controller.abort();
  deps.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return { skip: "http" };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return { skip: "too_big" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return { skip: "too_big" };
    const info = sniffImage(bytes);
    if (!info) return { skip: "not_png_or_jpeg" };
    if (!inJevLimits(info.width, info.height)) return { skip: "out_of_limits" };
    return { ...info, url, base64: toBase64(bytes), bytes: bytes.length };
  } catch {
    return controller.signal.aborted ? { skip: "timeout" } : { skip: "http", thrown: true };
  } finally {
    clearTimeout(timer);
    deps.abortSignal?.removeEventListener("abort", onAbort);
  }
}

/** The reference that stands for image `id` in a Jev request. Long and odd on
 *  purpose: Jev swaps it for the image wherever it appears as text. */
export const assetRef = (id: string) => `overload-label-image-${id}`;

export function imageAssets(images: Array<{ id: string; img: FetchedImage }>): Record<string, JevImageAsset> {
  return Object.fromEntries(images.map(({ id, img }) => [assetRef(id), { data_base64: img.base64, format: img.format }]));
}

/** One Jev yes/no per image, all in one request. Each image sits in the state
 *  under `image_<id>`, next to the page it came from. */
export function imagePanelQuestions(ids: string[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const id of ids) {
    out[id] = {
      type: "noul",
      instructions:
        `Is \`image_${id}\` the nutrition facts table for the food in \`food\`? It is a picture from ` +
        `\`page_${id}\`, a page about this food. Yes only when the picture is a table of nutrition ` +
        "numbers (energy, protein, carbohydrate, fat) large enough to read. A photo of the pack front, a " +
        'claim badge such as "22 g protein", an ingredient list, cooking steps, a lifestyle photo, or a ' +
        "table for a different product named in the picture is not.",
      criteria: {
        true: "A readable nutrition facts table for this food.",
        false: "Not a readable nutrition facts table for this food.",
      },
    };
  }
  return out;
}
