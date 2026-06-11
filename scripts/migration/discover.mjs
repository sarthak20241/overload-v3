#!/usr/bin/env node
// Discovery pass for the circle-rate -> Overload migration.
//
// This does NOT write anything anywhere. It connects to the source MongoDB,
// maps out databases/collections, and surfaces the documents belonging to the
// users we intend to migrate, so we can design an accurate transform into the
// Supabase `workouts` / `workout_sets` schema.
//
// Usage (after egress to *.mongodb.net:27017 is allowed and Atlas Network
// Access permits this host's IP):
//   cd scripts/migration && npm install && node discover.mjs
//
// Reads MONGO_URI and MIGRATE_USERS from .env.migration (or the real env).

import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

// --- tiny .env loader (no dependency) -------------------------------------
// Minimal KEY=VALUE parser. Inline trailing comments (KEY=val # note) are NOT
// supported — the value runs to end of line. Use a whole-line `#` comment or
// quote the value.
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      let [, k, v] = m;
      // Strip only matching surrounding quotes (don't pair a leading " with a trailing ').
      v = v.trim().replace(/^(["'])(.*)\1$/, '$2');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* file optional */ }
}
loadEnvFile(new URL('.env.migration', import.meta.url).pathname);

const MONGO_URI = process.env.MONGO_URI;
const TARGETS = (process.env.MIGRATE_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!MONGO_URI) {
  console.error('MONGO_URI not set. Copy .env.migration.example -> .env.migration.');
  process.exit(1);
}

// Max matched documents printed per collection (the true count is still
// reported when this cap is hit, so large histories aren't under-reported).
const SAMPLE_LIMIT = 5;

// Field names commonly used to identify a user across schemas.
const ID_FIELDS = ['email', 'userEmail', 'user_email', 'username', 'userName',
  'user_name', 'handle', 'phone', 'mobile', 'name'];

function buildUserQuery() {
  const ors = [];
  for (const t of TARGETS) {
    const rx = new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    for (const f of ID_FIELDS) ors.push({ [f]: rx });
  }
  return ors.length ? { $or: ors } : null;
}

// NOTE: hard slice for readability — output may be truncated mid-structure and
// is NOT guaranteed to be valid JSON. It's a human inspection aid only.
const trim = (doc) => JSON.stringify(doc, null, 2).slice(0, 4000);

async function main() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  console.log('Connected.\n');

  // Ensure the connection is always closed, even if discovery throws partway.
  try {
    const admin = client.db().admin();
    const { databases } = await admin.listDatabases();
    const userQuery = buildUserQuery();

    for (const { name } of databases) {
      if (['admin', 'local', 'config'].includes(name)) continue;
      const db = client.db(name);
      const collections = await db.listCollections().toArray();
      console.log(`\n===== DB: ${name} (${collections.length} collections) =====`);

      for (const { name: coll } of collections) {
        const c = db.collection(coll);
        // Approximate — estimatedDocumentCount() reads collection metadata and may
        // be stale after an unclean shutdown. Good enough for a discovery pass.
        const count = await c.estimatedDocumentCount();
        console.log(`\n--- ${name}.${coll}  (~${count} docs) ---`);

        const sample = await c.findOne();
        if (sample) console.log('sample keys:', Object.keys(sample).join(', '));

        if (userQuery) {
          const matches = await c.find(userQuery).limit(SAMPLE_LIMIT).toArray();
          if (matches.length) {
            // Route PII to stderr (console.warn) so piping stdout to a file
            // does not silently capture raw user documents without the warning.
            console.warn('>>> PII: treat the following matched documents as sensitive — do not paste into tickets/logs.');
            // If we hit the sample cap, report the true count so a large
            // workout history isn't silently under-reported during discovery.
            const total = matches.length < SAMPLE_LIMIT
              ? matches.length
              : await c.countDocuments(userQuery);
            console.warn(`>>> ${total} match(es) for target users (showing up to ${SAMPLE_LIMIT}):`);
            for (const m of matches) console.warn(trim(m));
          }
        }
      }
    }
  } finally {
    await client.close();
  }
  console.log('\nDone. No data was modified.');
}

main().catch((err) => { console.error('ERROR:', err); process.exit(1); });
