/**
 * The daily routine must never put the same thread on X twice.
 * Run: npx tsx --test test/routine.test.mts   (from tools/content-studio)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'studio-test-'));
process.env.STUDIO_DATA_DIR = dir;
process.env.STUDIO_ROUTINE_TOKEN = 'tok';

const { GET: xNext } = await import('../app/api/routine/x-next/route');
const { GET: xPosted } = await import('../app/api/routine/x-posted/route');
const drafts = await import('../app/api/drafts/route');
const { postBlocker } = await import('../lib/checks');

const base = { topicId: 't', channel: 'x', rationale: '', altHooks: [], scores: {}, history: [], status: 'draft', createdAt: 'x', updatedAt: '2026-01-01' };
const seed = (rows: object[]) => writeFileSync(path.join(dir, 'drafts.json'), JSON.stringify(rows));
const load = () => JSON.parse(readFileSync(path.join(dir, 'drafts.json'), 'utf8')) as any[];
const next = async (token = 'tok') => (await xNext(new Request(`http://localhost/x?token=${token}`))).json();
const call = (fn: (r: Request) => Promise<Response>, method: string, body: object) =>
  fn(new Request('http://localhost/', { method, body: JSON.stringify(body) }));

test('a wrong or missing token is refused', async () => {
  assert.equal((await xNext(new Request('http://localhost/x'))).status, 403);
  assert.equal((await xNext(new Request('http://localhost/x?token=nope'))).status, 403);
});

test('an unconfirmed draft is never handed out a second time', async () => {
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['a'], ready: true, readyAt: '1' }, { ...base, id: 'B', topicTitle: 'B', parts: ['b'], ready: true, readyAt: '2' }]);
  assert.equal((await next()).draft.id, 'A');
  const day2 = await next();
  assert.equal(day2.draft, null);
  assert.equal(day2.unconfirmed.id, 'A');
});

test('a confirmed draft is posted and the queue moves on', async () => {
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['a'], ready: true, readyAt: '1' }, { ...base, id: 'B', topicTitle: 'B', parts: ['b'], ready: true, readyAt: '2' }]);
  await next();
  const r = await xPosted(new Request('http://localhost/x?token=tok&id=A&url=https://x.com/u/status/1'));
  assert.equal(r.status, 200);
  assert.equal((await next()).draft.id, 'B');
  // A second confirm of A is refused.
  assert.equal((await xPosted(new Request('http://localhost/x?token=tok&id=A&url=https://x.com/u/status/1'))).status, 400);
});

test('marking a claimed draft Ready again keeps the claim', async () => {
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['a'], ready: true, readyAt: '1' }]);
  await next();
  await call(drafts.PATCH, 'PATCH', { id: 'A', ready: true });
  assert.ok(load()[0].claimedAt, 'claim must survive a repeat Ready');
  assert.equal((await next()).draft, null);
});

test('a claimed draft cannot be edited', async () => {
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['a'], ready: true, readyAt: '1' }]);
  await next();
  const r = await call(drafts.PUT, 'PUT', { id: 'A', parts: ['changed'] });
  assert.equal(r.status, 409);
  assert.deepEqual(load()[0].parts, ['a']);
  assert.ok(load()[0].claimedAt);
});

test('Not ready releases the claim', async () => {
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['a'], ready: true, readyAt: '1' }]);
  await next();
  await call(drafts.PATCH, 'PATCH', { id: 'A', ready: false });
  assert.equal(load()[0].claimedAt, undefined);
  assert.equal(load()[0].ready, false);
});

test('only a draft that could be posted as-is can be Ready', async () => {
  assert.match(postBlocker({ channel: 'x', parts: ['fill [this]'] })!, /placeholder/);
  assert.match(postBlocker({ channel: 'x', parts: ['a — b'] })!, /em dash/);
  assert.match(postBlocker({ channel: 'x', parts: ['x'.repeat(281)] })!, /limit/);
  assert.equal(postBlocker({ channel: 'x', parts: ['fine'] }), null);
  seed([{ ...base, id: 'P', topicTitle: 'P', parts: ['fill [this]'] }]);
  assert.equal((await call(drafts.PATCH, 'PATCH', { id: 'P', ready: true })).status, 400);
});

test('Post now and the routine at the same moment: only one sends', async () => {
  Object.assign(process.env, { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'a' });
  const { POST: publish } = await import('../app/api/publish/route');
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['a'], ready: true, readyAt: '1' }]);
  let sends = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    sends++;
    await new Promise((r) => setTimeout(r, 200));
    return new Response(JSON.stringify({ data: { id: '9' } }), { status: 201 });
  }) as typeof fetch;
  try {
    const posting = call(publish, 'POST', { draftId: 'A', action: 'post' });
    await new Promise((r) => setTimeout(r, 50)); // Post now is mid-flight
    const routine = await next();
    assert.equal(routine.draft, null, 'the routine must not take a draft that is being posted');
    assert.equal((await posting).status, 200);
    assert.equal(sends, 1);
    assert.equal(load()[0].status, 'posted');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed Post now gives the draft back', async () => {
  const { POST: publish } = await import('../app/api/publish/route');
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['a'], ready: true, readyAt: '1' }]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
  try {
    assert.equal((await call(publish, 'POST', { draftId: 'A', action: 'post' })).status, 502);
    assert.equal(load()[0].claimedAt, undefined);
    assert.equal((await next()).draft.id, 'A');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a rewrite that finishes after the routine took the draft does not overwrite it', async () => {
  // A fake writer that takes a moment, like the real one.
  const fake = path.join(dir, 'fakeclaude.mjs');
  const reply = JSON.stringify({ parts: ['rewritten'], rationale: 'r', altHooks: [], scores: {} });
  writeFileSync(fake, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', is_error: false, result: ${JSON.stringify(reply)} }));
}, 1000));
`, { mode: 0o755 });
  process.env.CLAUDE_BIN = fake;
  process.env.OVERLOAD_REPO = path.resolve('..', '..');
  const { refineDraft } = await import('../lib/generate');
  seed([{ ...base, id: 'A', topicTitle: 'A', parts: ['original'], ready: true, readyAt: '1' }]);
  const rewriting = refineDraft({ draftId: 'A', instruction: 'shorter' }, () => {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await next()).draft.id, 'A'); // routine takes it mid-rewrite
  await assert.rejects(rewriting, /routine has taken/);
  assert.deepEqual(load()[0].parts, ['original']);
  assert.ok(load()[0].claimedAt);
});
