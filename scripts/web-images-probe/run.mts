// Cost and latency of Precise's label-picture read, per lookup, on the API
// (never the CLI: CLI timings measure the CLI). Runs the real Tavily + Jev
// lookup on one branded line with pictures off, then on, and prices both.
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/web-images-probe/run.mts ["20g Too Yum protein masala oats" name brand]
//
// Reads TAVILY_API_KEY and JEV_API_KEY from env or .env.local. Prices:
// Haiku 5.5 $0.10/$0.50 per M, Jev $0.042/M input, Tavily $0.008/credit.

import { readFileSync } from "node:fs";
import { runTavilyLookup } from "../../supabase/functions/ai-coach/tavilyLookup.ts";

const dot: Record<string, string> = {};
try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) dot[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* env only */ }
const env = (k: string) => process.env[k] ?? dot[k] ?? "";
const KEY = env("ANTHROPIC_API_KEY");
if (!KEY) throw new Error("ANTHROPIC_API_KEY is required: this measures the API, not the CLI");
const MODEL = "claude-haiku-5-5";
const name = process.argv[2] ?? "protein masala oats";
const brand = process.argv[3] ?? "Too Yum";
const RUNS = Number(env("RUNS") || "3");

async function once(images: boolean) {
  let inTok = 0, outTok = 0, jevTok = 0, imgReadMs = 0, imgReadIn = 0;
  const timed: Record<string, number> = {};
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const t = Date.now();
    try { return await fetch(url, init); } finally {
      const k = url.includes("tavily.com/extract") ? (String(init?.body).includes("include_images") ? "extract_images" : "extract")
        : url.includes("tavily") ? "search" : url.includes("typesafe") ? (String(init?.body).includes("\"assets\"") ? "jev_images" : "jev_text")
        : "image_download";
      // Downloads run in parallel: keep the longest, not the sum.
      timed[k] = k === "image_download" ? Math.max(timed[k] ?? 0, Date.now() - t) : (timed[k] ?? 0) + Date.now() - t;
    }
  }) as typeof fetch;
  const started = Date.now();
  const out = await runTavilyLookup({
    tavily: { apiKey: env("TAVILY_API_KEY"), timeoutMs: 20_000, fetchFn },
    jev: { apiKey: env("JEV_API_KEY"), timeoutMs: 5000, fetchFn, onUsage: (u) => { jevTok += u.input_tokens; } },
    images: images ? { fetchFn, timeoutMs: 6000, jevTimeoutMs: 15_000 } : null,
    country: "india",
    model: MODEL,
    callModel: async (payload) => {
      const t = Date.now();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { console.log("anthropic", res.status, JSON.stringify(data).slice(0, 200)); return null; }
      inTok += data.usage?.input_tokens ?? 0;
      outTok += data.usage?.output_tokens ?? 0;
      if ((payload.tools as Array<{ name: string }>)[0].name === "report_label_pictures") {
        imgReadMs += Date.now() - t;
        imgReadIn += data.usage?.input_tokens ?? 0;
      }
      return data;
    },
  }, { name, brand, eaten: `20 g ${brand} ${name}` });
  const ms = Date.now() - started;
  const usd = (inTok * 0.1 + outTok * 0.5) / 1e6 + jevTok * 0.042 / 1e6 + out.credits * 0.008;
  const img = out.steps.find((s) => s.tool === "web_images");
  return { ms, usd, credits: out.credits, inTok, outTok, jevTok, imgReadMs, imgReadIn, timed, found: out.finding?.readings.map((r) => [r.ref, r.per_100]), sold: out.finding?.sold_name ?? null, img: img?.result };
}

for (const images of [false, true]) {
  for (let i = 0; i < RUNS; i++) {
    const r = await once(images);
    console.log(JSON.stringify({ images, ...r }));
  }
}
