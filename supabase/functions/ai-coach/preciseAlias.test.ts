// Per-user Precise aliases: the edge function must name the user on every
// alias read and write. The SQL side (only the owner's alias is an exact hit)
// is tested in supabase/tests/precise_alias_per_user.sql.
import { assertEquals } from "jsr:@std/assert@1";
import { type AliasAdmin, preciseAliasStore } from "./preciseAlias.ts";

function fakeAdmin(rpcResult: { data: unknown; error: { message: string } | null }) {
  const rpcs: Array<[string, Record<string, unknown>]> = [];
  const upserts: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [];
  const admin: AliasAdmin = {
    rpc(fn, args) {
      rpcs.push([fn, args]);
      return { maybeSingle: () => Promise.resolve(rpcResult) };
    },
    from(table) {
      return {
        upsert(row, opts) {
          upserts.push([table, row, opts]);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { admin, rpcs, upserts };
}

Deno.test("alias lookup asks for the caller's own aliases only", async () => {
  const row = { id: "row-1", display_name: "whole eggs" };
  const { admin, rpcs } = fakeAdmin({ data: row, error: null });
  const got = await preciseAliasStore(admin, "user_a").lookup("egg");
  assertEquals(rpcs, [["precise_cache_by_alias", { p_key: "egg", p_user: "user_a" }]]);
  assertEquals(got, row);
});

Deno.test("alias lookup error is a miss", async () => {
  const { admin } = fakeAdmin({ data: null, error: { message: "function does not exist" } });
  assertEquals(await preciseAliasStore(admin, "user_a").lookup("egg"), null);
});

Deno.test("alias write records the owner and keys on (user, phrase)", async () => {
  const { admin, upserts } = fakeAdmin({ data: null, error: null });
  const store = preciseAliasStore(admin, "user_b");
  await store.put("egg", "row-1", 0.84);
  await store.put("oreo protein bar", "row-2", null, "lookup");
  assertEquals(upserts, [
    [
      "precise_alias",
      { user_id: "user_b", alias_key: "egg", row_id: "row-1", source: "jev", confidence: 0.84 },
      { onConflict: "user_id,alias_key", ignoreDuplicates: true },
    ],
    [
      "precise_alias",
      { user_id: "user_b", alias_key: "oreo protein bar", row_id: "row-2", source: "lookup", confidence: null },
      { onConflict: "user_id,alias_key", ignoreDuplicates: true },
    ],
  ]);
});
