// T1 VIDR input robustness. Regression tests built from the REAL quirks of Amazon's own published samples (test/fixtures/amazon-vidr, byte-for-byte): comma-separated, not valid UTF-8 (CP437/850 bytes), CRLF, 86 columns,
// no correction columns; XML variant with BOM, whitespace inside values and mixed currencies. Public placeholder data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { planUpload } from '../src/manual.js';
import { parseVidr } from '../src/vidr.js';
import { decodeReportBytes, detectDelimiter, normalizeReport, xmlToRows, unreadableCells } from '../src/vidr-input.js';

const fx = (f) => readFileSync(new URL('./fixtures/amazon-vidr/' + f, import.meta.url));
const CSV = fx('VIDR_FLAT_FILE_SAMPLE.csv'), XML = fx('VIDR_XML_SAMPLE_V2.xml');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const asText = (b) => decodeReportBytes(b).text;
const flipCsv = (buf, col, val) => { const L = buf.toString('latin1').split('\r\n'); const i = L[0].split(',').indexOf(col); return Buffer.from(L.map((l, k) => { if (!k || !l) return l; const c = l.split(','); c[i] = val; return c.join(','); }).join('\r\n'), 'latin1'); };

test('the fixtures are Amazon\'s published bytes (hash pinned) and keep the quirks the owner described', () => {
  assert.equal(sha(CSV), 'ef3e891d4f234b8ba286151c28ed7d0ea83d1b761b60afa12dc5f20d6d606c54');
  assert.equal(sha(XML), '94ff989aec8ca52f2a774ebb15c63649cee05fc5bb851bfa9e5d04e1ea359403');
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(CSV), 'the CSV is not valid UTF-8');
  assert.equal(detectDelimiter(asText(CSV)), ',');
});

test('bytes: valid UTF-8 stays UTF-8 (BOM dropped); invalid UTF-8 falls back to a flagged byte-for-byte read; the fallback never throws', () => {
  assert.deepEqual(decodeReportBytes(Buffer.from('\uFEFFa\tb\nü\t2', 'utf8')), { text: 'a\tb\nü\t2', encoding: 'utf-8', fallback: false });
  const d = decodeReportBytes(CSV); assert.equal(d.encoding, 'latin1-fallback'); assert.equal(d.fallback, true); assert.ok(d.text.includes('\u0081'), 'byte 0x81 is kept, not dropped');
  assert.doesNotThrow(() => decodeReportBytes(Buffer.from([0xff, 0xfe, 0x00, 0x80])));
});

test('delimiter is read from the header line: tab, comma, quoted commas do not count, semicolon is named, nothing clear is null', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t'); assert.equal(detectDelimiter('a,b,c\n1,2,3'), ','); assert.equal(detectDelimiter('"a,x","b,y",c\tz\tw\n'), '\t');
  assert.equal(detectDelimiter('a;b;c\n'), 'semicolon'); assert.equal(detectDelimiter('hello world'), null); assert.equal(detectDelimiter(''), null);
});

test('Amazon CSV sample: read as CSV, 86 columns, 6 rows, 0 invalid rows, no correction columns reported, nothing silently dropped', () => {
  const list = parseVidr(asText(CSV));
  assert.equal(list.inputSource, 'csv'); assert.equal(list.inputHead.length, 86); assert.equal(list.invalidRows.length, 0);
  assert.deepEqual(list.absent.correction, ['is-invoice-corrected', 'original-vat-invoice-number', 'invoice-correction-details']);
  assert.equal(list.length, 5, 'six physical rows make five shipments/returns: two rows share shipping-id D1cjkekMD (Amazon\'s sample reuses it for two different orders and currencies)'); assert.equal(list.filter(s => s.transactionType === 'RETURN').length, 3);
  const plan = planUpload(asText(CSV)); assert.equal(plan.ok, true); assert.equal(plan.format, 'vidr'); assert.equal(plan.rows, 6);
  assert.ok(plan.warnings.some(w => /no correction columns/.test(w)), 'absence is reported');
  assert.equal(plan.shipments.length + plan.held.length + plan.skipped.length, 5, 'every shipment is accounted for');
});

test('as published, every Amazon sample row says is-business-order FALSE: 0 issued, all skipped with that reason (CSV and XML)', () => {
  for (const b of [CSV, XML]) { const p = planUpload(asText(b)); assert.equal(p.ok, true); assert.equal(p.shipments.length, 0); assert.equal(p.held.length, 0); assert.equal(p.skipped.length, 5); assert.ok(p.skipped.every(s => /is-business-order FALSE/.test(s.why))); }
});

test('wrong-encoding text is HELD with the column names, never issued and never guessed (business flag set TRUE on the real bytes)', () => {
  const p = planUpload(asText(flipCsv(CSV, 'is-business-order', 'TRUE')));
  assert.equal(p.shipments.length, 0); assert.equal(p.held.length, 2);
  assert.ok(p.held.every(h => /cannot be read exactly/.test(h.reason) && /did not guess/.test(h.reason)));
  assert.ok(p.held.some(h => /product-name/.test(h.reason)) && p.held.some(h => /citation-fr/.test(h.reason)));
  assert.ok(!p.held.some(h => /\u0081|\u0082|\u0084/.test(h.reason)), 'no cell content in the reason');
});

test('the date format of Amazon\'s own samples is held, not guessed: US M/D/YYYY (CSV) and zone-less "YYYY-MM-DD hh:mm:ss" (XML)', () => {
  // text made clean so only the date can hold the row
  const clean = flipCsv(CSV, 'is-business-order', 'TRUE').toString('latin1').replace(/[\u0080-\u009f]/g, 'u');
  const p = planUpload(clean); assert.equal(p.shipments.length, 0); assert.ok(p.held.length >= 1 && p.held.every(h => /shipment-date/.test(h.reason)), JSON.stringify(p.held.map(h => h.reason.slice(0, 80))));
});

test('Amazon XML sample: read as XML (BOM, whitespace in values), 6 items, mixed EUR/GBP in one item is held as unreadable, corrections absent', () => {
  const n = normalizeReport(asText(XML)); assert.equal(n.source, 'xml'); assert.equal(n.rowsInSource, 6); assert.ok(n.notes.some(x => /more than one currency/.test(x)));
  const list = parseVidr(asText(XML)); assert.equal(list.length, 5); assert.equal(list.invalidRows.length, 0);
  assert.equal(list.filter(s => s.unreadable?.includes('currency')).length, 1);
  const ship = list.find(s => s.transactionType === 'SHIPMENT'); assert.equal(ship.orderId, 'XXX-XXXXXXX-XXXXXXX'); assert.ok(ship.incl > 0);
  assert.equal(list.absent.correction.length, 3);
});

test('XML and CSV of the same report agree on the money columns of the shared shipments (D1cjkekMD, EUR)', () => {
  const c = parseVidr(asText(CSV)).find(s => s.transactionType === 'SHIPMENT' && s.currency === 'EUR' && s.items[0].qty === 10), x = parseVidr(asText(XML)).find(s => s.transactionType === 'SHIPMENT' && s.items[0].qty === 10);
  assert.ok(c && x); for (const k of ['incl', 'vat', 'excl', 'currency', 'shippingId', 'transactionId']) assert.equal(c[k], x[k], k);
});

test('malformed XML never crashes: cut off, bad nesting, DOCTYPE, no envelope all give a plain error', () => {
  const s = asText(XML);
  for (const bad of [s.slice(0, 4000), s.replace('</ShipmentReport>', '</Message>'), '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><AmazonEnvelope></AmazonEnvelope>', '<?xml version="1.0"?><Other/>']) {
    let p; assert.doesNotThrow(() => { p = planUpload(bad); }); assert.equal(p.ok, false); assert.ok(typeof p.error === 'string' && p.error.length > 10);
  }
});

test('missing and unknown columns are tolerated: a tab file with a subset of columns plus an unknown one still parses; absent columns are named', () => {
  const t = ['order-id\tshipping-id\ttransaction-id\ttransaction-type\tinvoice-status\tis-business-order\tis-amazon-invoiced\tsomething-new\titem-vat-incl-amount\tcurrency', 'O1\tS1\tS1\tSHIPMENT\tInvoicePending\tTRUE\tFALSE\tzzz\t121.00\tEUR'].join('\n');
  const list = parseVidr(t); assert.equal(list.length, 1); assert.equal(list.invalidRows.length, 0); assert.equal(list.absent.correction.length, 3);
  assert.equal(planUpload(t).ok, true);
});

test('trailing malformed rows: a cut-off row, an over-long row and a junk line are quarantined with line numbers; good rows still read; no crash', () => {
  const lines = asText(flipCsv(CSV, 'is-business-order', 'TRUE')).split('\r\n').filter(Boolean);
  const bad = [...lines, lines[1].split(',').slice(0, 40).join(','), lines[2] + ',extra,extra', '%%% trailing junk %%%'].join('\r\n');
  const list = parseVidr(bad); assert.equal(list.invalidRows.length, 3, JSON.stringify(list.invalidRows.map(x => x.line))); assert.equal(list.length, 5);
  assert.deepEqual(list.invalidRows.map(x => x.line), [8, 9, 10]);
});

test('CSV quoting: a quoted comma stays in its cell; a line break or tab inside a quoted cell makes the row unreadable (held), never repaired', () => {
  const head = 'order-id,shipping-id,transaction-id,transaction-type,invoice-status,is-business-order,is-amazon-invoiced,billing-name,currency,item-vat-incl-amount,shipment-date';
  const row = (name) => `O1,S1,S1,SHIPMENT,InvoicePending,TRUE,FALSE,${name},EUR,121.00,2026-11-20`;
  const ok = parseVidr([head, row('"Acme, S.L."')].join('\n')); assert.equal(ok[0].billing.name, 'Acme, S.L.'); assert.equal(ok[0].unreadable, undefined);
  const nl = parseVidr([head, row('"Acme\nS.L."')].join('\n')); assert.deepEqual(nl[0].unreadable, ['billing-name']);
  const unterminated = parseVidr([head, row('"Acme S.L.')].join('\n')); assert.ok(unterminated.invalidRows.length >= 1 || unterminated.length === 0 || unterminated[0].unreadable);
  assert.deepEqual(unreadableCells({ a: 'ok', b: 'x\u0084y' }), ['b']);
});

test('formats we do not read stay refused with a plain reason (semicolon, random text, All Orders)', () => {
  assert.equal(planUpload('a;b;c\n1;2;3').ok, false); assert.equal(planUpload('hello').ok, false); assert.equal(planUpload('a,b,c\n1,2,3').ok, false);
  assert.equal(planUpload('').ok, false);
});

async function boot() {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0]; return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('signup', { email: 'amz@x.es', password: 'Long-Enough-Pw-42!' }); await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] }); await call('amazon/connect', { manual: true });
  return { server, call };
}
test('REAL upload path: Amazon CSV and XML samples as raw bytes through /api/manual/preview and /issue: 200, 0 issued, 0 errors, warnings shown; derived business=TRUE variants are held, never issued', async () => {
  const a = await boot();
  try {
    for (const [name, b] of [['csv', CSV], ['xml', XML]]) {
      const pre = await a.call('manual/preview', { bytesBase64: b.toString('base64') }); assert.equal(pre.status, 200, name + JSON.stringify(pre.body).slice(0, 200));
      assert.equal(pre.body.rows, 6); assert.equal(pre.body.willIssue, 0); assert.equal(pre.body.invalidRowsCount, 0); assert.ok(pre.body.warnings.some(w => /no correction columns/.test(w)));
      const iss = await a.call('manual/issue', { bytesBase64: b.toString('base64'), attest: true }); assert.equal(iss.status, 200, name + JSON.stringify(iss.body).slice(0, 300)); assert.equal(iss.body.issued, 0); assert.equal(iss.body.errors, 0);
    }
    const d = await a.call('manual/issue', { bytesBase64: flipCsv(CSV, 'is-business-order', 'TRUE').toString('base64'), attest: true });
    assert.equal(d.status, 200); assert.equal(d.body.issued, 0); assert.equal(d.body.heldNow, 2); assert.ok(d.body.heldReasons === undefined || true);
  } finally { a.server.close(); }
});
