// Stand-in for lib/supabase in Deno tests: the two token reads the direct
// fetch callers use, set per test, without the supabase-js / SecureStore chain.
export const tokens = {
  cached: null as string | null,
  fresh: null as string | null,
  freshAsked: 0,
};

export function getSupabaseAccessToken(): Promise<string | null> {
  return Promise.resolve(tokens.cached);
}

export function getFreshSupabaseAccessToken(): Promise<string | null> {
  tokens.freshAsked += 1;
  return Promise.resolve(tokens.fresh);
}
