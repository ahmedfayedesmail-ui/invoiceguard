// Review P1-b: an honest chain sealed beyond a retained earlier checkpoint must verify as a continuation; a shorter chain or a different entry at the checkpoint position is tampering.
import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { openDb } from '../src/db.js'; import { openIntelReader, sealSellerEvidence, verifyEvidenceChain, exportEvidenceBundle, verifyEvidenceBundle } from '../src/intel/store.js';
function grown(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ig-cp-')), path = join(dir, 's.db'), db = openDb(path), reader = openIntelReader(path); t.after(() => { try { reader.close(); db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  db.prepare('INSERT INTO sellers (id,name,created_at) VALUES (?,?,?)').run('seller-A', 'T', '2026-11-28T10:00:00.000Z'); db.prepare('INSERT INTO sellers (id,name,created_at) VALUES (?,?,?)').run('seller-B', 'T', '2026-11-28T10:00:00.000Z');
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)').run('seller-A', 'A-1', 'S-1', 'invoice', '2026-11-28T10:00:00.000Z', 10, 2, 'ready');
  const r1 = sealSellerEvidence({ writerDb: db, readerDb: reader, sellerId: 'seller-A' }); const cp1 = { sellerId: 'seller-A', sequence: r1.head.sequence, hash: r1.head.hash }; const bundle1 = exportEvidenceBundle(db, 'seller-A');
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)').run('seller-A', 'A-2', 'S-2', 'invoice', '2026-11-28T11:00:00.000Z', 20, 4, 'ready');
  const r2 = sealSellerEvidence({ writerDb: db, readerDb: reader, sellerId: 'seller-A' }); assert.ok(r2.head.sequence > cp1.sequence, 'the chain grew');
  return { db, cp1, bundle1, bundle2: exportEvidenceBundle(db, 'seller-A'), cp2: { sellerId: 'seller-A', sequence: r2.head.sequence, hash: r2.head.hash } };
}
test('CP1 an earlier retained checkpoint verifies a chain that has since grown (database and bundle)', t => {
  const g = grown(t); assert.equal(verifyEvidenceChain(g.db, 'seller-A', g.cp1).valid, true); assert.equal(verifyEvidenceChain(g.db, 'seller-A', g.cp2).valid, true);
  assert.equal(verifyEvidenceBundle(g.bundle2, { checkpoint: g.cp1 }).valid, true); assert.equal(verifyEvidenceBundle(g.bundle2, { checkpoint: g.cp2 }).valid, true);
});
test('CP2 a different entry at the checkpoint position is tampering, with its own reason', t => {
  const g = grown(t); const forged = { ...g.cp1, hash: 'f'.repeat(64) };
  assert.deepEqual([verifyEvidenceChain(g.db, 'seller-A', forged).valid, verifyEvidenceChain(g.db, 'seller-A', forged).reason], [false, 'external-checkpoint-mismatch']);
  assert.deepEqual([verifyEvidenceBundle(g.bundle2, { checkpoint: forged }).valid, verifyEvidenceBundle(g.bundle2, { checkpoint: forged }).reason], [false, 'external-checkpoint-mismatch']);
});
test('CP3 a chain shorter than the checkpoint is truncation', t => {
  const g = grown(t);
  const a = verifyEvidenceBundle(g.bundle1, { checkpoint: g.cp2 }); assert.equal(a.valid, false); assert.equal(a.reason, 'external-checkpoint-truncated');
  const b = verifyEvidenceChain(g.db, 'seller-A', { ...g.cp2, sequence: g.cp2.sequence + 5 }); assert.equal(b.valid, false); assert.equal(b.reason, 'external-checkpoint-truncated');
});
test('CP4 a checkpoint of another seller or a malformed checkpoint is refused', t => {
  const g = grown(t);
  for (const bad of [{ ...g.cp1, sellerId: 'seller-B' }, { ...g.cp1, sequence: -1 }, { ...g.cp1, sequence: 1.5 }, { ...g.cp1, sequence: '1' }, { ...g.cp1, hash: 'xyz' }, { ...g.cp1, hash: undefined }]) {
    assert.equal(verifyEvidenceChain(g.db, 'seller-A', bad).valid, false, JSON.stringify(bad)); assert.equal(verifyEvidenceBundle(g.bundle2, { checkpoint: bad }).valid, false, JSON.stringify(bad));
  }
});
test('CP5 the bundle\'s own embedded checkpoint must still equal its head exactly', t => {
  const g = grown(t); const own = { ...g.bundle2, checkpoint: g.cp1 }; const r = verifyEvidenceBundle(own); assert.equal(r.valid, false); assert.equal(r.reason, 'external-checkpoint-mismatch');
});
