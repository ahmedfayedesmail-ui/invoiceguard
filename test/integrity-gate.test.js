// Phase B, Issuance Integrity Gate. Tests first. Synthetic data only. Local runs unless a CI run is named.
// Principle: when the numbers in the file are uncertain, nothing is issued. The gate uses only the file's own arithmetic and consistency, never a tax rule.
// BLOCK = never issued, cannot be released. HOLD = not issued until a person records a decision tied to the exact evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVidr } from '../src/vidr.js';
import { assessShipment, releaseIntegrity } from '../src/integrity.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
import { planUpload } from '../src/manual.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').trim().split('\n');
const H = FX[0].split('\t'); const ix = (k) => H.indexOf(k);
const rowOf = (n, over = {}) => { const c = FX[1].split('\t'); while (c.length < H.length) c.push(''); c[ix('shipping-id')] = 'S' + (1001 + n); c[ix('transaction-id')] = 'S' + (1001 + n); c[ix('order-id')] = `405-33188${String(n).padStart(2, '0')}-7710365`; for (const [k, v] of Object.entries(over)) c[ix(k)] = v; return c.join('\t'); };
const file = (...rows) => [FX[0], ...rows].join('\n') + '\n';
const SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });
const NOW = new Date('2026-11-25T13:00:00Z');
const run = async (text, db = openDb()) => { const out = await processReport(db, SELLER, text, { api, validate: vies, now: NOW }); return { db, out }; };
const one = (text) => parseVidr(text)[0];
const codes = (text) => assessShipment(one(text)).findings.map(f => f.code);
const count = (db, sql) => db.prepare(sql).get().c;

test('guard: the committed clean fixture has no finding on any shipment', () => {
  const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
  for (const s of parseVidr(text)) assert.deepEqual(assessShipment(s).findings, [], s.orderId);
});
test('guard: a one-cent rounding difference is not a finding', () => {
  assert.deepEqual(codes(file(rowOf(0, { 'item-vat-amount': '8.41', 'item-vat-excl-amount': '40.00', 'item-vat-incl-amount': '48.41' }))), []);
});

const CASES = [
  ['AMOUNT_UNREADABLE', 'BLOCK', { 'item-vat-amount': '8,4x' }, 'item-vat-amount'],
  ['AMOUNT_UNREADABLE', 'BLOCK', { 'item-vat-incl-amount': 'N/A' }, 'item-vat-incl-amount'],
  ['AMOUNT_UNREADABLE', 'BLOCK', { 'shipping-vat-excl-amount': '5.0.0' }, 'shipping-vat-excl-amount'],
  ['AMOUNT_INCOMPLETE', 'HOLD', { 'item-vat-amount': '' }, 'item-vat-amount'],
  ['AMOUNT_INCONSISTENT', 'HOLD', { 'item-vat-amount': '9.40' }, 'item'],
  ['AMOUNT_INCONSISTENT', 'HOLD', { 'item-vat-incl-amount': '60.00' }, 'item'],
  ['AMOUNT_RATE_MISMATCH', 'HOLD', { 'item-vat-amount': '9.00', 'item-vat-incl-amount': '49.00' }, 'item'],
  ['QUANTITY_UNREADABLE', 'HOLD', { 'quantity-purchased': '' }, 'quantity-purchased'],
  ['QUANTITY_UNREADABLE', 'HOLD', { 'quantity-purchased': '0' }, 'quantity-purchased'],
  ['QUANTITY_UNREADABLE', 'HOLD', { 'quantity-purchased': '1.5' }, 'quantity-purchased'],
  ['QUANTITY_UNREADABLE', 'HOLD', { 'quantity-purchased': 'two' }, 'quantity-purchased'],
  ['NONPOSITIVE_TOTAL', 'BLOCK', { 'item-vat-incl-amount': '0', 'item-vat-amount': '0', 'item-vat-excl-amount': '0', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '', 'shipping-vat-rate': '' }, 'total'],
  ['NONPOSITIVE_TOTAL', 'BLOCK', { 'item-vat-incl-amount': '-48.40', 'item-vat-amount': '-8.40', 'item-vat-excl-amount': '-40.00', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '', 'shipping-vat-rate': '' }, 'total'],
  ['DATE_UNREADABLE', 'BLOCK', { 'shipment-date': 'yesterday' }, 'shipment-date'],
  ['DATE_ORDER', 'HOLD', { 'order-date': '2026-11-26T08:00:00Z' }, 'order-date'],
];
for (const [code, sev, over, field] of CASES) {
  test(`${code} (${sev}) for ${JSON.stringify(over).slice(0, 70)}`, () => {
    const a = assessShipment(one(file(rowOf(0, over))));
    const f = a.findings.find(x => x.code === code);
    assert.ok(f, `expected ${code}, got ${JSON.stringify(a.findings.map(x => x.code))}`);
    assert.equal(f.severity, sev); assert.equal(a.verdict, sev === 'BLOCK' || a.findings.some(x => x.severity === 'BLOCK') ? 'BLOCK' : 'HOLD');
    assert.ok(f.evidence.lines.includes(2), 'names the physical line of the file'); assert.equal(f.evidence.field, field);
    assert.ok(f.explanation.length > 30 && f.action.length > 15 && /^[0-9a-f]{16,}$/.test(f.fingerprint));
    const s = JSON.stringify(f); assert.ok(!/Mediterr|Calle Mayor|ESB1234|Valencia/.test(s), 'evidence carries no buyer name, address or VAT number');
  });
}
test('a rate stated as a percentage (21) is not compared and is reported as not checked, never as a mismatch', () => {
  const a = assessShipment(one(file(rowOf(0, { 'item-vat-rate': '21' }))));
  assert.ok(!a.findings.some(f => f.code === 'AMOUNT_RATE_MISMATCH')); assert.ok(a.notChecked.some(n => n.check === 'vat-vs-rate' && /unit/i.test(n.reason)));
});
for (const [field, a, b] of [['currency', 'EUR', 'USD'], ['buyer-vat-number', 'ESB12345674', 'ESB99999999'], ['shipment-date', '2026-11-24T08:00:00Z', '2026-11-25T08:00:00Z'], ['ship-country', 'ES', 'FR'], ['billing-name', 'Mediterránea Logística S.L.', 'Otra Empresa S.L.']]) {
  test(`SHIPMENT_FIELD_CONFLICT (BLOCK): rows of one shipment disagree on ${field}`, () => {
    const text = file(rowOf(0, { [field]: a }), rowOf(0, { [field]: b, sku: 'SKU-Z' }));
    const s = assessShipment(one(text)), f = s.findings.find(x => x.code === 'SHIPMENT_FIELD_CONFLICT' && x.evidence.field === field);
    assert.ok(f, JSON.stringify(s.findings.map(x => [x.code, x.evidence.field]))); assert.equal(f.severity, 'BLOCK'); assert.deepEqual(f.evidence.lines, [2, 3]);
    if (field !== 'billing-name' && field !== 'buyer-vat-number') assert.deepEqual([...f.evidence.values].sort(), [a, b].sort()); else assert.equal(f.evidence.values.length, 2);
  });
}
test('a blank buyer VAT on one row and a value on another is a conflict, not a silent pick of the first row', () => {
  assert.ok(assessShipment(one(file(rowOf(0), rowOf(0, { 'buyer-vat-number': '', sku: 'SKU-Z' })))).findings.some(f => f.code === 'SHIPMENT_FIELD_CONFLICT' && f.evidence.field === 'buyer-vat-number'));
});
test('DUPLICATE_ITEM_ROW (HOLD): the same order-item-id twice, and two identical rows with no item id', () => {
  const t1 = file(rowOf(0, { 'order-item-id': 'I1' }), rowOf(0, { 'order-item-id': 'I1', sku: 'SKU-Z' }));
  const t2 = file(rowOf(0), rowOf(0));
  for (const t of [t1, t2]) { const f = assessShipment(one(t)).findings.find(x => x.code === 'DUPLICATE_ITEM_ROW'); assert.ok(f); assert.equal(f.severity, 'HOLD'); assert.deepEqual(f.evidence.lines, [2, 3]); }
  assert.ok(!codes(file(rowOf(0, { 'order-item-id': 'I1' }), rowOf(0, { 'order-item-id': 'I2', sku: 'SKU-Z' }))).includes('DUPLICATE_ITEM_ROW'), 'guard: two different items are fine');
});
test('SPLIT_SHIPMENT is information only: two shipments of one order are never merged and never held for it', () => {
  const a = parseVidr(file(rowOf(0), rowOf(1, { 'order-id': rowOf(0).split('\t')[0] })));
  assert.equal(a.length, 2); for (const s of a) { const r = assessShipment(s); assert.deepEqual(r.findings.filter(f => f.severity !== 'INFO'), []); assert.ok(r.findings.some(f => f.code === 'SPLIT_SHIPMENT' && f.severity === 'INFO')); }
});

// ---- the real path: processReport (used by the API and the manual upload) ----
for (const [name, over] of [['unreadable amount', { 'item-vat-amount': '8,4x' }], ['inconsistent total', { 'item-vat-incl-amount': '60.00' }], ['zero quantity', { 'quantity-purchased': '0' }], ['unreadable date', { 'shipment-date': 'yesterday' }]]) {
  test(`processReport, ${name}: held with the reason, no invoice, no number burned, the clean sibling still issues`, async () => {
    const { db, out } = await run(file(rowOf(0, over), rowOf(1)));
    assert.equal(out.uploaded, 1, 'only the clean shipment is issued'); assert.equal(out.held.length, 1);
    assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1); assert.equal(db.prepare("SELECT n FROM counters").get().n, 1, 'one number used, none burned for the held one');
    assert.match(out.held[0].reason, /not issued|nothing was issued/i);
    assert.equal(db.prepare("SELECT status FROM shipments WHERE key='SHIPMENT:S1001'").get().status, 'held');
    const ev = db.prepare("SELECT detail FROM events WHERE type='integrity'").all().map(r => JSON.parse(r.detail)); assert.equal(ev.length, 1); assert.ok(ev[0].codes.length >= 1);
    const rows = db.prepare("SELECT code, severity, status FROM integrity_findings WHERE shipment_key='SHIPMENT:S1001'").all(); assert.ok(rows.length >= 1); assert.ok(rows.every(r => r.status === 'OPEN'));
  });
}
test('processReport: the same file twice makes no second finding row and no second invoice', async () => {
  const t = file(rowOf(0, { 'item-vat-amount': '8,4x' }), rowOf(1)); const { db } = await run(t); await run(t, db);
  assert.equal(count(db, "SELECT count(*) c FROM integrity_findings"), 1); assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1);
});
test('processReport: a corrected file closes the finding (RESOLVED) and then issues once', async () => {
  const db = openDb(); await run(file(rowOf(0, { 'item-vat-incl-amount': '60.00' })), db); assert.equal(count(db, "SELECT count(*) c FROM invoices"), 0);
  const { out } = await run(file(rowOf(0)), db); assert.equal(out.uploaded, 1);
  assert.equal(db.prepare("SELECT status FROM integrity_findings").get().status, 'RESOLVED'); assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1);
});
test('HOLD release: a recorded decision tied to the exact evidence lets it issue; BLOCK can never be released; changed data is held again', async () => {
  const t = file(rowOf(0, { 'item-vat-incl-amount': '60.00' })); const db = openDb(); const first = await run(t, db);
  const f = db.prepare("SELECT code, fingerprint FROM integrity_findings").get();
  assert.throws(() => releaseIntegrity(db, SELLER.id, 'SHIPMENT:S1001', f.code, 'deadbeefdeadbeef', 'seller'), /fingerprint|evidence/i, 'a decision for other evidence is refused');
  releaseIntegrity(db, SELLER.id, 'SHIPMENT:S1001', f.code, f.fingerprint, 'seller');
  assert.equal((await run(t, db)).out.uploaded, 1, 'released: issued once'); assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1);
  const db2 = openDb(); await run(file(rowOf(0, { 'item-vat-amount': '8,4x' })), db2); const b = db2.prepare("SELECT code, fingerprint FROM integrity_findings WHERE severity='BLOCK'").get();
  assert.throws(() => releaseIntegrity(db2, SELLER.id, 'SHIPMENT:S1001', b.code, b.fingerprint, 'seller'), /cannot be released|BLOCK/i);
  const db3 = openDb(); await run(t, db3); const g = db3.prepare("SELECT code, fingerprint FROM integrity_findings").get(); releaseIntegrity(db3, SELLER.id, 'SHIPMENT:S1001', g.code, g.fingerprint, 'seller');
  assert.equal((await run(file(rowOf(0, { 'item-vat-incl-amount': '61.00' })), db3)).out.uploaded, 0, 'the decision does not cover different numbers'); assert.equal(first.out.uploaded, 0);
});
test('manual preview and issue: the seller sees the held shipment before issuing, and issue creates nothing for it', async () => {
  const text = file(rowOf(0, { 'item-vat-amount': '8,4x' }), rowOf(1));
  const p = planUpload(text); assert.equal(p.ok, true); assert.equal(p.shipments.length, 1, 'one ready'); assert.equal(p.held.length, 1);
  assert.match(p.held[0].reason, /item-vat-amount/);
});
test('hostile: a formula-like or HTML-like amount cell is unreadable, never evaluated, and not echoed into the finding', () => {
  for (const v of ['=1+1', '<b>9</b>', '9;DROP', '１２.００']) { const a = assessShipment(one(file(rowOf(0, { 'item-vat-amount': v })))); const f = a.findings.find(x => x.code === 'AMOUNT_UNREADABLE'); assert.ok(f, v); assert.ok(!JSON.stringify(f).includes('DROP') && !JSON.stringify(f).includes('<b>')); }
});
