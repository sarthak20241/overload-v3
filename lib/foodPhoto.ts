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
export const FOOD_PHOTO_CAPABILITY = 'food_photo';

export const FOOD_PHOTO_FLAG = 'food-photo';

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
  return s.flag === 'on' && s.signedIn && !s.cardOnScreen && photoCameraAllowed(s);
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

/** Leave photos for Nutrition. A newer hand-off replaces an older one. */
export function setPendingPhoto(
  p: { images: PhotoShot[]; note: string; meal: PendingPhotoMeal; day: Date },
  now: number = Date.now(),
): void {
  const images = p.images.slice(0, PHOTO_MAX_IMAGES);
  _pending = images.length
    ? { images, note: p.note.replace(/\s+/g, ' ').trim(), meal: p.meal, day: new Date(p.day.getTime()), at: now }
    : null;
}

/** Take the waiting photos, if any. Reading them clears them. */
export function takePendingPhoto(now: number = Date.now()): PendingPhoto | null {
  const p = _pending;
  _pending = null;
  if (!p || now - p.at > PENDING_PHOTO_MAX_AGE_MS) return null;
  return p;
}
