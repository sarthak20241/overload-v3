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

Deno.test("the camera prompt Drona Eyes needs is still there", () => {
  assert(String(expo.ios?.infoPlist?.NSCameraUsageDescription ?? "").length > 0);
  assert((expo.android?.permissions ?? []).includes("android.permission.CAMERA"));
});

// Voice input (food box, Drona chat) records with expo-audio. Its plugin adds
// the iOS mic string and Android RECORD_AUDIO from these options, and the
// app's own NSMicrophoneUsageDescription must say what the audio is for.
// Without the iOS string, the app is ended the moment it asks for the mic.
Deno.test("voice: the microphone is declared on both platforms, with an honest iOS string", () => {
  const audio = (expo.plugins ?? []).find((p: unknown) => Array.isArray(p) && p[0] === "expo-audio");
  assert(audio, "expo-audio plugin is missing");
  const opts = (audio as [string, Record<string, unknown>])[1] ?? {};
  assertEquals(opts.recordAudioAndroid, true);
  assert(typeof opts.microphonePermission === "string" && opts.microphonePermission.length > 0, "expo-audio microphonePermission is off");
  const plist = String(expo.ios?.infoPlist?.NSMicrophoneUsageDescription ?? "");
  assertEquals(plist, opts.microphonePermission, "two different mic strings would race in Info.plist");
  // Says when it listens, what for, and what happens to the audio.
  assert(/food/i.test(plist) && /Drona/.test(plist), "the string must name the food log and Drona");
  assert(/not keep|doesn't keep|does not keep/i.test(plist), "the string must say the recording is not kept");
  assert(!plist.includes("—"), "no em dashes");
  assert((expo.android?.permissions ?? []).includes("android.permission.RECORD_AUDIO"));
  assert(!(expo.android?.blockedPermissions ?? []).includes("android.permission.RECORD_AUDIO"), "RECORD_AUDIO is still blocked");
});

Deno.test("voice: no background audio and no media playback service came with the mic", () => {
  const blocked: string[] = expo.android?.blockedPermissions ?? [];
  assert(blocked.includes("android.permission.FOREGROUND_SERVICE"));
  assert(blocked.includes("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"));
  const modes: string[] = expo.ios?.infoPlist?.UIBackgroundModes ?? [];
  assert(!modes.includes("audio"), "recording never runs in the background");
});
