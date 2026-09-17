// Run with: deno test --allow-all lib/planChangeSource.test.ts
//
// The database records WHO changed a plan from the x-change-source header
// (migration 0123). These pin that a tagged client puts the header on every
// write and on nothing else, so a chat apply is never logged as a manual edit.

import { assertEquals } from "jsr:@std/assert@1";
import { withChangeSource } from "./planChangeSource.ts";

/** A client shaped like supabase-js: from(table) returns a builder whose write
 *  methods return a request that records the headers set on it. */
function fakeClient() {
  const sent: { table: string; op: string; headers: Record<string, string | undefined> }[] = [];
  // deno-lint-ignore no-explicit-any
  type Any = any;
  const request = (table: string, op: string): Any => {
    const headers: Record<string, string | undefined> = {};
    const req: Any = {
      setHeader(name: string, value: string) { headers[name] = value; return req; },
      eq(..._a: unknown[]) { return req; },
      select(..._a: unknown[]) { return req; },
      single() { return req; },
      then(resolve: (v: unknown) => void) { sent.push({ table, op, headers }); resolve({ data: null, error: null }); },
    };
    return req;
  };
  const client = {
    from(table: string): Any {
      return {
        select: (..._a: unknown[]) => request(table, "select"),
        insert: (..._a: unknown[]) => request(table, "insert"),
        update: (..._a: unknown[]) => request(table, "update"),
        upsert: (..._a: unknown[]) => request(table, "upsert"),
        delete: (..._a: unknown[]) => request(table, "delete"),
      };
    },
    rpc: (..._a: unknown[]) => request("rpc", "rpc"),
    marker: "client",
  };
  return { client, sent };
}

Deno.test("every write through a tagged client carries the source", async () => {
  const { client, sent } = fakeClient();
  const chat = withChangeSource(client, "chat");
  await chat.from("user_profiles").update({}).eq("clerk_user_id", "u");
  await chat.from("routines").insert({}).select().single();
  await chat.from("routine_exercises").delete().eq("routine_id", "r");
  await chat.from("routines").upsert({});
  assertEquals(sent.map((s) => s.headers["x-change-source"]), ["chat", "chat", "chat", "chat"]);
});

Deno.test("reads are not tagged, and the untagged client is untouched", async () => {
  const { client, sent } = fakeClient();
  const chat = withChangeSource(client, "chat");
  await chat.from("routines").select();
  await client.from("routines").update({});
  assertEquals(sent.map((s) => s.headers["x-change-source"]), [undefined, undefined]);
});

Deno.test("a card id rides along when given", async () => {
  const { client, sent } = fakeClient();
  await withChangeSource(client, "card", "11111111-2222-3333-4444-555555555555").from("user_profiles").update({});
  assertEquals(sent[0].headers, { "x-change-source": "card", "x-change-card": "11111111-2222-3333-4444-555555555555" });
});

Deno.test("everything else on the client still works", () => {
  const { client } = fakeClient();
  assertEquals(withChangeSource(client, "auto").marker, "client");
});
