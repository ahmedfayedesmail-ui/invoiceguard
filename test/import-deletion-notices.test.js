// Phase 0, plain words around the deletion record: what an export contains, what a restore can bring back, and that the record sits inside the encrypted vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLoopStore, DELETION_EXPORT_NOTICE, RESTORE_WARNING } from '../src/loop/store.js';
import { createVault } from '../src/loop/vault.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const lrow = (n, o) => [n, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', o, 'Amazon.es'].join(';');
async function seeded(adapter) {
  const s = createLoopStore(adapter);
  await s.addVidr({ text: F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }]), declared: F.VDECL('2026-11-20T10:00:00Z'), fileName: 'report.tsv' });
  const b = await s.addLedger({ text: F.ledger([lrow('AMZ-1', F.O(1))]), profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), fileName: 'secret-client-books.csv' });
  return { s, b };
}
test('the export carries the record of deleted files AND says so in the file itself, in plain words', async () => {
  const { s, b } = await seeded(memoryAdapter()); await s.deleteImport(b, { confirmed: true });
  const x = await s.bundle(); assert.equal(x.deletions.length, 1); assert.equal(x.deletions[0].import.fileName, 'secret-client-books.csv'); assert.match(x.deletions[0].import.sha256, /^[0-9a-f]{64}$/);
  assert.equal(x.deletionRecordNotice, DELETION_EXPORT_NOTICE); for (const w of ['names', 'fingerprints', 'time of each deletion', 'does not contain what was inside']) assert.ok(x.deletionRecordNotice.includes(w), w);
});
test('the export page shows the same words next to the export button, and the restore page warns before and when a backup is chosen', () => {
  const ui = readFileSync(new URL('../public/local/loop.js', import.meta.url), 'utf8');
  assert.ok(ui.includes("DELETION_EXPORT_NOTICE") && ui.includes("id: 'bundle-notice'")); assert.ok(ui.includes("id: 'g-restore-warning'") && ui.includes("RESTORE_WARNING + '\\n\\nRestore this backup?'"));
  for (const w of ['Files you deleted after that backup come back', 'the records of those deletions are not in it', 'will not be shown as deleted']) assert.ok(RESTORE_WARNING.includes(w), w);
});
test('the deletion record is stored only inside the encrypted vault: no file name or fingerprint in the raw store, no content anywhere', async () => {
  const raw = memoryAdapter(), v = createVault(raw, { iterations: 1000 }); await v.create('correct horse battery staple');
  const { s, b } = await seeded(v.adapter); const sha = (await s.imports()).find(i => i.id === b).sha256; await s.deleteImport(b, { confirmed: true });
  assert.equal((await s.deletions())[0].import.fileName, 'secret-client-books.csv', 'readable through the unlocked vault');
  const rawDump = JSON.stringify(await Promise.all((await raw.list()).map(k => raw.get(k))));
  assert.ok(!rawDump.includes('secret-client-books') && !rawDump.includes(sha) && !rawDump.includes('AMZ-1'), 'the raw store holds ciphertext only');
  const inner = JSON.stringify(await Promise.all((await v.adapter.list()).map(k => v.adapter.get(k)))); assert.ok(!inner.includes('AMZ-1;Factura') && !inner.includes('Nº factura'), 'no file content, even through the vault');
});
