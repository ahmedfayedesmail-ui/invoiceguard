// Review P1-c: snapshotSources sorted row keys as text, so rowids sealed as 1,10,11,12,2,3... Order must be numeric and independent of ICU/locale.
import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { openDb } from '../src/db.js'; import { openIntelReader, sealSellerEvidence, verifyEvidenceChain } from '../src/intel/store.js';
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'ig-order-')), path = join(dir, 's.db'), db = openDb(path); db.prepare('INSERT INTO sellers (id,name,created_at) VALUES (?,?,?)').run('seller-A', 'T', '2026-11-28T10:00:00.000Z'); const reader = openIntelReader(path); t.after(() => { try { reader.close(); db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }); return { db, reader }; }
const keysOf = (db, table) => db.prepare('SELECT canonical_json FROM intel_evidence_chain WHERE seller_id=? ORDER BY seq').all('seller-A').map(r => JSON.parse(r.canonical_json)).filter(b => b.sourceTable === table).map(b => b.sourceKey);
test('IO1 twelve events seal in insertion (rowid) order, not text order', t => {
  const { db, reader } = fixture(t); for (let i = 1; i <= 12; i++) db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)').run('2026-11-28T10:00:' + String(i).padStart(2, '0') + '.000Z', 'seller-A', 'step_' + i, JSON.stringify({ n: i }));
  sealSellerEvidence({ writerDb: db, readerDb: reader, sellerId: 'seller-A' });
  assert.deepEqual(keysOf(db, 'events'), Array.from({ length: 12 }, (_, i) => String(i + 1))); assert.equal(verifyEvidenceChain(db, 'seller-A').valid, true);
});
test('IO2 integrity history with ten or more rows keeps numeric order too, and text keys still sort by code point', t => {
  const { db, reader } = fixture(t); for (let i = 1; i <= 11; i++) db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)').run('seller-A', 'S', 'C', 'f', 'opened', 'fp' + i, '2026-11-28T10:00:00.000Z');
  for (const k of ['b-10', 'B-2', 'b-2', 'a-9']) db.prepare('INSERT INTO shipments (seller_id,key,order_id,shipping_id,total,vat,shipment_date,due_at,status,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('seller-A', k, 'O', k, 1, 0, '2026-11-28', '2026-12-28', 'open', 'x', '2026-11-28T10:00:00.000Z');
  sealSellerEvidence({ writerDb: db, readerDb: reader, sellerId: 'seller-A' });
  assert.deepEqual(keysOf(db, 'integrity_history'), Array.from({ length: 11 }, (_, i) => String(i + 1)));
  assert.deepEqual(keysOf(db, 'shipments'), ['B-2', 'a-9', 'b-2', 'b-10'], 'upper case before lower case (code point), digit runs compared as numbers');
});
