// Expedition W2-1: the upload state machine of a document (invoices.upload_status).
// OBSERVED_TRANSITIONS is the set of (old -> new) pairs actually exercised by the whole existing suite on 8d9e6d9 (traced with a temporary trigger, see docs/expedition/STATE-MACHINE.md). It documents reality; it is not a claim that every pair is desirable.
import test from 'node:test'; import assert from 'node:assert/strict'; import { openDb } from '../src/db.js';
const STATES = ['pending', 'ready', 'sending', 'submitted', 'processing', 'unknown', 'rejected', 'uploaded'];
function seed(db, status, kind = 'invoice') { db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,upload_status) VALUES (?,?,?,?,?,?,?,?,?)').run('s1', 'N1', 'K', kind, '2026-01-01', 1, 0, '{}', status); }
const set = (db, to) => db.prepare("UPDATE invoices SET upload_status=? WHERE seller_id='s1' AND number='N1'").run(to);
test('SM1 an Amazon-confirmed (uploaded) document can never leave that state, for any target, for invoices and credit notes', () => {
  for (const kind of ['invoice', 'rectificativa']) for (const to of STATES.filter(x => x !== 'uploaded').concat([null, 'bogus'])) { const db = openDb(); seed(db, 'uploaded', kind); assert.throws(() => set(db, to), /never changes status again/, `${kind} uploaded -> ${to}`); assert.equal(db.prepare('SELECT upload_status s FROM invoices').get().s, 'uploaded'); }
});
test('SM2 (guard) uploaded -> uploaded (a no-op rewrite, e.g. a timestamp refresh) stays allowed', () => { const db = openDb(); seed(db, 'uploaded'); set(db, 'uploaded'); db.prepare("UPDATE invoices SET uploaded_at='x' WHERE number='N1'").run(); });
test('SM3 (guard) every non-terminal state still moves as the product needs: the full observed forward path pending->sending->submitted->processing->uploaded and the rejected/unknown retry loops', () => {
  const path = ['sending', 'submitted', 'processing', 'uploaded']; const db = openDb(); seed(db, 'pending'); for (const to of path) set(db, to);
  for (const [a, b] of [['pending', 'ready'], ['ready', 'uploaded'], ['sending', 'unknown'], ['unknown', 'sending'], ['sending', 'rejected'], ['rejected', 'sending'], ['submitted', 'rejected']]) { const d = openDb(); seed(d, a); set(d, b); }
});
test('SM4 the terminal rule holds against concurrent writers: two OS-level connections to one file, the second cannot revive an accepted document', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const f = join(mkdtempSync(join(tmpdir(), 'sm-')), 'a.db');
  const a = openDb(f), b = openDb(f); seed(a, 'submitted'); set(a, 'uploaded'); assert.throws(() => set(b, 'sending'), /never changes status again/); assert.equal(b.prepare('SELECT upload_status s FROM invoices').get().s, 'uploaded');
});
