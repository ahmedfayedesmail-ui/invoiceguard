// Format-variant pins (swarm-fixtures-e2e). Synthetic fixtures only (fixtures/loop). Pins CURRENT behaviour of the readers for file
// shapes the fixtures corpus never contained: CRLF, BOM+CRLF, lone CR, quoted cells with tab/newline, locale money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkTsv, parseVidr } from '../src/vidr.js';
import { parseTable } from '../src/manual.js';
import { preflight } from '../src/loop/pilot.js';
import { readDelimited, readMoney, detectLedgerMapping } from '../src/loop/ledger.js';

const vidr = readFileSync(new URL('../fixtures/loop/vidr-1.tsv', import.meta.url), 'utf8');
const ledger = readFileSync(new URL('../fixtures/loop/ledger-1.csv', import.meta.url), 'utf8');
const decl = { reportType: 'VAT_INVOICE_DATA_REPORT', options: 'ALL', rangeFrom: '2026-11-01', rangeTo: '2026-11-27' };
const withCell = (text, sep, row, col, val) => { const L = text.split('\n'); const c = L[row].split(sep); c[col] = val; L[row] = c.join(sep); return L.join('\n'); };
const CUR = vidr.split('\n')[0].split('\t').indexOf('currency');

test('fixtures baseline: no fixture file has a BOM, CR, or quote (corpus gap this file compensates for)', () => {
  for (const t of [vidr, ledger]) { assert.ok(!t.startsWith('\uFEFF')); assert.ok(!t.includes('\r')); assert.ok(!t.includes('"')); }
});
test('VIDR reads identically with LF, CRLF and BOM+CRLF', () => {
  const base = checkTsv(vidr).rows; assert.equal(base.length, 6);
  for (const t of [vidr.replace(/\n/g, '\r\n'), '\uFEFF' + vidr.replace(/\n/g, '\r\n')]) { const r = checkTsv(t); assert.deepEqual(r.rows, base); assert.equal(r.invalid.length, 0); }
});
test('VIDR with lone CR line endings is refused by the pilot preflight, not read as empty success', () => {
  const t = vidr.replace(/\n/g, '\r');
  const src = preflight({ vidrText: t, vidrDeclared: decl }).checks.find(x => x.id === 'SOURCE_TYPE');
  assert.equal(src.status, 'FAIL');
});
test('VIDR quoted cell containing a tab or newline is quarantined as invalid rows (fail closed)', () => {
  assert.equal(checkTsv(withCell(vidr, '\t', 1, CUR, '"EU\tR"')).invalid.length, 1);
  assert.equal(checkTsv(withCell(vidr, '\t', 1, CUR, '"EU\nR"')).invalid.length, 2);
});
test('LEDGER reads with CRLF and BOM+CRLF; lone CR is refused; quoted newline is counted as a ragged row', () => {
  for (const t of [ledger.replace(/\n/g, '\r\n'), '\uFEFF' + ledger.replace(/\n/g, '\r\n')]) { const m = detectLedgerMapping(t); assert.equal(m.ok, true); assert.equal(m.rowCount, 6); assert.equal(m.raggedRows, 0); }
  assert.equal(detectLedgerMapping(ledger.replace(/\n/g, '\r')).ok, false);
  const r = readDelimited(withCell(ledger, ';', 1, 9, '"Amazon\n.es"')); assert.equal(r.ok, true); assert.equal(r.raggedRows, 1);
});
test('readMoney: locale numbers with the declared separators; look-alike formats are rejected, never guessed', () => {
  const eq = (v, d, t, c) => assert.equal(readMoney(v, d, t), c, v);
  eq('1.234,56', ',', '.', 123456); eq('1 234,56', ',', ' ', 123456); eq('1\u00a0234,56', ',', '\u00a0', 123456); eq('1\u202f234,56', ',', '\u202f', 123456);
  eq("1'234.56", '.', "'", 123456); eq('1,234.56', '.', ',', 123456); eq('-121,00', ',', '', -12100);
  for (const v of ['(121,00)', '121,00-', '€ 121,00', '1.23,45']) assert.ok(Number.isNaN(readMoney(v, ',', '.')), v);
});
test('TODO parity: the two VIDR table readers treat a quoted cell the same way', { todo: 'src/manual.js parseTable strips surrounding quotes, src/vidr.js checkTsv keeps them' }, () => {
  const t = withCell(vidr, '\t', 1, CUR, '"EUR"');
  assert.equal(parseTable(t).rows[0].currency, checkTsv(t).rows[0].currency);
});
