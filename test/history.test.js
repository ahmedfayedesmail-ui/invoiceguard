import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHistory, memoryAdapter, sha256Hex } from '../src/history.js';
const DECL = JSON.parse(readFileSync('fixtures/recon/declared.json', 'utf8'));
const imp = (n) => ({ id: n.replace('.tsv', ''), fileName: n, text: readFileSync('fixtures/recon/' + n, 'utf8'), declared: DECL[n] });

test('history: add imports in any order, reconcile, export an Evidence Bundle, delete everything', async () => {
  const a = memoryAdapter(), h = createHistory(a);
  for (const n of ['all-r3-uploaded.tsv', 'all-r1-pending.tsv', 'all-r2-processing.tsv']) await h.addImport(imp(n));
  const { result } = await h.reconcile(); assert.equal(result.docs.find(d => d.parts['shipping-id'] === 'S9001').state, 'ACCEPTED');
  const b = await h.evidenceBundle();
  assert.equal(b.imports.length, 3); assert.ok(b.imports.every(i => /^[0-9a-f]{64}$/.test(i.sha256) && i.declared.options === 'ALL'));
  assert.equal(b.imports[0].sha256, await sha256Hex(b.imports[0].text), 'the bundle lets a third party re-hash the raw file');
  assert.ok(b.evidenceLogs.length >= 1 && b.evidenceLogs.every(l => l.declaredBySeller.labelledAs.includes('declared by the seller')));
  assert.match(JSON.stringify(b), /not verified by InvoiceGuard/); assert.doesNotMatch(JSON.stringify(b), /monitor/i);
  await h.deleteEverything(); assert.deepEqual(await h.imports(), []); assert.deepEqual(await a.list(), []);
});

test('history: encrypted store is not readable without the passphrase, and a wrong passphrase fails loudly', async () => {
  const a = memoryAdapter(), h = createHistory(a, { passphrase: 'correct horse' }); await h.addImport(imp('all-r3-uploaded.tsv'));
  const raw = await a.get((await a.list())[0]); assert.equal(raw.enc, true); assert.doesNotMatch(JSON.stringify(raw), /S9001|A-2026-000123/);
  assert.equal((await h.imports()).length, 1);
  await assert.rejects(createHistory(a, { passphrase: 'wrong' }).imports(), /Wrong passphrase/);
  await assert.rejects(createHistory(a).imports(), /passphrase is needed/);
});
