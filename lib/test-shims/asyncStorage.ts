// In-memory stand-in for @react-native-async-storage/async-storage, for Deno
// tests of modules that persist (see lib/coachConversations.test.ts).
const store = new Map<string, string>();
export default {
  getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
  setItem: (k: string, v: string) => { store.set(k, v); return Promise.resolve(); },
  removeItem: (k: string) => { store.delete(k); return Promise.resolve(); },
};
