// Run with: deno test --allow-all lib/installReferrer.test.ts
//
// lib/installReferrer.ts has no imports, so Deno tests it directly. The raw
// strings are what Google Play's Install Referrer API hands back.

import { assertEquals } from "jsr:@std/assert@1";
import { afterReferrerFailure, installSourceProps, MAX_REFERRER_TRIES, parseInstallReferrer, referrerKeys, shouldReadReferrer } from "./installReferrer.ts";

Deno.test("a store search install is organic", () => {
  assertEquals(parseInstallReferrer("utm_source=google-play&utm_medium=organic"), {
    source: "google-play",
    medium: "organic",
    campaign: null,
    content: null,
    term: null,
    organic: true,
  });
});

Deno.test("a tagged website link carries its campaign", () => {
  const r = parseInstallReferrer("utm_source=chatgpt&utm_medium=cpc&utm_campaign=india_food&utm_content=ad1");
  assertEquals(r.source, "chatgpt");
  assertEquals(r.medium, "cpc");
  assertEquals(r.campaign, "india_food");
  assertEquals(r.content, "ad1");
  assertEquals(r.organic, false);
});

Deno.test("a referrer that is still URL-encoded is decoded once", () => {
  const r = parseInstallReferrer("utm_source%3Dinstagram%26utm_campaign%3Dtycoon_reel");
  assertEquals(r.source, "instagram");
  assertEquals(r.campaign, "tycoon_reel");
});

Deno.test("a Google Ads click with only a gclid reads as google / cpc", () => {
  const r = parseInstallReferrer("gclid=abc123");
  assertEquals(r.source, "google");
  assertEquals(r.medium, "cpc");
  assertEquals(r.organic, false);
});

Deno.test("an empty or junk referrer is unknown, not organic", () => {
  for (const raw of ["", "   ", "not a query"]) {
    const r = parseInstallReferrer(raw);
    assertEquals(r.source, null);
    assertEquals(r.organic, false);
  }
});

Deno.test("long values are cut so a bad link cannot flood PostHog", () => {
  const r = parseInstallReferrer("utm_source=" + "x".repeat(500));
  assertEquals(r.source?.length, 100);
});

Deno.test("person props: one flat set, nulls left out", () => {
  assertEquals(installSourceProps(parseInstallReferrer("utm_source=chatgpt&utm_medium=cpc")), {
    install_source: "chatgpt",
    install_medium: "cpc",
    install_organic: false,
  });
});

Deno.test("retry: a failed read is tried again on later opens, then given up", () => {
  assertEquals(shouldReadReferrer(null), true);
  assertEquals(shouldReadReferrer("1"), false); // already sent
  let stored: string | null = null;
  for (let i = 0; i < MAX_REFERRER_TRIES - 1; i++) {
    stored = afterReferrerFailure(stored);
    assertEquals(shouldReadReferrer(stored), true);
  }
  stored = afterReferrerFailure(stored);
  assertEquals(shouldReadReferrer(stored), false);
  // The old build's marker is not a reason to stop.
  assertEquals(shouldReadReferrer("error"), true);
});

Deno.test("only the parameter names of the raw referrer leave the phone", () => {
  assertEquals(referrerKeys("utm_source=x&utm_medium=y&secret=abc"), "secret,utm_medium,utm_source");
  assertEquals(referrerKeys(""), "");
});

Deno.test("lowercase percent escapes are decoded too", () => {
  const r = parseInstallReferrer("utm_source%3dinstagram%26utm_campaign%3dlaunch");
  assertEquals(r.source, "instagram");
  assertEquals(r.campaign, "launch");
});

Deno.test("organic means Play's own tag, not any organic medium", () => {
  assertEquals(parseInstallReferrer("utm_source=google&utm_medium=organic").organic, false);
  assertEquals(parseInstallReferrer("utm_source=google-play&utm_medium=organic").organic, true);
});

Deno.test("an encoded referrer still sends only parameter names", () => {
  assertEquals(referrerKeys("utm_source%3Dinstagram%26secret%3Dabc123"), "secret,utm_source");
  assertEquals(referrerKeys("utm_source%3dinstagram%26secret%3dabc123"), "secret,utm_source");
});

Deno.test("mixed encoding cannot smuggle a value into a key name", () => {
  // A literal "=" stops the one-time decode; the encoded part must not pass as a name.
  assertEquals(referrerKeys("utm_source%3Dinstagram%26secret%3Dabc123&x=1"), "x");
  assertEquals(referrerKeys("a%26b=1&utm_medium=cpc"), "utm_medium");
});
