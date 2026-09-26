/**
 * Tiny JSON-file store under ./data. One file per collection.
 * Writes go through a per-file promise chain, so two jobs finishing at the
 * same moment cannot overwrite each other's changes.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.join(process.cwd(), 'data');

const chains: Map<string, Promise<unknown>> =
  ((globalThis as any).__studioChains ??= new Map());

export async function read<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, `${name}.json`), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function write<T>(name: string, value: T): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

export function update<T>(name: string, fallback: T, fn: (cur: T) => T | Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const cur = await read<T>(name, fallback);
    const val = await fn(cur);
    await write(name, val);
    return val;
  });
  chains.set(name, next);
  return next;
}

export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
