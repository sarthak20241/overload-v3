// The transcribe handler on this Mac, with a fake engine, for trying voice
// in a simulator or on a phone with no speech key and no deploy.
//
//   deno run -A scripts/voice-eval/dev-server.ts               # port 8790
//   SAVE_DIR=/tmp/clips deno run -A scripts/voice-eval/dev-server.ts   # keep each clip to inspect (ffprobe)
//
// Then start Metro with:
//   EXPO_PUBLIC_VOICE_DEV=1 EXPO_PUBLIC_VOICE_URL=http://localhost:8790 npx expo start
// (EXPO_PUBLIC_VOICE_DEV shows the mic on a dev client rebuilt from this
// app.json; both are ignored in a store build).
//
// Real: the multipart parse, the size, format and length caps, the access
// and rate-limit order, the vocabulary, the response shape. Fake: the JWT
// (any Bearer passes), access (free), the slot (always free), and the words
// (a fixed sentence per purpose, so a run shows the text landing in the box).

import { handleTranscribe } from "../../supabase/functions/transcribe/handler.ts";
import { fakeProvider } from "../../supabase/functions/transcribe/stt.ts";

const port = Number(Deno.env.get("PORT") ?? 8790);
const saveDir = Deno.env.get("SAVE_DIR");
const fake = fakeProvider({
  text: (clip, opts) =>
    opts.purpose === "food"
      ? `two roti and a katori of dal makhani (${clip.seconds.toFixed(1)} s heard)`
      : `How many sets of RDL should I do this week (${clip.seconds.toFixed(1)} s heard)`,
});

Deno.serve({ port }, (req) =>
  handleTranscribe(req, {
    verify: async (h) => (h?.startsWith("Bearer ") ? { sub: "dev" } : { error: "no token" }),
    access: async () => ({ state: "free" }),
    reserve: async () => ({ ok: true }),
    userFoods: async () => [],
    provider: {
      ...fake,
      transcribe: async (clip, opts) => {
        if (saveDir) {
          await Deno.mkdir(saveDir, { recursive: true });
          await Deno.writeFile(`${saveDir}/clip-${Date.now()}.${clip.format}`, clip.bytes);
        }
        return fake.transcribe(clip, opts);
      },
    },
    cleanup: null,
    log: (e) => console.log("[transcribe dev]", JSON.stringify(e)),
  }));
console.log(`transcribe dev server on http://localhost:${port} (fake engine)`);
