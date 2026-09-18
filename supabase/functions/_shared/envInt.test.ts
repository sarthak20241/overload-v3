import { assertEquals } from "jsr:@std/assert@1";
import { envInt } from "./envInt.ts";

/** Env stub + captured warnings, so no test touches the real environment. */
function harness(env: Record<string, string>) {
  const warnings: string[] = [];
  return {
    warnings,
    read: (name: string, fallback: number, allowZero = false) =>
      envInt(name, fallback, {
        allowZero,
        getEnv: (n) => env[n],
        warn: (m) => warnings.push(m),
      }),
  };
}

Deno.test("an unset var uses the compiled-in default, silently", () => {
  const h = harness({});
  assertEquals(h.read("ANTHROPIC_TIMEOUT_MS", 80000), 80000);
  // The normal case on every deploy that sets no secrets — it must not log.
  assertEquals(h.warnings.length, 0);
});

Deno.test("a valid override wins over the default", () => {
  const h = harness({ ANTHROPIC_TIMEOUT_MS: "120000" });
  assertEquals(h.read("ANTHROPIC_TIMEOUT_MS", 80000), 120000);
  assertEquals(h.warnings.length, 0);
});

Deno.test("surrounding whitespace is tolerated, not treated as garbage", () => {
  const h = harness({ T: "  45000\n" });
  assertEquals(h.read("T", 80000), 45000);
  assertEquals(h.warnings.length, 0);
});

Deno.test("blank and whitespace-only read as 'unset', not as zero", () => {
  // The real hazard: Number("") is 0, so a blank secret would otherwise abort
  // every call instantly. Silent, because a blank value is an absent one.
  for (const raw of ["", "   ", "\t\n"]) {
    const h = harness({ T: raw });
    assertEquals(h.read("T", 80000), 80000);
    assertEquals(h.warnings.length, 0);
  }
});

Deno.test("a non-numeric value falls back AND says so", () => {
  const h = harness({ T: "80s" });
  assertEquals(h.read("T", 80000), 80000);
  assertEquals(h.warnings.length, 1);
  // The name and the offending text both have to be in the line, or the log
  // cannot tell you which secret to go fix.
  assertEquals(h.warnings[0].includes("T="), true);
  assertEquals(h.warnings[0].includes("80s"), true);
});

Deno.test("zero and negatives fall back by default — never a 0ms abort", () => {
  for (const raw of ["0", "-1", "-80000"]) {
    const h = harness({ T: raw });
    assertEquals(h.read("T", 80000), 80000);
    assertEquals(h.warnings.length, 1);
  }
});

Deno.test("allowZero lets 0 through as a real kill switch", () => {
  // SSE_HEARTBEAT_MS=0 disables the keepalive; that is a choice, not a typo.
  const h = harness({ SSE_HEARTBEAT_MS: "0" });
  assertEquals(h.read("SSE_HEARTBEAT_MS", 10000, true), 0);
  assertEquals(h.warnings.length, 0);
});

Deno.test("allowZero rejects a positive value that would floor to zero", () => {
  // REGRESSION (CodeRabbit, PR #182): "0.5" cleared the old `n >= 0` check and
  // then floored to 0, silently disabling the heartbeat this PR exists to add.
  // Only an explicit zero may ever yield zero.
  for (const raw of ["0.5", "0.9", "0.001"]) {
    const h = harness({ SSE_HEARTBEAT_MS: raw });
    assertEquals(h.read("SSE_HEARTBEAT_MS", 10000, true), 10000);
    assertEquals(h.warnings.length, 1);
  }
});

Deno.test("a sub-integer is rejected without allowZero too", () => {
  const h = harness({ T: "0.5" });
  assertEquals(h.read("T", 80000), 80000);
  assertEquals(h.warnings.length, 1);
});

Deno.test("1 is the smallest accepted positive value", () => {
  // The boundary either side of the floor rule above.
  const h = harness({ T: "1" });
  assertEquals(h.read("T", 80000), 1);
  assertEquals(h.warnings.length, 0);
  const h2 = harness({ T: "1.9" });
  assertEquals(h2.read("T", 80000), 1);
  assertEquals(h2.warnings.length, 0);
});

Deno.test("the warning names what was expected, and says so differently under allowZero", () => {
  const strict = harness({ T: "nope" });
  strict.read("T", 80000);
  assertEquals(strict.warnings[0].includes("a number >= 1"), true);
  const zeroOk = harness({ T: "nope" });
  zeroOk.read("T", 80000, true);
  assertEquals(zeroOk.warnings[0].includes("0, or a number >= 1"), true);
});

Deno.test("allowZero still rejects negatives", () => {
  const h = harness({ SSE_HEARTBEAT_MS: "-1" });
  assertEquals(h.read("SSE_HEARTBEAT_MS", 10000, true), 10000);
  assertEquals(h.warnings.length, 1);
});

Deno.test("fractional values floor, so an override never grants more than asked", () => {
  const h = harness({ T: "999.9" });
  assertEquals(h.read("T", 80000), 999);
});

Deno.test("NaN and Infinity fall back rather than becoming a timeout", () => {
  for (const raw of ["NaN", "Infinity", "-Infinity"]) {
    const h = harness({ T: raw });
    assertEquals(h.read("T", 80000), 80000);
    assertEquals(h.warnings.length, 1);
  }
});

Deno.test("reads the real Deno.env when no getter is injected", () => {
  // Guards the default wiring: an injected-only test would pass even if the
  // production path read nothing at all.
  Deno.env.set("ENVINT_SELFTEST_MS", "1234");
  try {
    assertEquals(envInt("ENVINT_SELFTEST_MS", 9999), 1234);
  } finally {
    Deno.env.delete("ENVINT_SELFTEST_MS");
  }
  assertEquals(envInt("ENVINT_SELFTEST_ABSENT_MS", 9999), 9999);
});
