// Run: deno test --allow-all lib/foodPhoto.test.ts
//
// Photo food logging in the app: when the camera button shows, how a photo is
// sized before upload, and the hand-off from the camera screen to the food box.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  FOOD_PHOTO_CAPABILITY,
  FOOD_PHOTO_FLAG,
  FOOD_PHOTO_MIN_BUILD,
  fitLongEdge,
  PENDING_PHOTO_MAX_AGE_MS,
  PHOTO_LONG_EDGE,
  photoButtonShows,
  photoCameraAllowed,
  photoShownText,
  photoTurnText,
  setPendingPhoto,
  takePendingPhoto,
  withoutPhotoTurn,
  withPhotoText,
} from "./foodPhoto.ts";

// ── sizing ──────────────────────────────────────────────────────────────────

Deno.test("size: the long edge goes to 1568 px, the shape is kept", () => {
  assertEquals(PHOTO_LONG_EDGE, 1568);
  assertEquals(fitLongEdge(4032, 3024), { width: 1568, height: 1176 });
  assertEquals(fitLongEdge(3024, 4032), { width: 1176, height: 1568 });
});

Deno.test("size: a photo already small enough is not enlarged", () => {
  assertEquals(fitLongEdge(1200, 900), { width: 1200, height: 900 });
});

Deno.test("size: never zero, never fractional", () => {
  const out = fitLongEdge(10000, 3)!;
  assertEquals(out.width, 1568);
  assertEquals(out.height, 1);
  assertEquals(fitLongEdge(0, 0), null);
});

// ── when the camera button shows ────────────────────────────────────────────

// A dev build: no store build is allowed yet (FOOD_PHOTO_MIN_BUILD).
const on = { flag: "on", os: "ios", build: "999", dev: true, signedIn: true, cardOnScreen: false };

Deno.test("button: needs the flag on", () => {
  assertEquals(FOOD_PHOTO_FLAG, "food-photo");
  assert(photoButtonShows(on));
  assert(!photoButtonShows({ ...on, flag: "off" }));
  assert(!photoButtonShows({ ...on, flag: null }));
});

Deno.test("button: never on a binary whose camera prompt still says video is never uploaded", () => {
  // The first store build with the new camera wording is not known yet: until
  // it is set, no store build shows the button.
  for (const os of ["ios", "android"] as const) {
    const min = FOOD_PHOTO_MIN_BUILD[os];
    if (min === null) {
      assert(!photoCameraAllowed({ os, build: "99999", dev: false }), `${os}: no store build yet`);
    } else {
      assert(!photoCameraAllowed({ os, build: String(min - 1), dev: false }), `${os}: older build`);
      assert(photoCameraAllowed({ os, build: String(min), dev: false }), `${os}: first build`);
    }
  }
  assert(!photoCameraAllowed({ os: "web", build: null, dev: false }));
  assert(!photoCameraAllowed({ os: "ios", build: null, dev: false }));
  assert(!photoCameraAllowed({ os: "ios", build: "abc", dev: false }));
});

Deno.test("button: a dev build may use it to test", () => {
  assert(photoCameraAllowed({ os: "ios", build: "1", dev: true }));
  assert(!photoCameraAllowed({ os: "web", build: null, dev: true }));
});

Deno.test("button: signed in, and only with no card under review", () => {
  const dev = { ...on, dev: true };
  assert(photoButtonShows(dev));
  assert(!photoButtonShows({ ...dev, signedIn: false }));
  assert(!photoButtonShows({ ...dev, cardOnScreen: true }));
});

Deno.test("capability: the name the server reads", () => {
  assertEquals(FOOD_PHOTO_CAPABILITY, "food_photo");
});

// ── hand-off from the camera screen ─────────────────────────────────────────

const img = { media_type: "image/jpeg" as const, data: "/9j/AAAA", uri: "file:///tmp/a.jpg", width: 1568, height: 1176 };

Deno.test("hand-off: taken once, with its note and meal", () => {
  setPendingPhoto({ images: [img], note: "  cooked in ghee ", meal: "lunch", day: new Date(2026, 10, 28) }, 1000);
  const p = takePendingPhoto(1500)!;
  assertEquals(p.note, "cooked in ghee");
  assertEquals(p.meal, "lunch");
  assertEquals(p.images.length, 1);
  assertEquals(takePendingPhoto(1600), null);
});

Deno.test("hand-off: at most two images, none is nothing", () => {
  setPendingPhoto({ images: [img, img, img], note: "", meal: "dinner", day: new Date() }, 0);
  assertEquals(takePendingPhoto(1)!.images.length, 2);
  setPendingPhoto({ images: [], note: "x", meal: "dinner", day: new Date() }, 0);
  assertEquals(takePendingPhoto(1), null);
});

Deno.test("hand-off: an old one is dropped, not sent out of nowhere", () => {
  setPendingPhoto({ images: [img], note: "", meal: "snack", day: new Date() }, 0);
  assertEquals(takePendingPhoto(PENDING_PHOTO_MAX_AGE_MS + 1), null);
});

Deno.test("hand-off: a dropped one's files are handed back to be deleted", () => {
  const dropped: string[][] = [];
  const drop = (shots: { uri: string }[]) => dropped.push(shots.map((s) => s.uri));
  const a = { ...img, uri: "file:///tmp/a.jpg" };
  const b = { ...img, uri: "file:///tmp/b.jpg" };
  // Replaced by a newer one.
  setPendingPhoto({ images: [a], note: "", meal: "snack", day: new Date() }, 0, drop);
  setPendingPhoto({ images: [b], note: "", meal: "snack", day: new Date() }, 1, drop);
  assertEquals(dropped, [["file:///tmp/a.jpg"]]);
  // Too old when taken.
  assertEquals(takePendingPhoto(PENDING_PHOTO_MAX_AGE_MS + 10, drop), null);
  assertEquals(dropped, [["file:///tmp/a.jpg"], ["file:///tmp/b.jpg"]]);
  // A taken one is the caller's to delete, not dropped here.
  setPendingPhoto({ images: [a], note: "", meal: "snack", day: new Date() }, 0, drop);
  assert(takePendingPhoto(1, drop));
  assertEquals(dropped.length, 2);
});

// ── the card after a photo ──────────────────────────────────────────────────

Deno.test("turns: the photo's turn becomes the words its read made", () => {
  const turns = [
    { role: "drona" as const, text: "Logged your breakfast." },
    { role: "user" as const, text: "A photo of my meal." },
  ];
  assertEquals(withPhotoText(turns, "dal tadka (~200 g)"), [
    { role: "drona", text: "Logged your breakfast." },
    { role: "user", text: "dal tadka (~200 g)" },
  ]);
  // Nothing to swap: the list is left as it is.
  assertEquals(withPhotoText([], "dal"), []);
  assertEquals(withPhotoText([{ role: "drona" as const, text: "hi" }], "dal"), [{ role: "drona", text: "hi" }]);
});

Deno.test("turns: a failed photo send takes its turn back, so a Retry does not add it twice", () => {
  const before = [{ role: "drona" as const, text: "Logged your breakfast." }];
  const sent = [...before, { role: "user" as const, text: photoTurnText("cooked in ghee") }];
  assertEquals(withoutPhotoTurn(sent), before);
  assertEquals(withoutPhotoTurn([...before, { role: "user" as const, text: photoTurnText("") }]), before);
  // Anything else is left alone.
  const typed = [...before, { role: "user" as const, text: "2 eggs" }];
  assertEquals(withoutPhotoTurn(typed), typed);
  assertEquals(withoutPhotoTurn([]), []);
});

Deno.test("shown text: a photo with no note still says what was sent", () => {
  assertEquals(photoShownText(""), "Your meal photo");
  assertEquals(photoShownText("cooked in ghee"), "cooked in ghee");
});
