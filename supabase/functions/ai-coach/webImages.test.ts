// Run with: deno test --allow-all supabase/functions/ai-coach/webImages.test.ts
//
// Precise reading a label off a page's pictures. The fixture is the live miss
// of 2026-10-18: "20g Too Yum protein masala oats". tooyumm.com was the right
// page, but its text carries only the ingredients; the nutrition table is
// Slide8, a picture. The network is faked at fetch, so these run the real
// Tavily client, the real Jev request shape and the real arithmetic.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { askJev } from "./jev.ts";
import { runTavilyLookup, soldNameFrom, type TavilyLookupDeps } from "./tavilyLookup.ts";
import { fetchImages, imageCandidates, inJevLimits, sniffImage } from "./webImages.ts";
import { type ParseMealDeps, superLookupOne } from "./parseMeal.ts";

// ── Image bytes: only the header matters to our code ────────────────────────

function png(w: number, h: number, animated = false): Uint8Array {
  const chunk = (type: string, len: number) => {
    const c = new Uint8Array(12 + len);
    new DataView(c.buffer).setUint32(0, len);
    c.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    return c;
  };
  const ihdr = chunk("IHDR", 13);
  new DataView(ihdr.buffer).setUint32(8, w);
  new DataView(ihdr.buffer).setUint32(12, h);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr];
  if (animated) parts.push(chunk("acTL", 8));
  parts.push(chunk("IDAT", 4));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function jpeg(w: number, h: number, sof = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, 2 bytes of payload
    0xff, sof, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

// ── Pure helpers ────────────────────────────────────────────────────────────

Deno.test("sniffImage reads PNG and baseline JPEG sizes from the header", () => {
  assertEquals(sniffImage(png(800, 600)), { format: "png", width: 800, height: 600 });
  assertEquals(sniffImage(jpeg(500, 400)), { format: "jpeg", width: 500, height: 400 });
});

Deno.test("sniffImage takes progressive JPEG: Amazon serves every product photo that way", () => {
  assertEquals(sniffImage(jpeg(500, 500, 0xc2)), { format: "jpeg", width: 500, height: 500 });
});

Deno.test("fetchImages retries a download cut off mid-way, once, and not a refusal", async () => {
  const tries: Record<string, number> = {};
  const fetchFn = (async (u: string) => {
    tries[u] = (tries[u] ?? 0) + 1;
    if (u.endsWith("/cut") && tries[u] === 1) throw new TypeError("terminated");
    if (u.endsWith("/gone")) return new Response("no", { status: 404 });
    return new Response(png(800, 800) as Uint8Array<ArrayBuffer>);
  }) as unknown as typeof fetch;
  const got = await fetchImages(["https://a/cut", "https://a/gone", "https://a/ok"], { fetchFn, timeoutMs: 1000 });
  assertEquals(got.map((g) => ("skip" in g ? g.skip : g.width)), [800, "http", 800]);
  assertEquals(tries, { "https://a/cut": 2, "https://a/gone": 1, "https://a/ok": 1 });
});

Deno.test("sniffImage refuses what Jev would reject the whole request for", () => {
  assertEquals(sniffImage(png(800, 800, true)), null); // animated PNG
  assertEquals(sniffImage(jpeg(800, 800, 0xc3)), null); // lossless JPEG
  assertEquals(sniffImage(new TextEncoder().encode("RIFF....WEBPVP8 ")), null);
});

Deno.test("inJevLimits is 280 to 1568 px per side", () => {
  assert(inJevLimits(800, 800));
  assert(inJevLimits(280, 280));
  assert(!inJevLimits(1000, 279));
  assert(!inJevLimits(1946, 1946));
});

Deno.test("imageCandidates sizes Shopify and Amazon images and drops site furniture", () => {
  const got = imageCandidates([
    "http://tooyumm.com/cdn/shop/files/Slide1_ab.png?v=1",
    "https://tooyumm.com/cdn/shop/files/loader.png?v=1&width=100",
    "https://tooyumm.com/cdn/shop/files/Slide1_ab.png?v=1&width=1946",
    "https://tooyumm.com/cdn/shop/files/Slide8_cd.png?v=1&width=1000",
    "https://cdn.shopify.com/s/files/1/0792/files/payment-icons.svg?v=1",
    "https://m.media-amazon.com/images/G/31/gno/sprites/nav-sprite-global-1x._CB5_.png",
    "https://m.media-amazon.com/images/I/41fQ3j3ypJL._SX38_SY50_CR,0,0,38,50_.jpg",
    "https://m.media-amazon.com/images/I/41fQ3j3ypJL._SY300_SX300_QL70_ML2_.jpg",
    "https://m.media-amazon.com/images/I/51TUNR6MM9L._SX38_SY50_CR,0,0,38,50_.jpg",
  ]);
  assertEquals(got, [
    "https://tooyumm.com/cdn/shop/files/Slide1_ab.png?v=1&width=800",
    "https://tooyumm.com/cdn/shop/files/Slide8_cd.png?v=1&width=800",
    "https://m.media-amazon.com/images/I/41fQ3j3ypJL._SL1000_.jpg",
    "https://m.media-amazon.com/images/I/51TUNR6MM9L._SL1000_.jpg",
  ]);
});

Deno.test("imageCandidates counts a Cloudflare resize as the same picture", () => {
  assertEquals(imageCandidates([
    "https://cdn.grofers.com/da/cms-assets/cms/product/3b40.jpg",
    "https://cdn.grofers.com/cdn-cgi/image/f=auto,fit=scale-down,q=85,w=480,h=480/da/cms-assets/cms/product/3b40.jpg",
  ]), ["https://cdn.grofers.com/da/cms-assets/cms/product/3b40.jpg"]);
});

Deno.test("soldNameFrom takes only a name the page title prints", () => {
  const title = "High Protein Super Oats Masala - Too Yumm!";
  assertEquals(soldNameFrom("Too Yumm! High Protein Super Oats Masala", title), "Too Yumm! High Protein Super Oats Masala");
  // A word the title does not have is a name the model wrote, not copied.
  assertEquals(soldNameFrom("Too Yumm High Protein Super Oats Masala (estimate)", title), null);
  assertEquals(soldNameFrom(null, title), null);
});

// ── Jev with images ─────────────────────────────────────────────────────────

Deno.test("Jev refuses image assets while images are off, without a request", async () => {
  let calls = 0;
  const fetchFn = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  const res = await askJev({ x: "a" }, {}, { apiKey: "k", timeoutMs: 100, fetchFn }, { a: { data_base64: "AA==", format: "png" } });
  assertEquals(res.ok, false);
  assertEquals(!res.ok && res.failure, "images_off");
  assertEquals(calls, 0);
});

Deno.test("Jev with images on sends the assets and the danger-zone header", async () => {
  let seen: { headers: Record<string, string>; body: any } | null = null;
  const fetchFn = (async (_u: string, init: RequestInit) => {
    seen = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    return Response.json({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as unknown as typeof fetch;
  await askJev({ img: "ref-a" }, {}, { apiKey: "k", timeoutMs: 100, fetchFn, images: true }, {
    "ref-a": { data_base64: "AA==", format: "png" },
  });
  assertEquals(seen!.headers["TypeSafe-Danger-Zone-Images"], "true");
  assertEquals(seen!.body.assets, { "ref-a": { type: "image", data_base64: "AA==", format: "png" } });
});

Deno.test("Jev without images sends neither", async () => {
  let seen: { headers: Record<string, string>; body: any } | null = null;
  const fetchFn = (async (_u: string, init: RequestInit) => {
    seen = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    return Response.json({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as unknown as typeof fetch;
  await askJev({ a: 1 }, {}, { apiKey: "k", timeoutMs: 100, fetchFn, images: true });
  assertEquals(seen!.headers["TypeSafe-Danger-Zone-Images"], undefined);
  assertEquals("assets" in seen!.body, false);
});

// ── The live miss, replayed ─────────────────────────────────────────────────

const PAGE_URL = "https://tooyumm.com/products/high-protein-super-oats-masala-1";
const LABEL = "https://tooyumm.com/cdn/shop/files/Slide8_10da3b09.png?v=1775800076&width=1000";
// The page's own text: name, price, ingredients. Not one nutrition number.
const PAGE_TEXT = "Too Yumm High Protein Super Oats Masala MRP: Regular price Rs. 199.00 Too Yumm! High Protein " +
  "Super Oats infused with familiar desi Masala flavour is a power-packed savoury oats meal with 22g protein. " +
  "Rolled Oats (54%), Mixed Spices and Herbs, Hydrolyzed Vegetable Protein, Textured Soya Protein (17%), " +
  "Edible Vegetable Oil (Rice Bran Oil), Jowar Flakes (2%), Bajra Flakes (2%), Chia Seeds (2%).";
const RESULT = {
  title: "High Protein Super Oats Masala - Too Yumm!",
  url: PAGE_URL,
  content: "Too Yumm! High Protein Super Oats infused with familiar desi Masala flavour ... 22g protein.",
  score: 0.86,
  raw_content: PAGE_TEXT,
};
const OATS = { name: "protein masala oats", brand: "Too Yum" };
// Slide8 as printed: per 100 g 366 kcal, protein 22.2, carbs 54, fat 6.9, fibre 12.2.
const LABEL_REPORT = {
  page_id: "", same_food: true, basis: "per_100g", serving_grams: 50, serving_label: "1 serve (50 g)",
  kcal: 366, protein_g: 22.2, carb_g: 54, fat_g: 6.9, fiber_g: 12.2, brand: "Too Yumm!",
  product_name: "Too Yumm! High Protein Super Oats Masala",
};

interface Seen {
  extractImages: number;
  jevImageCalls: number;
  imageFetches: string[];
  textReads: number;
  imageReads: number;
  /** Images the picture reader was shown. */
  readImages: number;
}

function net(opts: { jevImageStatus?: number; labelP?: number }, seen: Seen): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.includes("api.tavily.com/search")) return Response.json({ results: [RESULT] });
    if (u.includes("api.tavily.com/extract")) {
      if (body.include_images) seen.extractImages++;
      return Response.json({
        results: [{
          url: PAGE_URL,
          raw_content: PAGE_TEXT,
          images: [
            "https://tooyumm.com/cdn/shop/files/logo.png?v=1",
            "https://tooyumm.com/cdn/shop/files/Slide1_80154db3.png?v=1775800039&width=1000",
            LABEL,
          ],
        }],
      });
    }
    if (u.includes("typesafe.ai")) {
      if (body.assets) {
        seen.jevImageCalls++;
        if (opts.jevImageStatus) return new Response("rejected", { status: opts.jevImageStatus });
        // The label is the picture whose state entry points at Slide8's asset.
        const answers: Record<string, unknown> = {};
        for (const id of Object.keys(body.questions)) {
          const isLabel = seen.imageFetches.indexOf(seen.imageFetches.find((f) => f.includes("Slide8"))!) ===
            Number(id.slice(1)) - 1;
          answers[id] = { type: "noul", noul: isLabel ? (opts.labelP ?? 0.99) : 0.02 };
        }
        return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 2800, output_tokens: 40 } });
      }
      // Text looks: the page is this food, and no piece of its text is a panel.
      const answers: Record<string, unknown> = {};
      for (const r of body.state.results) {
        answers[r.id] = { type: "noul", noul: 0.95 };
        if (body.questions[`${r.id}_piece`]) {
          answers[`${r.id}_piece`] = { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 0.9 } };
        }
      }
      return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (u.includes("tooyumm.com/cdn/shop")) {
      seen.imageFetches.push(u);
      return new Response(png(800, 800) as Uint8Array<ArrayBuffer>);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

function pictureReader(seen: Seen) {
  return async (payload: Record<string, any>) => {
    const tool = payload.tools[0].name;
    const content = payload.messages[0].content;
    if (tool === "report_label_pictures") {
      seen.imageReads++;
      const images = content.filter((b: { type: string }) => b.type === "image");
      seen.readImages += images.length;
      const msg = JSON.parse(content[0].text);
      return {
        content: [{
          type: "tool_use",
          name: tool,
          input: { pages: msg.pictures.map((p: { page_id: string }) => ({ ...LABEL_REPORT, page_id: p.page_id })) },
        }],
      };
    }
    seen.textReads++;
    return null;
  };
}

const newSeen = (): Seen => ({ extractImages: 0, jevImageCalls: 0, imageFetches: [], textReads: 0, imageReads: 0, readImages: 0 });

function deps(fetchFn: typeof fetch, seen: Seen, images: boolean): TavilyLookupDeps {
  return {
    tavily: { apiKey: "tvly-test", timeoutMs: 1000, fetchFn },
    jev: { apiKey: "jev-test", timeoutMs: 1000, fetchFn },
    images: images ? { fetchFn, timeoutMs: 1000, jevTimeoutMs: 1000 } : null,
    country: "india",
    model: "m",
    callModel: pictureReader(seen),
  };
}

Deno.test("the live miss: an image-only label page gives a web reading per 100 g", async () => {
  const seen = newSeen();
  const out = await runTavilyLookup(deps(net({}, seen), seen, true), OATS);
  assertEquals(out.unavailable, false);
  assertEquals(out.finding?.readings.map((r) => r.per_100), [
    { kcal: 366, protein_g: 22.2, carb_g: 54, fat_g: 6.9, fiber_g: 12.2 },
  ]);
  assertEquals(out.finding?.readings[0].ref, PAGE_URL);
  assertEquals(out.finding?.sold_name, "Too Yumm! High Protein Super Oats Masala");
  assertEquals(out.finding?.serving_grams, 50);
  // The logo never reaches Jev; only the label reaches the reader.
  assertEquals(seen.imageFetches.length, 2);
  assertEquals(seen.readImages, 1);
  assert(out.steps.some((s) => s.tool === "web_images"));
});

Deno.test("images off (the default): the same page is still a miss, and no picture is fetched", async () => {
  const seen = newSeen();
  const out = await runTavilyLookup(deps(net({}, seen), seen, false), OATS);
  assertEquals(out.finding, null);
  assertEquals(seen.extractImages, 0);
  assertEquals(seen.imageFetches.length, 0);
  assertEquals(seen.jevImageCalls, 0);
});

Deno.test("a Jev image error falls back cleanly: no web row, no reader, the same miss as before", async () => {
  for (const status of [400, 413, 500]) {
    const seen = newSeen();
    const out = await runTavilyLookup(deps(net({ jevImageStatus: status }, seen), seen, true), OATS);
    assertEquals(out.unavailable, false, `status ${status}`);
    assertEquals(out.finding, null, `status ${status}`);
    assertEquals(out.searchedNoLabel, true, `status ${status}`);
    assertEquals(seen.imageReads, 0, `status ${status}`);
    assert(seen.jevImageCalls > 0);
    const step = out.steps.find((s) => s.tool === "web_images");
    assert((step?.result as { failure?: string }).failure, `status ${status}`);
  }
});

Deno.test("a label picture Jev is unsure of is not read", async () => {
  const seen = newSeen();
  // The pack back, where the table is a corner of the photo, measured 0.31-0.45.
  const out = await runTavilyLookup(deps(net({ labelP: 0.45 }, seen), seen, true), OATS);
  assertEquals(out.finding, null);
  assertEquals(seen.imageReads, 0);
});

Deno.test("Precise: the picture reading becomes a normal web candidate under the sold name, the user's words an alias", async () => {
  const seen = newSeen();
  const fetchFn = net({}, seen);
  const reader = pictureReader(seen);
  const rows: Array<{ cache_key: string; display_name: string; kcal: number; evidence: unknown[] }> = [];
  const aliases: Array<[string, string]> = [];
  const anthropic = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("anthropic")) return fetchFn(url, init);
    const data = await reader(JSON.parse(String(init?.body)));
    return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 1500, output_tokens: 90 }, ...(data ?? { content: [] }) });
  }) as typeof fetch;
  const d: ParseMealDeps = {
    anthropicApiKey: "k", model: "m", maxTokens: 100, timeoutMs: 1000, webSearchEnabled: true,
    searchFoods: async () => [], backfillOffFood: async () => null, getFoodPer100: async () => null,
    fetchFn: anthropic,
    webLookup: "tavily",
    tavily: { apiKey: "tvly-test", timeoutMs: 1000, fetchFn },
    jev: { apiKey: "jev-test", timeoutMs: 1000, fetchFn },
    webImages: { fetchFn, timeoutMs: 1000, jevTimeoutMs: 1000 },
    searchCountry: "india",
    preciseCachePut: async (row: any) => { rows.push(row); return "row-1"; },
    preciseAliasPut: async (key: string, id: string) => { aliases.push([key, id]); },
  } as ParseMealDeps;
  const item = { name: "protein masala oats", brand: "Too Yum", quantity: 20, unit: "g" } as never;
  const cand = await superLookupOne(d, item, () => {}, () => {});
  assertEquals(cand?.name, "Too Yumm! High Protein Super Oats Masala");
  assertEquals(cand?.kcal, 366);
  assertEquals(cand?.protein_g, 22.2);
  assert(cand?.food_id?.includes("web_"));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].display_name, "Too Yumm! High Protein Super Oats Masala");
  assertEquals(rows[0].cache_key !== "too yum protein masala oats", true);
  // The user's own words point at the row saved under the sold name.
  assertEquals(aliases.length, 1);
  assertEquals(aliases[0][1], "row-1");
});
