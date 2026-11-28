// The app never reads the photo library: Drona Eyes films live with the camera
// (VisionCamera), and the upload path in lib/form/videoFrames.ts has no picker.
// expo-image-picker was installed for that upload path and never wired up, but
// its config plugin still put a photo-library prompt into Info.plist and
// READ/WRITE_EXTERNAL_STORAGE into the Android manifest. Both stores flag a
// permission no screen uses, so this pins it out until a screen needs it.
//
// Run: deno test --allow-all lib/appPermissions.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

const root = new URL("../", import.meta.url);
const appJson = JSON.parse(await Deno.readTextFile(new URL("app.json", root)));
const pkg = JSON.parse(await Deno.readTextFile(new URL("package.json", root)));
const expo = appJson.expo;

const pluginNames: string[] = (expo.plugins ?? []).map((p: unknown) =>
  Array.isArray(p) ? String(p[0]) : String(p)
);

Deno.test("no photo-library picker package or plugin", () => {
  assertEquals(pkg.dependencies?.["expo-image-picker"], undefined);
  assert(!pluginNames.includes("expo-image-picker"), "expo-image-picker plugin is still in app.json");
});

Deno.test("iOS: no photo-library usage strings", () => {
  const plist = expo.ios?.infoPlist ?? {};
  assertEquals(plist.NSPhotoLibraryUsageDescription, undefined);
  assertEquals(plist.NSPhotoLibraryAddUsageDescription, undefined);
});

Deno.test("Android: no media or storage read permissions", () => {
  const perms: string[] = expo.android?.permissions ?? [];
  for (const p of [
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
  ]) {
    assert(!perms.includes(p), `${p} is requested`);
  }
});

// expo-file-system's config plugin adds READ/WRITE_EXTERNAL_STORAGE on its own.
// The app only writes its own folders (Paths.document, Paths.cache), which need
// no permission, so both are blocked rather than merely left out of the list.
Deno.test("Android: storage permissions are blocked", () => {
  const blocked: string[] = expo.android?.blockedPermissions ?? [];
  assert(blocked.includes("android.permission.READ_EXTERNAL_STORAGE"), "READ_EXTERNAL_STORAGE not blocked");
  assert(blocked.includes("android.permission.WRITE_EXTERNAL_STORAGE"), "WRITE_EXTERNAL_STORAGE not blocked");
});

// Photo food logging (lib/foodPhoto.ts) sends meal photos to Drona, so the
// camera prompt must say so and must not promise that nothing is uploaded.
// Gallery pick is left out on purpose: the picker package is pinned out above.
Deno.test("the camera prompt covers meal photos and does not promise nothing leaves the phone", () => {
  const s = String(expo.ios?.infoPlist?.NSCameraUsageDescription ?? "");
  assert(/meal/i.test(s), "the prompt names meal photos");
  assert(/form/i.test(s), "the prompt still names the form check");
  assert(!/everything is analysed on your phone/i.test(s), "no blanket on-device promise");
  assert(/meal photos are sent/i.test(s), "the prompt says meal photos are sent");
});

Deno.test("the camera prompt Drona Eyes needs is still there", () => {
  assert(String(expo.ios?.infoPlist?.NSCameraUsageDescription ?? "").length > 0);
  assert((expo.android?.permissions ?? []).includes("android.permission.CAMERA"));
});
