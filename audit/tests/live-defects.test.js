// OPEN defect specification (fails today, deliberately NOT in test/ so the suite counts stay as reported). Run: node --test audit/tests/live-defects.test.js
// src/reconcile.js stages(doc).expected decides "NOT DUE / Amazon made this" or "the seller must upload" from invoice-status ALONE. It displays is-amazon-invoiced and is-business-order but never reads them to decide.
// Rule (Ahmed): who issues the invoice is read from the field, never inferred from invoice-status. No production caller of stages() was found in src/ or web/ (only tests); the explanation could still reach a seller if one is added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reconcile, stages } from '../../src/reconcile.js';

const DECL = JSON.parse(readFileSync('fixtures/recon/declared.json', 'utf8'));
const withCols = (name, edits) => { const raw = readFileSync('fixtures/recon/' + name, 'utf8'), lines = raw.trim().split('\n'), h = lines[0].split('\t'); const text = [lines[0], ...lines.slice(1).map(r => { const c = r.split('\t'); for (const [k, v] of Object.entries(edits)) c[h.indexOf(k)] = v; return c.join('\t'); })].join('\n') + '\n';
  return { id: name.replace('.tsv', ''), fileName: name, text, sha256: createHash('sha256').update(text).digest('hex'), importedAt: '2026-11-20T10:00:00Z', declared: DECL[name] }; };
const expected = (name, edits) => stages(reconcile([withCols(name, edits)]).docs[0]).expected;

test('stages: is-amazon-invoiced TRUE with invoice-status InvoicePending is a conflict; it must not be explained as "the seller must upload"', () => {
  const e = expected('all-r1-pending.tsv', { 'is-amazon-invoiced': 'TRUE' });
  assert.notEqual(e.state, 'EVIDENCE', JSON.stringify(e).slice(0, 200));
});
test('stages: a BLANK is-amazon-invoiced with InvoiceCreatedByAmazon must not be explained as "Amazon made this document"', () => {
  const e = expected('all-r3-uploaded.tsv', { 'is-amazon-invoiced': '', 'invoice-status': 'InvoiceCreatedByAmazon' });
  assert.notEqual(e.state, 'NOT DUE', JSON.stringify(e).slice(0, 200));
});
