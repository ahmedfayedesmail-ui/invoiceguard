// swarm/t1-vidr-variants: locks in the TSV-ingestion behavior for the format variants Amazon
// sellers actually produce (Excel round-trips, platform exports, wrong-file uploads).
// Every expectation here was first observed by running planUpload/parseVidr on
// expedition/invoiceguard-product-grade @ ebfd583. Synthetic data only (the repo fixture rows).
// Deliberately NOT asserted: behavior that swarm/ingest-hardening intentionally changes
// (unsupportedColumns hold, header-derived optional trailing columns) - that branch owns those.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planUpload } from '../src/manual.js';
import { parseVidr } from '../src/vidr.js';

const fx = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const LINES = fx.split('\n');
const HEAD = LINES[0].split('\t');
const setCell = (line, name, val) => { const c = line.split('\t'); c[HEAD.indexOf(name)] = val; return c.join('\t'); };
const shape = (p) => p.ok ? { issue: p.shipments.length, held: p.held.length, skipped: p.skipped.length, quarantined: (p.invalidRows ?? []).length } : { error: p.error };
const BASELINE = { issue: 4, held: 0, skipped: 2, quarantined: 0 }; // observed on ebfd583 for the untouched fixture

test('baseline fixture parses as expected (anchor)', () => {
  assert.deepEqual(shape(planUpload(fx)), BASELINE);
});

test('CRLF line endings parse identically to LF', () => {
  assert.deepEqual(shape(planUpload(fx.split('\n').join('\r\n'))), BASELINE);
});

test('UTF-8 BOM is stripped and parses identically', () => {
  assert.deepEqual(shape(planUpload('\uFEFF' + fx)), BASELINE);
});

test('BOM + CRLF together parse identically', () => {
  assert.deepEqual(shape(planUpload('\uFEFF' + fx.split('\n').join('\r\n'))), BASELINE);
});

test('empty trailing lines are ignored', () => {
  assert.deepEqual(shape(planUpload(fx + '\n\n\n')), BASELINE);
});

test('reordered headers parse identically (header-driven mapping)', () => {
  const rot = (arr) => arr.slice(5).concat(arr.slice(0, 5));
  const text = fx.split('\n').filter(l => l !== '').map(l => rot(l.split('\t')).join('\t')).join('\n') + '\n';
  assert.deepEqual(shape(planUpload(text)), BASELINE);
});

test('a cell containing a tab (Excel-quoted) is quarantined, never half-read', () => {
  const text = [LINES[0], setCell(LINES[1], 'product-name', '"Cable\tHDMI"'), ...LINES.slice(2)].join('\n');
  const plan = planUpload(text);
  assert.equal(plan.ok, true);
  assert.equal(plan.shipments.length, 3, 'the split row must not become a shipment');
  assert.equal((plan.invalidRows ?? []).length, 1);
  assert.match(plan.invalidRows[0].reason, /more cells than the header/);
});

test('a cell containing a newline splits the row; both pieces are quarantined', () => {
  const text = [LINES[0], setCell(LINES[1], 'product-name', '"Cable\nHDMI"'), ...LINES.slice(2)].join('\n');
  const plan = planUpload(text);
  assert.equal(plan.ok, true);
  assert.equal(plan.shipments.length, 3);
  assert.equal((plan.invalidRows ?? []).length, 2, 'neither piece of a split row may be used');
});

test('duplicate header column with agreeing values parses identically', () => {
  const idx = HEAD.indexOf('ship-country');
  const text = fx.split('\n').map((l, i) => l === '' ? l : (i === 0 ? l + '\tship-country' : l + '\t' + l.split('\t')[idx])).join('\n');
  assert.deepEqual(shape(planUpload(text)), BASELINE);
});

test('duplicate header column with disagreeing values: the row is quarantined, never guessed', () => {
  const idx = HEAD.indexOf('ship-country');
  const text = fx.split('\n').map((l, i) => {
    if (l === '') return l;
    if (i === 0) return l + '\tship-country';
    const v = l.split('\t')[idx];
    return l + '\t' + (i === 1 ? (v === 'ES' ? 'FR' : 'ES') : v);
  }).join('\n');
  const plan = planUpload(text);
  assert.equal(plan.shipments.length, 3);
  assert.equal((plan.invalidRows ?? []).length, 1);
  assert.match(plan.invalidRows[0].reason, /repeats the column/);
});

test('a row with more cells than the header is quarantined', () => {
  const ls = fx.split('\n'); ls[1] = ls[1] + '\tEXTRA';
  const plan = planUpload(ls.join('\n'));
  assert.equal(plan.shipments.length, 3);
  assert.equal((plan.invalidRows ?? []).length, 1);
});

test('CSV renamed .tsv is rejected as not tab-separated, nothing issued', () => {
  const plan = planUpload(fx.replace(/\t/g, ','));
  assert.equal(plan.ok, false);
  assert.match(plan.error, /tab-separated/);
});

test('semicolon-delimited file is rejected as not tab-separated', () => {
  const plan = planUpload(fx.replace(/\t/g, ';'));
  assert.equal(plan.ok, false);
  assert.match(plan.error, /tab-separated/);
});

test('binary (xlsx) bytes renamed .tsv are rejected, nothing issued', () => {
  const xlsx = 'PK\x03\x04\x14\x00\x06\x00\x08\x00\x00\x00!\x00junk\x00\x00\x00\x13\x00\x08\x01[Content_Types].xml\nPK\x01\x02more zip bytes\n';
  const plan = planUpload(xlsx);
  assert.equal(plan.ok, false, 'binary content must never reach issuance');
});

test('tab-separated text that is not an Amazon report is rejected as unrecognised', () => {
  const plan = planUpload('name\tcity\tnote\nfoo\tbar\tbaz\nqux\tquux\tcorge\n');
  assert.equal(plan.ok, false);
  assert.match(plan.error, /do not recognise/);
});

test('empty file and header-only file are rejected, nothing issued', () => {
  for (const text of ['', LINES[0] + '\n']) {
    const plan = planUpload(text);
    assert.equal(plan.ok, false);
  }
});

test('a VIDR-shaped header missing both shipment identifiers invalidates every row', () => {
  const drop = ['shipping-id', 'transaction-id'];
  const keep = HEAD.map((h, i) => [h, i]).filter(([h]) => !drop.includes(h));
  const text = [keep.map(([h]) => h).join('\t'),
    ...LINES.slice(1).filter(l => l).map(l => keep.map(([, i]) => l.split('\t')[i]).join('\t'))].join('\n') + '\n';
  const parsed = parseVidr(text);
  assert.equal(parsed.length, 0, 'no shipment may be read from a header that cannot identify one');
  assert.equal((parsed.invalidRows ?? []).length, 6, 'every data row is quarantined with the reason');
  assert.match(parsed.invalidRows[0].reason, /does not identify shipments/);
});
