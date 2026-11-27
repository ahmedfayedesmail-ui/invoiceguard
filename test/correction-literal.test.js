import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVidr } from '../src/vidr.js';
import { openDb } from '../src/db.js';

// Amazon's guide (6.3.4) shows CorrectionReversal:X:... and Correction:X:...; the pipeline also saw Correction::X:... Both forms must be recognised.
const base = readFileSync('fixtures/vidr.tsv', 'utf8').split('\n');
const withTx = (id, type) => { const head = base[0].split('\t'), row = base[1].split('\t'); row[head.indexOf('transaction-id')] = id; row[head.indexOf('transaction-type')] = type; return [base[0], row.join('\t')].join('\n') + '\n'; };

test('parseVidr recognises CorrectionReversal:X:, Correction:X: and Correction::X: (prefix match), and plain ids stay plain', () => {
  const rev = parseVidr(withTx('CorrectionReversal:X:100000001', 'REFUND'))[0], c1 = parseVidr(withTx('Correction:X:100000001', 'SHIPMENT'))[0], c2 = parseVidr(withTx('Correction::X:2', 'SHIPMENT'))[0], plain = parseVidr(withTx('S1001', 'SHIPMENT'))[0];
  assert.deepEqual([rev.isCorrectionReversal, rev.isCorrectedTx], [true, false]);
  assert.deepEqual([c1.isCorrectionReversal, c1.isCorrectedTx], [false, true]);
  assert.deepEqual([c2.isCorrectionReversal, c2.isCorrectedTx], [false, true]);
  assert.deepEqual([plain.isCorrectionReversal, plain.isCorrectedTx], [false, false]);
});

test('the one-document-per-correction-event database guard covers both id forms', () => {
  for (const id of ['Correction::X:2', 'Correction:X:100000001']) {
    const db = openDb(':memory:'), ins = (n) => db.prepare("INSERT INTO invoices (seller_id, number, shipment_key, kind) VALUES ('s', ?, ?, 'rectificativa')").run(n, 'SHIPMENT:' + id);
    ins('R-1'); assert.throws(() => ins('R-2'), /UNIQUE/, id);
  }
});
