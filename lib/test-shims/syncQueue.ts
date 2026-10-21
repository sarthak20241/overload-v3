// Stand-in for lib/syncQueue in Deno tests: only the id minting that
// coachConversations needs, without the Supabase / SecureStore import chain.
let n = 0;
export function newClientId(): string {
  n += 1;
  return `test-${n}`;
}
