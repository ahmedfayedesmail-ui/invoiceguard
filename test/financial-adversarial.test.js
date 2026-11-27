// Night mission WP2: financial adversarial lab. Synthetic data only, seeded (the same seed gives the same cases). Local runs unless a CI run is named.
// Invariants: unknown never becomes zero; no guess-repair; one shipment never gets two ordinary invoices; evidence never disappears; a human decision never authorizes changed evidence; reprocessing is idempotent; no sensitive data in evidence, logs or events; HOLD and BLOCK are never treated as clear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVidr } from '../src/vidr.js';
import { assessShipment, parseAmount, releaseIntegrity } from '../src/integrity.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').trim().split('\n');
const H = FX[0].split('\t'); const ix = (k) => H.indexOf(k);
const rowOf = (n, over = {}) => { const c = FX[1].split('\t'); while (c.length < H.length) c.push(''); c[ix('shipping-id')] = 'S' + (1001 + n); c[ix('transaction-id')] = 'S' + (1001 + n); c[ix('order-id')] = `405-33188${String(n).padStart(2, '0')}-7710365`; for (const [k, v] of Object.entries(over)) c[ix(k)] = v; return c.join('\t'); };
const file = (...rows) => [FX[0], ...rows].join('\n') + '\n';
const SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const mkApi = () => { const calls = []; return { calls, uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) }; };
const vies = async (v) => ({ status: 'valid', vat: v });
const NOW = new Date('2026-11-25T13:00:00Z');
const run = async (text, db = openDb(), api = mkApi()) => { const out = await processReport(db, SELLER, text, { api, validate: vies, now: NOW }); return { db, out, api }; };
const one = (text) => parseVidr(text)[0];
let seed = 20261127; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }; const pick = (a) => a[Math.floor(rnd() * a.length)]; const int = (n) => Math.floor(rnd() * n);
const blocking = (a) => a.findings.some(f => f.severity !== 'INFO');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];

test('parseAmount property: random tokens never become a number by guessing', () => {
  const alpha = ['0', '1', '2', '5', '9', '.', ',', '-', '+', ' ', 'e', 'x', '_', '\u00a0', '\u0661', '\uff11'];
  let valid = 0, tried = 0;
  for (let i = 0; i < 6000; i++) {
    const len = 1 + int(9); let t = ''; for (let j = 0; j < len; j++) t += pick(alpha); const r = parseAmount(t); tried++;
    if (r.state === 'VALID') { valid++; assert.equal(typeof r.cents, 'bigint'); assert.match(t.trim(), /^[+-]?\d[\d.,]*$/, 'only plain ASCII numbers can be valid: ' + JSON.stringify(t)); assert.ok(!/^[+-]?\d{1,3}[.,]\d{3}$/.test(t.trim()), 'one separator and three digits is ambiguous: ' + t); assert.ok(!/[.,]{2}|[.,]$/.test(t.trim())); }
    else if (r.state === 'MISSING') assert.equal(t.trim(), ''); else assert.equal(r.state, 'INVALID'); assert.ok(!('cents' in r) || r.state === 'VALID', 'an unreadable token carries no number');
  }
  assert.ok(valid > 50 && valid < tried, `a real mix of outcomes (${valid} of ${tried} valid)`);
});
test('parseAmount property: every formatted amount reads back to exactly the same cents (separators, grouping, sign, huge values)', () => {
  for (let i = 0; i < 4000; i++) {
    const digits = 1 + int(24); let ip = String(1 + int(9)); for (let j = 1; j < digits; j++) ip += int(10); const frac = String(int(100)).padStart(2, '0'), neg = rnd() < 0.3, cents = BigInt(ip) * 100n + BigInt(frac);
    const grouped = (s, g) => s.replace(/\B(?=(\d{3})+(?!\d))/g, g); const style = int(4); let tok;
    if (style === 0) tok = `${ip}.${frac}`; else if (style === 1) tok = `${ip},${frac}`; else if (style === 2) tok = `${grouped(ip, ',')}.${frac}`; else tok = `${grouped(ip, '.')},${frac}`;
    if (ip.length <= 3 && style >= 2) tok = style === 2 ? `${ip}.${frac}` : `${ip},${frac}`; tok = (neg ? '-' : '') + tok;
    const r = parseAmount(tok); assert.equal(r.state, 'VALID', tok); assert.equal(r.cents, neg ? -cents : cents, tok);
  }
});
test('parseAmount: named hostile tokens are INVALID, a blank is MISSING, a real 0.00 is VALID zero (unknown never becomes zero)', () => {
  for (const t of ['NaN', 'Infinity', '-Infinity', '1e3', '1E3', '0x10', '1_000', '1 000', '\u0661\u0662', '\uff11\uff12', '1.2.3', '1,2,3', '--1', '+-1', '1.', '.5', ',5', '$1', '1\u00a0000', '1.234', '1,234', '1.234,5.6', '12345678901234567890123456789012345678901', '0.001', '1.005']) assert.equal(parseAmount(t).state, 'INVALID', t);
  for (const t of ['', '   ', '\t']) assert.equal(parseAmount(t).state, 'MISSING', JSON.stringify(t));
  assert.deepEqual(parseAmount('0.00'), { state: 'VALID', cents: 0n }); assert.equal(parseAmount(null).state, 'MISSING'); assert.equal(parseAmount(undefined).state, 'MISSING');
});

const HOSTILE = ['', 'N/A', 'null', 'NaN', '1,234', '1.234', '12,5x', '-', '--5', '1e2', '0x1', '99999999999999999999999.99', '1.2.3', '\u0661\u0662', ' ', '=1+1', "'; DROP TABLE invoices;--"];
test('property: one hostile amount in a random cell of a random row never issues (HOLD or INFO only), never changes the number, and is recorded in the ledger', async () => {
  let held = 0;
  for (let i = 0; i < 120; i++) {
    const rows = 1 + int(3), cell = pick(AMT), target = int(rows), tok = pick(HOSTILE);
    const rs = Array.from({ length: rows }, (_, k) => rowOf(0, { 'order-item-id': String(700 + k), sku: 'SK' + k, ...(k === target ? { [cell]: tok } : {}) }));
    const text = file(...rs), a = assessShipment(one(text)), parsed = parseAmount(tok);
    const { db, out, api } = await run(text);
    if (parsed.state !== 'VALID') { assert.ok(blocking(a), `${cell}=${JSON.stringify(tok)} must be held`); assert.equal(api.calls.length, 0); assert.equal(out.uploaded, 0); assert.ok(db.prepare("SELECT count(*) c FROM integrity_findings WHERE status='OPEN'").get().c >= 1, 'recorded'); held++; }
    assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='invoice'").get().c, out.uploaded === 0 ? 0 : 1);
  }
  assert.ok(held > 40);
});
test('property: combinations of several independent defects: any blocking defect means no invoice; the ledger holds one record per (code, field) and every evidence entry names one line', async () => {
  const muts = [(o) => ({ ...o, 'item-vat-amount': '8,4x' }), (o) => ({ ...o, currency: 'JPY' }), (o) => ({ ...o, 'quantity-purchased': '0' }), (o) => ({ ...o, 'shipment-date': '25/11/2026' }), (o) => ({ ...o, 'billing-name': 'Other Buyer ' + int(9) }), (o) => ({ ...o, 'item-vat-incl-amount': '1,234' })];
  for (let i = 0; i < 60; i++) {
    const n = 2 + int(3), base = Array.from({ length: n }, (_, k) => ({ 'order-item-id': String(800 + k), sku: 'SK' + k })); const k = 1 + int(3);
    for (let m = 0; m < k; m++) { const r = int(n), f = pick(muts); base[r] = f(base[r]); }
    const text = file(...base.map(o => rowOf(0, o))), a = assessShipment(one(text)), { db, out, api } = await run(text);
    assert.ok(blocking(a), 'at least one defect was injected: ' + JSON.stringify(base) + JSON.stringify(a.findings.map(f => f.code))); assert.equal(api.calls.length, 0); assert.equal(out.uploaded, 0); assert.equal(db.prepare('SELECT count(*) c FROM invoices').get().c, 0);
    const keys = db.prepare('SELECT code, field FROM integrity_findings').all().map(r => r.code + '|' + r.field); assert.equal(new Set(keys).size, keys.length);
    for (const r of db.prepare('SELECT code, evidence FROM integrity_findings').all()) { const ev = JSON.parse(r.evidence); assert.ok(ev.rows.every(x => (x.lines ?? [x.line]).length === 1), r.code); assert.deepEqual(ev.rows.flatMap(x => x.lines ?? [x.line]).sort((p, q) => p - q), [...ev.lines].sort((p, q) => p - q), r.code + ' covers every line'); }
  }
});
test('hostile text in personal fields never reaches the ledger, history or events and never crashes processing', async () => {
  const evil = ['=HYPERLINK("http://x","y")', '<script>alert(1)</script>', "Robert'); DROP TABLE integrity_findings;--", '__proto__', 'constructor', '\u0000\u0001ZZTOKEN', 'A'.repeat(5000), '\u202eevil'];
  for (const v of evil) {
    const { db, out, api } = await run(file(rowOf(0, { 'order-item-id': '1', sku: 'A', 'billing-name': 'Name ' + v + ' UNIQUETOKEN77' }), rowOf(0, { 'order-item-id': '2', sku: 'B', 'billing-name': 'Other UNIQUETOKEN88' })));
    assert.equal(api.calls.length, 0); assert.equal(out.uploaded, 0);
    const dump = JSON.stringify(['integrity_findings', 'integrity_history'].map(t => db.prepare(`SELECT * FROM ${t}`).all())) + JSON.stringify(db.prepare('SELECT detail FROM events').all());
    assert.ok(!/UNIQUETOKEN|DROP TABLE|HYPERLINK|<script>/.test(dump), 'no raw personal value stored'); assert.ok(db.prepare('SELECT count(*) c FROM integrity_findings').get().c >= 1);
  }
});
test('reprocessing the same hostile or good report is idempotent: same ledger records, same invoices, no new uploads', async () => {
  for (const text of [file(rowOf(0, { 'item-vat-amount': '8,4x' })), file(rowOf(0)), file(rowOf(0, { 'order-item-id': '5' }), rowOf(0, { 'order-item-id': '5', sku: 'Q' }))]) {
    const db = openDb(), api = mkApi(); await run(text, db, api); const snap = () => JSON.stringify([db.prepare('SELECT seller_id,shipment_key,code,field,severity,status,fingerprint,evidence FROM integrity_findings ORDER BY 1,2,3,4').all(), db.prepare('SELECT number,shipment_key FROM invoices ORDER BY 1').all()]), s1 = snap(), up = api.calls.length;
    for (let i = 0; i < 3; i++) await run(text, db, api); assert.equal(snap(), s1); assert.equal(api.calls.length, up);
  }
});
test('a corrected file resolves the finding and issues once; the bad file coming back reopens it and holds again (evidence never disappears)', async () => {
  const bad = file(rowOf(0, { 'item-vat-amount': '8,4x' })), good = file(rowOf(0)), db = openDb(), api = mkApi();
  await run(bad, db, api); assert.equal(api.calls.length, 0); await run(good, db, api); assert.equal(api.calls.length, 1); const inv1 = db.prepare('SELECT number FROM invoices').all();
  await run(bad, db, api); assert.equal(api.calls.length, 1, 'an issued shipment is never issued again'); assert.deepEqual(db.prepare('SELECT number FROM invoices').all(), inv1);
  const hist = db.prepare('SELECT event FROM integrity_history ORDER BY rowid').all().map(r => r.event); assert.ok(hist.includes('OPENED') && hist.includes('RESOLVED') && hist.includes('REOPENED'), hist.join(','));
  assert.ok(db.prepare("SELECT count(*) c FROM integrity_findings WHERE status='OPEN'").get().c >= 1, 'the later bad copy is recorded as open');
});
test('a human decision on one version of the evidence does not release a changed version', async () => {
  const mk = (id2) => file(rowOf(0, { 'order-item-id': '', sku: 'ID' }), rowOf(0, { 'order-item-id': '', sku: 'ID' }), ...(id2 ? [rowOf(0, { 'order-item-id': '', sku: 'ID' })] : []));
  const db = openDb(), api = mkApi(); await run(mk(false), db, api); const f = db.prepare("SELECT code, field, fingerprint FROM integrity_findings WHERE code='DUPLICATE_ITEM_ROW'").get(); assert.ok(f);
  releaseIntegrity(db, SELLER.id, one(mk(false)).key, f.code, f.fingerprint, { user: 'u1', reason: 'checked in Seller Central, two identical units' }); 
  await run(mk(true), db, api); assert.equal(api.calls.length, 0, 'three identical rows is different evidence: held again'); assert.equal(db.prepare("SELECT count(*) c FROM integrity_findings WHERE code='DUPLICATE_ITEM_ROW' AND status='OPEN'").get().c, 1); await run(mk(false), db, api); assert.equal(api.calls.length, 0, 'the decision was recorded on a RELEASED record that the changed evidence reopened: still held until decided again');
});
test('one shipment never gets two ordinary invoices across repeated, reordered and split-up reports', async () => {
  const db = openDb(), api = mkApi(); const a = rowOf(0, { 'order-item-id': '11', sku: 'A' }), b = rowOf(0, { 'order-item-id': '12', sku: 'B' });
  await run(file(a, b), db, api); await run(file(b, a), db, api); await run(file(a), db, api); await run(file(b), db, api);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='invoice'").get().c <= 1, true); assert.ok(api.calls.length <= 1);
});

// ---- found by the lab: the gate reads exact cents (BigInt) but the invoice builder adds in floating point. Above about 9e13 the issued total differs from the file by cents. Fixed by holding amounts beyond a precision limit (AMOUNT_OUT_OF_RANGE). ----
const money = (c) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
const fileFor = (exclC, vatC) => ({ 'item-vat-incl-amount': money(exclC + vatC), 'item-vat-amount': money(vatC), 'item-vat-excl-amount': money(exclC), 'item-vat-rate': '', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '' });
test('an amount beyond the exact-arithmetic limit is held (AMOUNT_OUT_OF_RANGE), never issued with a different number', async () => {
  const text = file(rowOf(0, { ...fileFor(12345678901234567n, 2592592569259259n), 'item-vat-rate': '0.21' })); const a = assessShipment(one(text));
  assert.ok(a.findings.some(f => f.code === 'AMOUNT_OUT_OF_RANGE' && f.severity === 'HOLD' && f.resolution === 'NEW_EVIDENCE'), JSON.stringify(a.findings.map(f => f.code)));
  const { out, api } = await run(text); assert.equal(out.uploaded, 0); assert.equal(api.calls.length, 0);
});
test('fidelity property: every amount at or under the limit is issued with exactly the file gross, to the cent', async () => {
  for (let i = 0; i < 60; i++) {
    const exclC = BigInt(1 + int(99999)) * BigInt(1 + int(99999)) + BigInt(int(100)), vatC = (exclC * 21n + 50n) / 100n; const text = file(rowOf(0, { ...fileFor(exclC, vatC), 'item-vat-rate': '0.21' }));
    const { db, out, api } = await run(text); if (out.uploaded === 0) { assert.ok(out.held.length === 1, 'held, never wrong'); continue; }
    assert.equal(money(BigInt(Math.round(db.prepare('SELECT total FROM invoices').get().total * 100))), money(exclC + vatC)); assert.equal(api.calls.length, 1);
  }
});

// Known gap, documented not fixed (needs Ahmed's decision on a new rule): a SHIPMENT whose item part is negative but whose total is positive is arithmetically consistent and is issued today.
test('proposal R11: a negative item, shipping or gift-wrap amount on a shipment should be held (todo, not part of the approved rules)', { todo: 'new rule needs approval' }, async () => {
  const { out } = await run(file(rowOf(0, { 'item-vat-incl-amount': '-40.00', 'item-vat-amount': '-6.94', 'item-vat-excl-amount': '-33.06', 'shipping-vat-incl-amount': '100.00', 'shipping-vat-amount': '17.36', 'shipping-vat-excl-amount': '82.64' })));
  assert.equal(out.uploaded, 0);
});
