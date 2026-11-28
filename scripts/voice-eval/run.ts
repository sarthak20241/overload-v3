// Speech engine comparison on the owner's own clips: Hinglish, Indian English,
// food names. Scores each engine with score.ts and prints cost.
//
//   deno run -A scripts/voice-eval/run.ts                     # dry run: lists clips, prints the cost, calls nothing
//   SPEND=1 OPENAI_API_KEY=sk-... deno run -A scripts/voice-eval/run.ts
//   ENGINES=gemini SPEND=1 GEMINI_API_KEY=... deno run -A scripts/voice-eval/run.ts   # free on a free-tier key
//   ENGINES=openai,fake ONLY=dal-1,poha-2 SPEND=1 deno run -A scripts/voice-eval/run.ts
//   STT_LANGUAGES=en,hi SPEND=1 ... deno run -A scripts/voice-eval/run.ts   # language hints, as the function's secret
//
// Clips: scripts/voice-eval/clips/ holds the audio (m4a or wav, recorded on a
// phone, under a minute) and cases.json:
//   [{ "id": "dal-1", "file": "dal-1.m4a", "purpose": "food",
//      "said": "do roti aur ek katori dal makhani", "must_have": ["roti", "dal makhani"],
//      "tags": ["hinglish"] }]
// The clips folder is git-ignored: recordings of a voice stay on this Mac.
//
// Billing: no Anthropic call is made. Each engine bills by its own key, per
// audio minute (gpt-transcribe $0.0045/min, gemini-3.5-transcribe $0.003/min
// paid or free on a free-tier key, on 2026-11-28). Nothing is sent
// without SPEND=1; the dry run prints what the run would cost first.
//
// Engines: `gemini` and `openai` (the function's providers, unchanged) and `fake` (a
// floor that echoes nothing, to check the harness). Deepgram Nova-3, Sarvam
// Saaras v3 and Groq whisper-large-v3-turbo go in as SttProvider objects in
// supabase/functions/transcribe/stt.ts once their request shapes are checked
// against their live docs, then show up here by name.

import { inspectAudio } from "../../supabase/functions/transcribe/audio.ts";
import { fakeProvider, geminiProvider, openAiProvider, type SttProvider } from "../../supabase/functions/transcribe/stt.ts";
import { buildVocabulary, contextFor } from "../../supabase/functions/transcribe/vocabulary.ts";
import { costUsd, scoreClip } from "./score.ts";

interface Case {
  id: string;
  file: string;
  purpose: "food" | "chat";
  said: string;
  must_have?: string[];
  tags?: string[];
}

// Paid rates. Gemini on a free-tier key costs nothing (and Google may use the
// clips to improve its products: use your own voice, not users').
const PRICE_PER_MIN: Record<string, number> = { openai: 0.0045, gemini: 0.003, fake: 0 };
const dir = new URL("./clips/", import.meta.url);

let cases: Case[];
try {
  cases = JSON.parse(await Deno.readTextFile(new URL("cases.json", dir)));
} catch {
  console.log("No clips yet. Put the recordings and cases.json in scripts/voice-eval/clips/ (format at the top of this file).");
  Deno.exit(2);
}
const only = (Deno.env.get("ONLY") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (only.length) cases = cases.filter((c) => only.includes(c.id));

const engines = (Deno.env.get("ENGINES") ?? "openai").split(",").map((s) => s.trim()).filter(Boolean);
const languages = (Deno.env.get("STT_LANGUAGES") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const spend = Deno.env.get("SPEND") === "1";

const clips = [];
for (const c of cases) {
  const bytes = new Uint8Array(await Deno.readFile(new URL(c.file, dir)));
  const a = inspectAudio(bytes);
  if (!a.ok) {
    console.log(`${c.id}: not an m4a or wav, skipped`);
    continue;
  }
  clips.push({ c, clip: { bytes, format: a.format, seconds: a.seconds } });
}
const totalS = clips.reduce((n, x) => n + x.clip.seconds, 0);

console.log(`${clips.length} clips, ${totalS.toFixed(1)} s of audio. Engines: ${engines.join(", ")}.`);
for (const e of engines) {
  const price = PRICE_PER_MIN[e];
  console.log(`  ${e}: ${price === undefined ? "unknown price" : `$${costUsd(totalS, price).toFixed(4)} at $${price}/min, billed to that engine's own key`}`);
}
if (!spend) {
  console.log("Dry run. Nothing was sent. Run again with SPEND=1 to call the engines.");
  Deno.exit(0);
}

function engine(name: string): SttProvider | null {
  if (name === "fake") return fakeProvider({ text: "" });
  if (name === "openai") {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      console.log("openai: OPENAI_API_KEY is not set, skipped");
      return null;
    }
    return openAiProvider({ apiKey, languages });
  }
  if (name === "gemini") {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      console.log("gemini: GEMINI_API_KEY is not set, skipped");
      return null;
    }
    return geminiProvider({ apiKey, languages });
  }
  console.log(`${name}: no provider written yet, skipped`);
  return null;
}

for (const name of engines) {
  const p = engine(name);
  if (!p) continue;
  console.log(`\n== ${name} (billing: ${name === "fake" ? "none" : `${name} API key, per audio minute`})`);
  const rows: { id: string; tags: string; wer: number; recall: number; latin: boolean; ms: number }[] = [];
  for (const { c, clip } of clips) {
    const t0 = Date.now();
    const out = await p.transcribe(clip, {
      purpose: c.purpose,
      vocabulary: buildVocabulary([], c.purpose),
      context: contextFor(c.purpose),
    });
    const ms = Date.now() - t0;
    if (!out.ok) {
      console.log(`  ${c.id}: failed (${out.reason})`);
      continue;
    }
    const s = scoreClip(c.said, c.must_have ?? [], out.text);
    rows.push({ id: c.id, tags: (c.tags ?? []).join(","), wer: s.wer, recall: s.term_recall, latin: s.latin, ms });
    console.log(`  ${c.id.padEnd(16)} wer ${s.wer.toFixed(2)}  terms ${(s.term_recall * 100).toFixed(0)}%  ${s.latin ? "latin" : "DEVANAGARI"}  ${ms} ms\n    said:  ${c.said}\n    heard: ${out.text}`);
  }
  if (rows.length) {
    const avg = (f: (r: typeof rows[number]) => number) => rows.reduce((n, r) => n + f(r), 0) / rows.length;
    console.log(`  -- ${rows.length} clips: mean wer ${avg((r) => r.wer).toFixed(3)}, term recall ${(avg((r) => r.recall) * 100).toFixed(0)}%, latin ${rows.filter((r) => r.latin).length}/${rows.length}`);
    // Latency here is from this Mac, not the edge function: compare engines
    // with it, never quote it as the app's speed.
  }
}
