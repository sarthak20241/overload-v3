// Voice input in the app: the parts with rules, none of the native parts.
//
//   deno test --allow-all lib/voiceInput.test.ts
//
// What it pins: what was said lands after what was typed and never replaces
// it; the mic asks with our words first, asks again only when the phone lets
// it, and sends a "never" to Settings; the mic shows only on a binary that
// declares it; the recording asks for small mono AAC; a server answer
// becomes the right words for the user; the meter maps to a 0..1 level; and
// a Drona reply is read aloud without its tables, charts or markdown.

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  insertTranscript,
  levelFromMetering,
  MAX_CLIP_MS,
  MIC_COPY,
  micStep,
  transcribeOutcome,
  VOICE_FROM_VERSION,
  VOICE_RECORDING,
  voiceSupported,
} from "./voiceInput.ts";
import { speakableText } from "./voiceSpeech.ts";
import { MAX_AUDIO_SECONDS } from "../supabase/functions/transcribe/audio.ts";

Deno.test("transcript: fills an empty box", () => {
  assertEquals(insertTranscript("", "two roti and dal"), "two roti and dal");
  assertEquals(insertTranscript("   ", " two roti "), "two roti");
});

Deno.test("transcript: goes after typed text, never over it", () => {
  assertEquals(insertTranscript("2 eggs", "and a banana"), "2 eggs and a banana");
  assertEquals(insertTranscript("2 eggs ", "and a banana"), "2 eggs and a banana");
  assertEquals(insertTranscript("Breakfast:\n", "poha"), "Breakfast:\npoha");
  assertEquals(insertTranscript("what about creatine?", "Is it safe"), "what about creatine? Is it safe");
});

Deno.test("transcript: nothing heard changes nothing", () => {
  assertEquals(insertTranscript("2 eggs", ""), "2 eggs");
  assertEquals(insertTranscript("2 eggs", "   "), "2 eggs");
});

Deno.test("transcript: typing while the clip uploads is kept (applied to the latest text)", () => {
  // The screens call setText((prev) => insertTranscript(prev, said)), so the
  // text the user typed during the upload is what the transcript joins.
  let box = "2 eggs";
  const typedDuringUpload = (prev: string) => prev + " and toast";
  box = typedDuringUpload(box);
  box = insertTranscript(box, "with chai");
  assertEquals(box, "2 eggs and toast with chai");
});

Deno.test("transcript: the box limit is respected without cutting typed text", () => {
  const typed = "x".repeat(490);
  const out = insertTranscript(typed, "one two three four five", 500);
  assert(out.startsWith(typed));
  assert(out.length <= 500);
  assertEquals(insertTranscript("x".repeat(500), "more", 500), "x".repeat(500));
});

Deno.test("permission: first tap explains, then the phone asks", () => {
  assertEquals(micStep({ granted: false, canAskAgain: true, status: "undetermined" }), "explain");
  assertEquals(micStep({ granted: true, canAskAgain: true, status: "granted" }), "record");
});

Deno.test("permission: a no the phone can ask again is asked again; a never goes to Settings", () => {
  assertEquals(micStep({ granted: false, canAskAgain: true, status: "denied" }), "explain");
  assertEquals(micStep({ granted: false, canAskAgain: false, status: "denied" }), "settings");
});

Deno.test("permission: no recorder on this phone is no mic", () => {
  assertEquals(micStep(null), "unavailable");
});

Deno.test("binary: the mic shows only on a build that declares the microphone", () => {
  assertEquals(VOICE_FROM_VERSION, [1, 0, 6]);
  assertFalse(voiceSupported({ nativeVersion: "1.0.5", platform: "ios", isDev: false, devFlag: false }));
  assert(voiceSupported({ nativeVersion: "1.0.6", platform: "ios", isDev: false, devFlag: false }));
  assert(voiceSupported({ nativeVersion: "1.1.0", platform: "android", isDev: false, devFlag: false }));
  assert(voiceSupported({ nativeVersion: "2.0", platform: "ios", isDev: false, devFlag: false }));
  assertFalse(voiceSupported({ nativeVersion: null, platform: "ios", isDev: false, devFlag: false }));
  assertFalse(voiceSupported({ nativeVersion: "1.0.6", platform: "web", isDev: false, devFlag: false }));
  // A dev client rebuilt from this app.json opts in with the env flag. The
  // flag does nothing in a store build.
  assert(voiceSupported({ nativeVersion: "1.0.5", platform: "ios", isDev: true, devFlag: true }));
  assertFalse(voiceSupported({ nativeVersion: "1.0.5", platform: "ios", isDev: false, devFlag: true }));
});

Deno.test("binary: app.json, once at the voice version, declares the microphone", async () => {
  const app = JSON.parse(await Deno.readTextFile(new URL("../app.json", import.meta.url))).expo;
  const v = String(app.version).split(".").map(Number);
  const atVoice = VOICE_FROM_VERSION.every((n, i) => (v[i] ?? 0) === n) ||
    VOICE_FROM_VERSION.some((n, i) => (v[i] ?? 0) > n && VOICE_FROM_VERSION.slice(0, i).every((m, j) => (v[j] ?? 0) === m));
  if (!atVoice) return; // the app.json version bump is the release PR's job
  assert(String(app.ios?.infoPlist?.NSMicrophoneUsageDescription ?? "").length > 0);
  assert((app.android?.permissions ?? []).includes("android.permission.RECORD_AUDIO"));
});

Deno.test("recording: small mono AAC in an m4a, capped at a minute", () => {
  assertEquals(MAX_CLIP_MS, 60_000);
  assertEquals(VOICE_RECORDING.extension, ".m4a");
  assertEquals(VOICE_RECORDING.sampleRate, 16000);
  assertEquals(VOICE_RECORDING.numberOfChannels, 1);
  assertEquals(VOICE_RECORDING.bitRate, 32000);
  assertEquals(VOICE_RECORDING.android.outputFormat, "mpeg4");
  assertEquals(VOICE_RECORDING.android.audioEncoder, "aac");
  assertEquals(VOICE_RECORDING.ios.outputFormat, "aac ");
  assert(VOICE_RECORDING.isMeteringEnabled);
  // 60 s at 32 kbps is 240 KB: under the server's 1 MB cap with room.
  assert((VOICE_RECORDING.bitRate / 8) * (MAX_CLIP_MS / 1000) < 1_000_000 / 2);
});

Deno.test("recording: the app stops well inside the server's length cap", () => {
  // The app checks its length on a 100 ms poll, so a clip can run a little
  // past MAX_CLIP_MS. The server must allow at least a second more.
  assert(MAX_CLIP_MS + 1000 <= MAX_AUDIO_SECONDS * 1000, `${MAX_CLIP_MS} ms vs ${MAX_AUDIO_SECONDS} s`);
});

Deno.test("server answers: text, or the words to show", () => {
  assertEquals(transcribeOutcome(200, { text: "two roti" }), { ok: true, text: "two roti" });
  const empty = transcribeOutcome(200, { text: "" });
  assertFalse(empty.ok);
  if (!empty.ok) assertEquals(empty.kind, "nothing_heard");
  const cases: [number, Record<string, unknown> | null, string][] = [
    [422, { error: "too_short" }, "nothing_heard"],
    [413, { error: "too_long" }, "too_long"],
    [429, { error: "voice_rate_limited", retry_after_seconds: 90 }, "rate_limited"],
    [402, { error: "pro_required", plan: "connect" }, "no_access"],
    [402, { error: "drona_access_required" }, "no_access"],
    [503, { error: "not_configured" }, "unavailable"],
    [502, { error: "stt_failed" }, "failed"],
    [500, null, "failed"],
    [0, null, "offline"],
  ];
  for (const [status, body, kind] of cases) {
    const r = transcribeOutcome(status, body);
    assertFalse(r.ok, `${status}`);
    if (!r.ok) {
      assertEquals(r.kind, kind, `${status} ${JSON.stringify(body)}`);
      assert(r.message.length > 0);
      assertFalse(r.message.includes("—"), "no em dashes in user copy");
    }
  }
  const rl = transcribeOutcome(429, { retry_after_seconds: 90 });
  if (!rl.ok) assert(rl.message.includes("2 min"), rl.message);
});

Deno.test("mic copy: says what leaves the phone, and no em dashes", () => {
  // The clip, and for food logs the names of foods the user logs (sent as
  // spelling hints), go to the speech service. Nothing is kept by Overload.
  assert(/clip/i.test(MIC_COPY.explainBody));
  assert(/food names|names of (the )?foods/i.test(MIC_COPY.explainBody), MIC_COPY.explainBody);
  assert(/don't keep|do not keep/i.test(MIC_COPY.explainBody));
  for (const v of Object.values(MIC_COPY)) assertFalse(v.includes("\u2014"));
});

Deno.test("meter: quiet is 0, loud is 1, missing is 0", () => {
  assertEquals(levelFromMetering(undefined), 0);
  assertEquals(levelFromMetering(-160), 0);
  assertEquals(levelFromMetering(-55), 0);
  assertEquals(levelFromMetering(0), 1);
  const mid = levelFromMetering(-30);
  assert(mid > 0.3 && mid < 0.8, `${mid}`);
});

Deno.test("read aloud: markdown and Drona's blocks are not read out", () => {
  const md = [
    "## Your week",
    "You trained **4 times** and hit _most_ of your protein.",
    "",
    "| Day | kcal |",
    "|-----|------|",
    "| Mon | 2100 |",
    "",
    "```chart",
    '{"type":"bar"}',
    "```",
    "- Keep the deload on Friday",
    "- See [the guide](https://example.com) and `RPE 8`",
  ].join("\n");
  const said = speakableText(md);
  assertEquals(
    said,
    "Your week. You trained 4 times and hit most of your protein. Keep the deload on Friday. See the guide and RPE 8.",
  );
});

Deno.test("read aloud: long replies stop at a sentence, not mid-word", () => {
  const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const said = speakableText(long, 300);
  assert(said.length <= 300);
  assert(said.endsWith("."));
  assertEquals(speakableText("   "), "");
});
