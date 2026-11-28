/**
 * Photo food logging in the app (server side: ai-coach/foodPhoto.ts).
 *
 * The food box's camera button opens app/food-photo.tsx. The user takes one
 * photo (and may add a second angle), adds a note, and taps Send. The screen
 * leaves the photos here and goes back; /nutrition takes them once on focus and
 * runs its own parse, the same hand-off lib/pendingParse uses for food search.
 *
 * Three locks keep the button away from builds and users it is not for:
 *   1. the PostHog flag `food-photo` (variant "on"), so it can be turned off
 *      with no release;
 *   2. the binary: store builds before FOOD_PHOTO_MIN_BUILD still carry the old
 *      camera prompt ("your video is never uploaded"), which a meal photo
 *      would break, so they never show it;
 *   3. the server's own FOOD_PHOTO flag, which answers a photo with "type it"
 *      while off.
 *
 * No imports, so Deno can test it directly: deno test lib/foodPhoto.test.ts
 */

/** What a build sends in `supports` to say it can send photos. Mirrors
 *  CLIENT_CAP_FOOD_PHOTO in the ai-coach function. */
export const FOOD_PHOTO_CAPABILITY = 'food_photo' as const;

export const FOOD_PHOTO_FLAG = 'food-photo';

// TODO(release): set both numbers in the release that ships the new
// NSCameraUsageDescription, or photo logging stays dev-only.
/** The first store build (iOS CFBundleVersion, Android versionCode) whose
 *  camera prompt covers meal photos. null: no such build yet, so no store
 *  build shows the button. Set both when that build is cut (app.json
 *  NSCameraUsageDescription changed in the same PR as this file). */
export const FOOD_PHOTO_MIN_BUILD: { ios: number | null; android: number | null } = { ios: null, android: null };

/** Long edge in pixels. About 2,350 image tokens per photo at 4:3 (Claude's
 *  vision guide: larger images are scaled down server side anyway, so a
 *  bigger upload only costs time). */
export const PHOTO_LONG_EDGE = 1568;
/** One JPEG pass at this quality (0 to 100). */
export const PHOTO_JPEG_QUALITY = 80;
export const PHOTO_MAX_IMAGES = 2;

/** The size to resize a photo to, or null for an empty one. Never enlarges. */
export function fitLongEdge(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const long = Math.max(width, height);
  const k = long > PHOTO_LONG_EDGE ? PHOTO_LONG_EDGE / long : 1;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** This binary may use the camera for meal photos. */
export function photoCameraAllowed(s: { os: string; build: string | null; dev: boolean }): boolean {
  if (s.os !== 'ios' && s.os !== 'android') return false;
  if (s.dev) return true;
  const min = FOOD_PHOTO_MIN_BUILD[s.os];
  const n = s.build !== null && /^\d+$/.test(s.build.trim()) ? parseInt(s.build, 10) : null;
  return min !== null && n !== null && n >= min;
}

/** Photo logging may run here: the flag is on and this binary's camera
 *  prompt covers meal photos. The camera screen checks it before it asks for
 *  the camera, and the food box before it sends a hand-off, so a deep link
 *  cannot reach either on a build the button would not show on. */
export function photoLoggingAllowed(s: { flag: string | null; os: string; build: string | null; dev: boolean }): boolean {
  return s.flag === 'on' && photoCameraAllowed(s);
}

/** The camera button shows in the food box. Only with no card under review:
 *  a photo starts a meal, it does not correct one. */
export function photoButtonShows(s: {
  flag: string | null;
  os: string;
  build: string | null;
  dev: boolean;
  signedIn: boolean;
  cardOnScreen: boolean;
}): boolean {
  return s.signedIn && !s.cardOnScreen && photoLoggingAllowed(s);
}

// ── Hand-off from the camera screen ─────────────────────────────────────────

/** Same union as lib/foods MealType, kept local so this file stays import-free. */
export type PendingPhotoMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface PhotoShot {
  media_type: 'image/jpeg';
  /** Base64, no data: prefix. */
  data: string;
  /** The resized file, for the review screen. */
  uri: string;
  width: number;
  height: number;
}

export interface PendingPhoto {
  images: PhotoShot[];
  note: string;
  meal: PendingPhotoMeal;
  day: Date;
  at: number;
}

/** Long enough to outlast a parse still running on Nutrition, which the
 *  hand-off waits for; short enough that a lost one never surprises. */
export const PENDING_PHOTO_MAX_AGE_MS = 2 * 60_000;

let _pending: PendingPhoto | null = null;

/** Deletes a dropped hand-off's resized files (lib/foodPhotoCapture
 *  discardShots). Passed in so this file stays import-free. */
export type DropShots = (shots: PhotoShot[]) => void;

/** Leave photos for Nutrition. A newer hand-off replaces an older one, and
 *  the older one's files go to `drop`. */
export function setPendingPhoto(
  p: { images: PhotoShot[]; note: string; meal: PendingPhotoMeal; day: Date },
  now: number = Date.now(),
  drop?: DropShots,
): void {
  if (_pending) drop?.(_pending.images);
  const images = p.images.slice(0, PHOTO_MAX_IMAGES);
  _pending = images.length
    ? { images, note: p.note.replace(/\s+/g, ' ').trim(), meal: p.meal, day: new Date(p.day.getTime()), at: now }
    : null;
}

/** Take the waiting photos, if any. Reading them clears them. One too old
 *  to send has its files go to `drop`; a taken one is the caller's to delete. */
export function takePendingPhoto(now: number = Date.now(), drop?: DropShots): PendingPhoto | null {
  const p = _pending;
  _pending = null;
  if (!p) return null;
  if (now - p.at > PENDING_PHOTO_MAX_AGE_MS) {
    drop?.(p.images);
    return null;
  }
  return p;
}

// ── The card after a photo ──────────────────────────────────────────────────

/** What the food box shows for a photo send: the note, or a plain label when
 *  there is none, so a card never shows a blank request. */
export function photoShownText(note: string): string {
  return note.trim() || 'Your meal photo';
}

/** The user's turn for a photo send, before the read's words replace it. */
const PHOTO_TURN = 'A photo of my meal.';
export function photoTurnText(note: string): string {
  const n = note.trim();
  return n ? `${PHOTO_TURN} ${n}` : PHOTO_TURN;
}

/** The conversation after a photo send that failed: its turn is taken back,
 *  so a Retry (which adds it again) does not leave it in twice. */
export function withoutPhotoTurn<T extends { role: 'user' | 'drona'; text: string }>(turns: T[]): T[] {
  const last = turns.length - 1;
  if (last < 0 || turns[last].role !== 'user' || !turns[last].text.startsWith(PHOTO_TURN)) return turns;
  return turns.slice(0, last);
}

/** The conversation after a photo meal: the user's last turn becomes the
 *  words the photo read made, so a follow-up ("the rice was one cup") is read
 *  against what the card was built from. */
export function withPhotoText<T extends { role: 'user' | 'drona'; text: string }>(turns: T[], photoText: string): T[] {
  const last = turns.length - 1;
  if (last < 0 || turns[last].role !== 'user') return turns;
  return [...turns.slice(0, last), { ...turns[last], text: photoText }];
}
