// P3: migration, deletion, retention, backup of a real loop store on the vault. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault } from '../src/loop/vault.js';
import { migrateLegacy, legacyKeys, MigrationError } from '../src/loop/migrate.js';
import { createLoopStore, Refused } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const PW = 'correct horse battery', ITER = 1000;
const clock = () => { let t = Date.parse('2026-11-20T10:00:00Z'); return () => new Date(t += 60000).toISOString(); };
const seed = async (adapter, now = clock()) => { await adapter.put('loop:profile', { id: 'p-fixed', createdAt: '2026-11-20T09:00:00Z' }); const s = createLoopStore(adapter, { now }); await s.addVidr({ text: F.V1, declared: F.VDECL('2026-11-20T10:00:00Z') }); await s.addLedger({ text: F.L1, profile: F.PROFILE, declared: F.LDECL() }); return s; };
const view = async (s) => { const r = await s.project(); return JSON.stringify([r.issues.map(i => [i.key, i.family, i.subtype, i.state, i.fingerprint]), r.buckets]); };
const dump = async (raw) => JSON.stringify(await Promise.all((await raw.list()).map(async k => [k, await raw.get(k)])));

test('P1/P2 behavior is unchanged on the vault: the same files give the same problems, keys and fingerprints as on plain storage', async () => {
  const plain = await seed(memoryAdapter()), raw = memoryAdapter(), v = createVault(raw, { iterations: ITER }); await v.create(PW);
  const enc = await seed(v.adapter); assert.equal(await view(enc), await view(plain));
  const all = await dump(raw);
  assert.ok(!all.includes('acme-books') && !all.includes('"loop:'), 'declarations and logical keys are not in storage');
});
test('migration: legacy plaintext moves into the vault, verified, then removed; results are identical before and after', async () => {
  const raw = memoryAdapter(), legacy = await seed(raw), before = await view(legacy); assert.ok((await legacyKeys(raw)).length >= 3);
  const v = createVault(raw, { iterations: ITER }); await v.create(PW); const rep = await migrateLegacy(v);
  assert.equal(rep.found, rep.migrated); assert.equal(rep.removed, rep.found); assert.deepEqual(await legacyKeys(raw), []); assert.equal((await raw.get('vault:migration')).state, 'done');
  assert.equal(await view(createLoopStore(v.adapter)), before); assert.ok(!(await dump(raw)).includes('acme-books'));
  assert.equal((await migrateLegacy(v)).found, 0, 'a second run does nothing');
});
test('migration: interrupted after the copy (delete fails halfway): the originals and the copy both exist, a rerun finishes, nothing is lost or duplicated', async () => {
  const raw = memoryAdapter(), legacy = await seed(raw), before = await view(legacy), n = (await legacyKeys(raw)).length; let dels = 0;
  const flaky = { ...raw, del: async (k) => { if (String(k).startsWith('loop:') && ++dels === 2) throw new Error('interrupted'); return raw.del(k); } };
  const v = createVault(flaky, { iterations: ITER }); await v.create(PW);
  await assert.rejects(() => migrateLegacy(v), MigrationError); assert.equal((await legacyKeys(raw)).length, n - 1, 'one original removed, the rest intact');
  assert.equal(await view(createLoopStore(v.adapter)), before, 'the vault copy is complete and equal');
  const v2 = createVault(raw, { iterations: ITER }); await v2.unlock(PW); const rep = await migrateLegacy(v2); assert.deepEqual(await legacyKeys(raw), []); assert.equal(rep.found, n - 1);
  assert.equal(await view(createLoopStore(v2.adapter)), before); assert.equal((await v2.adapter.list()).length, n);
});
test('migration: a storage quota failure while copying leaves every original untouched and says so', async () => {
  const raw = memoryAdapter(), legacy = await seed(raw), before = await view(legacy), n = (await legacyKeys(raw)).length; let puts = 0;
  const flaky = { ...raw, put: async (k, v) => { if (String(k).startsWith('e1:') && ++puts === 2) throw new DOMException('quota', 'QuotaExceededError'); return raw.put(k, v); } };
  const v = createVault(flaky, { iterations: ITER }); await v.create(PW); await assert.rejects(() => migrateLegacy(v), (e) => e instanceof MigrationError && /original data is still in place/.test(e.message));
  assert.equal((await legacyKeys(raw)).length, n); assert.equal(await view(createLoopStore(raw)), before, 'the old page data still reads exactly as before');
  const v2 = createVault(raw, { iterations: ITER }); await v2.unlock(PW); await migrateLegacy(v2); assert.deepEqual(await legacyKeys(raw), []); assert.equal(await view(createLoopStore(v2.adapter)), before);
});
test('migration: an unreadable or conflicting legacy record is reported and KEPT, never discarded', async () => {
  const raw = memoryAdapter(); await seed(raw); await raw.put('loop:import:broken', null); await raw.put('loop:event:weird', 'not an object');
  const v = createVault(raw, { iterations: ITER }); await v.create(PW); const rep = await migrateLegacy(v);
  assert.deepEqual(rep.unreadable.sort(), ['loop:event:weird', 'loop:import:broken']); assert.equal((await raw.get('vault:migration')).state, 'partial'); assert.deepEqual((await legacyKeys(raw)).sort(), ['loop:event:weird', 'loop:import:broken']);
  const raw2 = memoryAdapter(); await raw2.put('loop:profile', { id: 'p-old' }); const v2 = createVault(raw2, { iterations: ITER }); await v2.create(PW); await v2.adapter.put('loop:profile', { id: 'p-new' });
  const r2 = await migrateLegacy(v2); assert.deepEqual(r2.conflicts, ['loop:profile']); assert.deepEqual(await raw2.get('loop:profile'), { id: 'p-old' }, 'the old record is kept'); assert.deepEqual(await v2.adapter.get('loop:profile'), { id: 'p-new' }, 'the vault record is not overwritten');
});
test('deletion: impact is shown first, confirmation is required, the import and its derived statements go, the other import and statements stay', async () => {
  const raw = memoryAdapter(), v = createVault(raw, { iterations: ITER }); await v.create(PW); const s = await seed(v.adapter);
  const r = await s.project(); const issue = r.issues.find(i => i.family === 'UNMATCHED_DOCUMENT' || i.family === 'BOOKS_GAP' || i.family === 'INVOICE_AMAZON_STATE'); assert.ok(issue);
  await s.addEvent({ type: 'ACTION_STARTED', issueKey: issue.key, author: 'Test seller', reasoning: 'started' });
  const imports = await s.imports(), ledger = imports.find(i => i.kind === 'ledger'), vidr = imports.find(i => i.kind === 'vidr'), listBefore = (await v.adapter.list()).length;
  const impact = await s.deletionImpact(ledger.id); assert.equal(impact.import.id, ledger.id); assert.ok(Object.keys(impact.issuesDisappearing).length + impact.issuesChanging > 0); assert.equal((await v.adapter.list()).length, listBefore, 'the preview changes nothing');
  await assert.rejects(() => s.deleteImport(ledger.id), Refused); await assert.rejects(() => s.deleteImport(ledger.id, { confirmed: 'yes' }), Refused);
  const done = await s.deleteImport(ledger.id, { confirmed: true }); assert.equal(done.deleted, true);
  assert.deepEqual((await s.imports()).map(i => i.id), [vidr.id]); const rest = JSON.stringify(await s.project());
  // Changed with the import-deletion-history fix: the CONTENT of the deleted file is gone everywhere; a permanent deletion record keeps only metadata (file name, kind, hash, time, reason, affected problems) so the past cannot be forged.
  const body = ledger.text.split('\n').filter(l => l.trim()).at(-1);
  assert.ok(!rest.includes(body), 'no content of the deleted file remains in the results');
  const all = JSON.stringify(await Promise.all((await v.adapter.list()).map(k => v.adapter.get(k)))); assert.ok(!all.includes(body), 'nor in any stored record');
  const rec = (await s.deletions()); assert.equal(rec.length, 1); assert.equal(rec[0].import.sha256, ledger.sha256); assert.ok(!('text' in rec[0].import) && !('declared' in rec[0].import));
  for (const k of (await v.adapter.list())) assert.ok(!k.startsWith('loop:import:' + ledger.id), 'record gone');
  await assert.rejects(() => s.deletionImpact('imp-nope'), Refused);
});
test('deletion: whole workspace leaves no usable vault and no readable record', async () => {
  const raw = memoryAdapter(), v = createVault(raw, { iterations: ITER }); await v.create(PW); const s = await seed(v.adapter); await s.deleteEverything();
  assert.deepEqual(await raw.list(), []); await assert.rejects(() => createVault(raw, { iterations: ITER }).unlock(PW), (e) => e.code === 'NO_VAULT');
});
test('retention: the default keeps everything; automatic deletion needs explicit confirmed settings and only removes imports older than the limit', async () => {
  const raw = memoryAdapter(), v = createVault(raw, { iterations: ITER }); await v.create(PW); const s = await seed(v.adapter);
  assert.deepEqual((await s.settings()).retention, { mode: 'KEEP' }); assert.deepEqual(await s.applyRetention('2030-01-01T00:00:00Z'), { enabled: false, deleted: [] }); assert.equal((await s.imports()).length, 2, 'nothing is deleted by default, however old');
  await assert.rejects(() => s.setSettings({ retention: { mode: 'AFTER_DAYS', days: 90 } }), Refused, 'needs confirmation'); await assert.rejects(() => s.setSettings({ retention: { mode: 'AFTER_DAYS', days: 3, confirmedAt: 'x' } }), Refused, 'too short'); await assert.rejects(() => s.setSettings({ autoLockMinutes: -1 }), Refused);
  await s.setSettings({ retention: { mode: 'AFTER_DAYS', days: 90, confirmedAt: '2026-11-21T00:00:00Z' } });
  assert.equal((await s.retentionPreview('2026-12-01T00:00:00Z')).due.length, 0, 'not old enough'); assert.equal((await s.retentionPreview('2027-03-01T00:00:00Z')).due.length, 2);
  const r = await s.applyRetention('2027-03-01T00:00:00Z'); assert.equal(r.deleted.length, 2); assert.equal((await s.imports()).length, 0);
});
test('backup and restore of a real store: encrypted, integrity-checked, and the restored vault gives identical results', async () => {
  const raw = memoryAdapter(), v = createVault(raw, { iterations: ITER }); await v.create(PW); const s = await seed(v.adapter), before = await view(s); const bk = JSON.parse(JSON.stringify(await v.exportBackup()));
  assert.ok(!JSON.stringify(bk).includes('acme-books')); const raw2 = memoryAdapter(), v2 = createVault(raw2, { iterations: ITER }); await v2.restoreBackup(bk, PW); await v2.unlock(PW); assert.equal(await view(createLoopStore(v2.adapter)), before);
});
test('no network: import, projection, deletion and backup never call fetch, XHR or WebSocket (the engine has no network code)', async () => {
  const calls = []; const keep = { fetch: globalThis.fetch, XMLHttpRequest: globalThis.XMLHttpRequest, WebSocket: globalThis.WebSocket };
  globalThis.fetch = (...a) => { calls.push(['fetch', String(a[0])]); throw new Error('network'); }; globalThis.XMLHttpRequest = class { constructor() { calls.push(['xhr']); } }; globalThis.WebSocket = class { constructor() { calls.push(['ws']); } };
  try { const raw = memoryAdapter(), v = createVault(raw, { iterations: ITER }); await v.create(PW); const s = await seed(v.adapter); await s.project(); await s.bundle(); await v.exportBackup(); const l = (await s.imports())[0]; await s.deletionImpact(l.id); await s.deleteImport(l.id, { confirmed: true }); await s.deleteEverything(); }
  finally { Object.assign(globalThis, keep); } assert.deepEqual(calls, []);
});
test('static: the loop engine, the vault and the loop page contain no network API, no logging and no storage other than IndexedDB', async () => {
  const { readFileSync, readdirSync } = await import('node:fs'); const files = readdirSync(new URL('../src/loop/', import.meta.url)).map(f => 'src/loop/' + f).concat(['public/local/loop.js', 'public/local/loop.html', 'src/history.js']);
  for (const f of files) { const t = readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''); for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/, /\bconsole\./, /localStorage/, /sessionStorage/, /caches\./, /serviceWorker/, /document\.cookie/, /https?:\/\//]) assert.ok(!bad.test(t), `${f} matches ${bad}`); }
});
