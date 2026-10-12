/**
 * The daily Aside routine talks to the studio through plain GET links, since a
 * browser agent opens pages more reliably than it sends POSTs. Any web page
 * could make your browser open such a link, so each one needs this token,
 * which only the routine prompt knows.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store';

export async function routineToken(): Promise<string> {
  if (process.env.STUDIO_ROUTINE_TOKEN?.trim()) return process.env.STUDIO_ROUTINE_TOKEN.trim();
  const file = path.join(DATA_DIR, 'routine-token.txt');
  try {
    const t = (await fs.readFile(file, 'utf8')).trim();
    if (t) return t;
  } catch { /* first run */ }
  const t = randomBytes(16).toString('hex');
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, t, { mode: 0o600 });
  return t;
}

export async function tokenOk(req: Request): Promise<boolean> {
  const given = new URL(req.url).searchParams.get('token') ?? '';
  return given.length > 0 && given === (await routineToken());
}
