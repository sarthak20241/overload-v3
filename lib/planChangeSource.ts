/**
 * Who changed the plan. The database logs every plan change (migration 0123,
 * plan_changes) and reads WHO from the x-change-source header on the request.
 * With no header a signed-in change counts as 'manual', which is right for a
 * user editing a screen and wrong for everything else. So any write that is
 * not the user's own hand goes through a tagged client:
 *
 *   await saveProgram(withChangeSource(supabase, 'chat'), clerkId, program);
 *
 * Only writes are tagged (insert, update, upsert, delete); reads pass through.
 * The wrapper passes the client along unchanged otherwise, so functions that
 * take a client need no new parameter, and nested calls inherit the tag.
 *
 * No imports, so Deno can test it (planChangeSource.test.ts).
 */

export type ChangeSource = 'manual' | 'chat' | 'card' | 'auto' | 'onboarding';

const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

interface Taggable {
  setHeader(name: string, value: string): unknown;
}

export function withChangeSource<C extends { from(table: string): unknown }>(
  client: C,
  source: ChangeSource,
  cardId?: string,
): C {
  const tag = (request: unknown) => {
    const r = request as Partial<Taggable> | null;
    if (r && typeof r.setHeader === 'function') {
      r.setHeader('x-change-source', source);
      if (cardId) r.setHeader('x-change-card', cardId);
    }
    return request;
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => {
          const query = target.from(table) as Record<string, unknown>;
          return new Proxy(query, {
            get(q, p) {
              const value = q[p as string];
              if (typeof value !== 'function') return value;
              if (WRITES.has(p as string)) {
                return (...args: unknown[]) => tag((value as (...a: unknown[]) => unknown).apply(q, args));
              }
              return (value as (...a: unknown[]) => unknown).bind(q);
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
