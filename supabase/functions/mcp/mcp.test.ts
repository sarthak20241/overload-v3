import { assert, assertEquals } from "jsr:@std/assert@1";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "npm:jose@5";
import { verifyAccessToken, wwwAuthenticate } from "./auth.ts";
import { handleMessage, parseBody, PROTOCOL_VERSIONS, type Tool } from "./protocol.ts";
import { FOOD_WRITE_TOOLS } from "./foodWrites.ts";
import { TOOLS } from "./tools.ts";
import { WORKOUT_WRITE_TOOLS } from "./workoutWrites.ts";

const ISSUER = "https://clerk.example.test";
const RESOURCE = "https://proj.supabase.co/functions/v1/mcp";
const CTX = { userId: "user_1", email: "a@example.test" };

// ── auth ────────────────────────────────────────────────────────────────────

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
const JWKS = createLocalJWKSet({ keys: [jwk] });
const opts = { jwks: JWKS, issuer: ISSUER, audience: RESOURCE };

function token(claims: Record<string, unknown>, aud: string | string[] | null = RESOURCE, iss = ISSUER) {
  let t = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(iss).setIssuedAt().setExpirationTime("5m");
  if (aud) t = t.setAudience(aud);
  return t.sign(privateKey);
}

Deno.test("auth: an OAuth token for this server gets the user id, email and scopes", async () => {
  const t = await token({ sub: "user_1", email: "a@example.test", scope: "profile email", client_id: "c1" });
  const r = await verifyAccessToken(`Bearer ${t}`, opts);
  assertEquals(r, { ok: true, userId: "user_1", email: "a@example.test", clientId: "c1", scopes: ["profile", "email"] });
});

Deno.test("auth: aud may be a list that includes this server", async () => {
  const t = await token({ sub: "user_1" }, ["https://other.test", RESOURCE]);
  assert((await verifyAccessToken(`Bearer ${t}`, opts)).ok);
});

Deno.test("auth: the URL with a trailing slash is the same server", async () => {
  const both = { ...opts, audience: [RESOURCE, `${RESOURCE}/`] };
  const t = await token({ sub: "user_1" }, `${RESOURCE}/`);
  assert((await verifyAccessToken(`Bearer ${t}`, both)).ok);
  const other = await token({ sub: "user_1" }, `${RESOURCE}/x`);
  assertEquals((await verifyAccessToken(`Bearer ${other}`, both)).ok, false);
});

Deno.test("auth: an app session token (no aud) is refused", async () => {
  const t = await token({ sub: "user_1", sid: "sess_1" }, null);
  assertEquals((await verifyAccessToken(`Bearer ${t}`, opts)).ok, false);
});

Deno.test("auth: a token for another server is refused", async () => {
  const t = await token({ sub: "user_1" }, "https://evil.test/mcp");
  assertEquals((await verifyAccessToken(`Bearer ${t}`, opts)).ok, false);
});

Deno.test("auth: a token from another issuer is refused", async () => {
  const t = await token({ sub: "user_1" }, RESOURCE, "https://other-clerk.test");
  assertEquals((await verifyAccessToken(`Bearer ${t}`, opts)).ok, false);
});

Deno.test("auth: no header, no Bearer, no sub are refused", async () => {
  assertEquals((await verifyAccessToken(null, opts)).ok, false);
  assertEquals((await verifyAccessToken("Basic abc", opts)).ok, false);
  const t = await token({});
  assertEquals((await verifyAccessToken(`Bearer ${t}`, opts)).ok, false);
});

Deno.test("auth: the 401 header points at the metadata URL", () => {
  const url = `${RESOURCE}/.well-known/oauth-protected-resource`;
  assertEquals(wwwAuthenticate(url), `Bearer resource_metadata="${url}", scope="profile email"`);
  assert(wwwAuthenticate(url, "invalid_token").startsWith(`Bearer error="invalid_token", `));
});

// ── protocol ────────────────────────────────────────────────────────────────

const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  ({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });

Deno.test("initialize: echoes a known protocol version, else the newest", async () => {
  const a = await handleMessage(rpc("initialize", { protocolVersion: "2025-03-26" }), TOOLS, CTX) as any;
  assertEquals(a.result.protocolVersion, "2025-03-26");
  assertEquals(a.result.capabilities, { tools: { listChanged: false } });
  const b = await handleMessage(rpc("initialize", { protocolVersion: "1999-01-01" }), TOOLS, CTX) as any;
  assertEquals(b.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

Deno.test("a notification gets no reply", async () => {
  assertEquals(await handleMessage(rpc("notifications/initialized", undefined, null), TOOLS, CTX), null);
});

Deno.test("tools/list lists ping with its schema", async () => {
  const r = await handleMessage(rpc("tools/list"), TOOLS, CTX) as any;
  const ping = r.result.tools.find((t: any) => t.name === "ping");
  assertEquals(ping.inputSchema.type, "object");
  assertEquals(ping.annotations, { title: ping.title, openWorldHint: false, readOnlyHint: true });
});

Deno.test("tools/list: every tool has a title, says read or write, and is closed-world (directory review)", async () => {
  const all = [...TOOLS, ...FOOD_WRITE_TOOLS, ...WORKOUT_WRITE_TOOLS];
  const r = await handleMessage(rpc("tools/list"), all, CTX) as any;
  assertEquals(r.result.tools.length, all.length);
  for (const t of r.result.tools) {
    assert(typeof t.title === "string" && t.title.length > 0, `${t.name}: title`);
    assert(t.name.length <= 64, `${t.name}: name too long`);
    assertEquals(t.annotations.openWorldHint, false, t.name);
    assertEquals(t.annotations.title, t.title, `${t.name}: annotations.title`);
    assert(t.annotations.readOnlyHint === true || t.annotations.destructiveHint !== undefined, `${t.name}: read or write hint`);
  }
});

Deno.test("tools/call ping names the signed-in account", async () => {
  const r = await handleMessage(rpc("tools/call", { name: "ping", arguments: {} }), TOOLS, CTX) as any;
  assertEquals(r.result.structuredContent.text, "Connected to Overload as a@example.test.");
  assertEquals(r.result.isError, false);
  const named = await handleMessage(rpc("tools/call", { name: "ping" }), TOOLS, { ...CTX, profile: { name: "Sam" } }) as any;
  assertEquals(named.result.structuredContent.text, "Connected to Overload as Sam.");
});

Deno.test("a gate refusal is the answer, and done() hears how each call ended", async () => {
  const seen: string[] = [];
  const hooks = {
    gate: (t: Tool) =>
      Promise.resolve(t.name === "ping" ? null : { status: "denied" as const, result: { text: "Pro only", isError: true } }),
    done: (t: Tool, status: string) => { seen.push(`${t.name}:${status}`); return Promise.resolve(); },
  };
  const denied = await handleMessage(rpc("tools/call", { name: "get_profile" }), TOOLS, CTX, hooks) as any;
  assertEquals(denied.result, { content: [{ type: "text", text: "Pro only" }], isError: true });
  await handleMessage(rpc("tools/call", { name: "ping" }), TOOLS, CTX, hooks);
  assertEquals(seen, ["get_profile:denied", "ping:ok"]);
});

Deno.test("an unknown tool or method is a JSON-RPC error", async () => {
  const a = await handleMessage(rpc("tools/call", { name: "nope" }), TOOLS, CTX) as any;
  assertEquals(a.error.code, -32602);
  const b = await handleMessage(rpc("resources/list"), TOOLS, CTX) as any;
  assertEquals(b.error.code, -32601);
});

Deno.test("a tool that throws becomes an isError result, not a crash", async () => {
  const boom: Tool = {
    name: "boom", title: "", description: "", inputSchema: { type: "object" },
    run: () => Promise.reject(new Error("db down")),
  };
  const r = await handleMessage(rpc("tools/call", { name: "boom" }), [boom], CTX) as any;
  assertEquals(r.result.isError, true);
});

Deno.test("bad bodies: not JSON, a batch, not JSON-RPC", async () => {
  assert("reply" in parseBody("{oops"));
  assert("reply" in parseBody("[]"));
  const r = await handleMessage({ id: 3, method: "ping" }, TOOLS, CTX) as any;
  assertEquals(r.error.code, -32600);
  assertEquals(r.id, 3);
});
