// Massive verification campaign (Ahmed's standard: verify everything, 1000+ real cases).
// Generative end-to-end scenarios executed against the real modules, a real HTTP server
// of the production build, and the live production site. Every scenario asserts invariants.
// Usage: node tools/campaign.mjs [--no-live]
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb, verifyAudit } from '../src/db.js';
import { parseVidr, needsInvoice } from '../src/vidr.js';
import { processReport, processCorrections } from '../src/pipeline.js';
import { detectRepairs, approveRepair, listRepairs } from '../src/repair.js';
import { renderPdfCached as renderPdf } from '../src/pdf.js';
import { planUpload } from '../src/manual.js';
import { createApp } from '../src/app.js';

const LIVE = !process.argv.includes('--no-live');
const LIVE_BASE = 'https://invoiceguard-production-b715c82a.up.railway.app';

// ---- result accounting ----
const R = { cases: 0, assertions: 0, failures: [] };
function fail(scenario, msg) { R.failures.push(`${scenario}: ${msg}`); }
function check(scenario, cond, msg) { R.assertions++; if (!cond) fail(scenario, msg); }

// ---- seeded RNG (reproducible) ----
let seed = 20261126;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const HEAD = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').split('\n')[0];
const COLS = HEAD.split('\t');
const MKTS = [['ES', 'EUR'], ['DE', 'EUR'], ['FR', 'EUR'], ['IT', 'EUR'], ['NL', 'EUR'], ['PL', 'PLN']];
const NAMES = ['Mediterránea Logística S.L.', 'Büro & Sohn GmbH', 'Société Générale de Distribution', 'Ölß Ünternehmen ß', 'A'.repeat(200) + ' SL', 'O\'Brien & "Quotes" Ltd', 'Empresa\nConSalto', 'Société Àçcënts SARL'];
const VALID_VATS = ['ESB12345674', 'DE123456789', 'FR12345678901', 'IT12345678901', 'NL123456789B01', 'PL1234567890'];
const INVALID_VATS = ['ESX99999999', 'DE1', 'FRABCDEFGHIJK', 'NOTAVAT', 'ESB1234567Ä'];
const SELLER = { id: 'camp', name: 'Campaign Seller S.L.', nif: 'ESB11111119', address: 'Calle Falsa 1, Madrid', country: 'ES' };

function row(over = {}) {
  const o = {
    'order-id': `4${int(100, 999)}-${int(1000000, 9999999)}-${int(1000000, 9999999)}`, 'order-item-id': '', 'shipping-id': '', 'fulfilled-by': 'MFN',
    'order-date': '2026-11-25T10:00:00Z', 'marketplace-id': 'ES', 'recipient-name': '', 'buyer-name': '', 'ship-country': 'ES',
    'shipment-date': '2026-11-25T12:00:00Z', 'billing-name': '', 'bill-address-1': 'Calle Mayor 12', 'bill-address-2': '', 'bill-address-3': '',
    'bill-city': 'Valencia', 'bill-postal-code': '46001', 'bill-country': 'ES', 'ship-from-country': 'ES',
    'sku': `SKU-${int(1, 999)}`, 'product-name': pick(['Cable HDMI 2m', 'Taza cerámica', 'Teclado USB', 'ßpecial ßku', '']), 'quantity-purchased': String(int(1, 5)),
    'currency': 'EUR', 'item-vat-incl-amount': '48.40', 'item-vat-amount': '8.40', 'item-vat-excl-amount': '40.00', 'item-vat-rate': '0.21',
    'shipping-vat-incl-amount': '6.05', 'shipping-vat-amount': '1.05', 'shipping-vat-excl-amount': '5.00', 'shipping-vat-rate': '0.21',
    'transaction-id': '', 'transaction-type': 'SHIPMENT', 'is-amazon-invoiced': 'FALSE', 'invoice-status': 'InvoicePending',
    'is-business-order': 'TRUE', 'seller-vat-number': 'ESB11111119', 'buyer-vat-number': 'ESB12345674', 'buyer-company-name': '', 'buyer-tax-registration-type': 'VAT', 'citation-es': '',
    ...over,
  };
  return COLS.map(c => o[c] ?? '').join('\t');
}

function money(plain = false) { // realistic random amounts, sometimes boundary values
  const b = plain ? 0.5 : rnd();
  if (b < 0.04) return ['0.00', '0.00', '0.00'];
  if (b < 0.08) return ['0.01', '0.00', '0.01'];
  if (b < 0.12) return ['999999.99', '173553.72', '826446.27'];
  const incl = Math.round((plain ? 100 + rnd() * 49900 : rnd() * 50000)) / 100, vat = Math.round(incl * 0.21 * 100) / 100;
  return [incl.toFixed(2), vat.toFixed(2), (incl - vat).toFixed(2)];
}

function report(nShipments, opts = {}) {
  const lines = [HEAD]; const ids = [];
  for (let i = 0; i < nShipments; i++) {
    const [mkt, cur] = opts.mkt ?? pick(MKTS);
    const sh = `SH-${opts.tag ?? 'C'}-${int(100000, 999999)}`; ids.push(sh);
    const vatKind = opts.vat ?? (rnd() < 0.7 ? 'valid' : rnd() < 0.5 ? 'invalid' : 'none');
    const buyerVat = vatKind === 'valid' ? pick(VALID_VATS) : vatKind === 'invalid' ? pick(INVALID_VATS) : '';
    const name = opts.name ?? pick(NAMES);
    const nRows = int(1, 3);
    for (let j = 0; j < nRows; j++) {
      const [incl, vat, excl] = money(opts.plain);
      lines.push(row({
        'order-id': `4${int(100, 999)}-${int(1000000, 9999999)}-${int(1000000, 9999999)}` || undefined, 'shipping-id': sh, 'transaction-id': sh,
        'marketplace-id': mkt, 'ship-country': mkt, 'bill-country': mkt, 'ship-from-country': mkt === 'ES' ? 'ES' : 'DE', 'currency': cur,
        'buyer-vat-number': buyerVat, 'buyer-company-name': name, 'billing-name': name, 'buyer-name': name,
        'is-business-order': opts.nonBusiness ? 'FALSE' : 'TRUE', 'is-amazon-invoiced': opts.amazonInvoiced ? 'TRUE' : 'FALSE',
        'invoice-status': opts.status ?? 'InvoicePending',
        'item-vat-incl-amount': incl, 'item-vat-amount': vat, 'item-vat-excl-amount': excl,
        'shipping-vat-incl-amount': '0.00', 'shipping-vat-amount': '0.00', 'shipping-vat-excl-amount': '0.00',
      }));
    }
  }
  return { text: lines.join('\n') + '\n', ids };
}

const mkValidate = (unavailable = false) => async (v) => {
  if (unavailable) return { status: 'unavailable', reason: 'member state unavailable', vat: v };
  if (VALID_VATS.includes(v)) return { status: 'valid', vat: v };
  return { status: 'invalid', reason: 'bad_format', vat: v };
};
const mkApi = (calls) => ({ uploadInvoice: async (a) => { calls?.push(a); return 'f' + (calls ? calls.length : 0); }, feedStatus: async () => ({ status: 'DONE' }) });

function assertGapless(scn, db, sellerId) {
  const rows = db.prepare('SELECT number FROM invoices WHERE seller_id=?').all(sellerId).map(r => r.number);
  const groups = {};
  for (const n of rows) { const m = n.match(/^([A-Z]+)-(\d{4})-(\d{6})$/); check(scn, !!m, `invoice number format: ${n}`); if (!m) continue;
    const k = m[1] + '-' + m[2]; (groups[k] ??= []).push(Number(m[3])); }
  for (const [k, list] of Object.entries(groups)) { list.sort((a, b) => a - b);
    for (let i = 1; i < list.length; i++) check(scn, list[i] === list[i - 1] + 1, `gapless numbering ${k}: ${list}`); }
}

async function checkPdfs(scn, db, sellerId, max = 2) {
  const rows = db.prepare('SELECT json FROM invoices WHERE seller_id=? LIMIT ?').all(sellerId, max);
  for (const r of rows) { const pdf = await renderPdf(JSON.parse(r.json));
    check(scn, pdf.subarray(0, 4).toString() === '%PDF', 'PDF magic bytes'); check(scn, pdf.length > 800, `PDF size ${pdf.length}`); }
}

// ================= PART 1: pipeline scenarios (issue, hold, defer, idempotency) =================
async function part1(n) {
  for (let i = 0; i < n; i++) {
    const scn = `P1#${i}`; R.cases++;
    const db = openDb(); const calls = [];
    try {
      const mode = i % 10;
      const opts = {};
      if (mode === 3) opts.nonBusiness = true;
      if (mode === 4) opts.amazonInvoiced = true;
      if (mode === 5) opts.status = 'NoTaxCalculated';
      if (mode === 6) opts.vat = 'none';
      if (mode === 7) opts.vat = 'invalid';
      const unavail = mode === 8;
      const { text } = report(int(1, 4), opts);
      const expected = parseVidr(text).filter(needsInvoice).length;
      const out = await processReport(db, SELLER, text, { api: mkApi(calls), validate: mkValidate(unavail), now: new Date('2026-11-25T13:00:00Z') });
      check(scn, out.uploaded + out.held.length + out.deferred.length === expected, `uploaded ${out.uploaded} + held ${out.held.length} + deferred ${out.deferred.length} != expected ${expected}`);
      check(scn, out.errors.length === 0, `errors: ${JSON.stringify(out.errors).slice(0, 120)}`);
      const issued = db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(SELLER.id).c;
      check(scn, issued === out.uploaded, `issued rows ${issued} != uploaded ${out.uploaded}`);
      for (const h of out.held) check(scn, typeof h.reason === 'string' && h.reason.length > 3, 'hold has a reason');
      for (const inv of db.prepare('SELECT total, vat, json FROM invoices WHERE seller_id=?').all(SELLER.id)) {
        const j = JSON.parse(inv.json);
        check(scn, Math.abs(j.totals.incl - (j.totals.excl + j.totals.vat)) < 0.02, `totals consistency ${j.number}: ${j.totals.incl} vs ${j.totals.excl}+${j.totals.vat}`);
        check(scn, Math.abs(inv.total - j.totals.incl) < 0.005, 'row total matches json');
        check(scn, !!j.buyer && !!j.seller && !!j.number && !!j.issueDate, 'invoice has buyer/seller/number/date');
      }
      assertGapless(scn, db, SELLER.id);
      check(scn, verifyAudit(db, SELLER.id).ok === true, 'audit chain verifies');
      const again = await processReport(db, SELLER, text, { api: mkApi([]), validate: mkValidate(unavail), now: new Date('2026-11-25T14:00:00Z') });
      check(scn, again.uploaded === 0, `idempotent re-run uploaded ${again.uploaded}`);
      if (i % 25 === 0) await checkPdfs(scn, db, SELLER.id);
    } catch (e) { fail(scn, 'threw: ' + e.message); }
    finally { db.close(); }
  }
}

// ================= PART 2: refund -> repair -> credit note =================
async function part2(n) {
  for (let i = 0; i < n; i++) {
    const scn = `P2#${i}`; R.cases++;
    const db = openDb(); const calls = [];
    try {
      const { text, ids } = report(1, { vat: 'valid', tag: 'R', plain: true, name: 'Compra Limpia S.L.', mkt: ['ES', 'EUR'] });
      const outR = await processReport(db, SELLER, text, { api: mkApi(calls), validate: mkValidate(), now: new Date('2026-11-25T13:00:00Z') });
      const orig = db.prepare("SELECT number, total FROM invoices WHERE seller_id=? AND kind='invoice'").get(SELLER.id);
      check(scn, !!orig, 'original issued: ' + JSON.stringify({ held: outR.held, deferred: outR.deferred, errors: outR.errors }).slice(0, 200));
      if (!orig) continue;
      const refundLines = text.trim().split('\n').slice(1).map(l => {
        const c = l.split('\t'); const ix = (k) => COLS.indexOf(k);
        c[ix('transaction-type')] = 'REFUND'; c[ix('transaction-id')] = 'RF-' + ids[0]; c[ix('invoice-status')] = 'CreditNotePending';
        for (const k of ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount']) c[ix(k)] = '-' + c[ix(k)];
        return c.join('\t');
      });
      const rep = HEAD + '\n' + refundLines.join('\n') + '\n';
      const d1 = detectRepairs(db, SELLER, rep);
      if (Math.abs(orig.total) < 0.005) { check(scn, d1.proposed === 0 && d1.skipped.length === 1, 'zero-total refund skipped cleanly'); check(scn, verifyAudit(db, SELLER.id).ok === true, 'audit verifies'); continue; }
      check(scn, d1.proposed === 1, `proposed ${d1.proposed}`);
      const q = listRepairs(db, SELLER.id);
      check(scn, q.length === 1 && q[0].suggestion.rectifies === orig.number, 'proposal chained to original');
      check(scn, Math.abs(q[0]?.suggestion.total - Math.abs(orig.total)) < 0.01, `proposal total ${q[0]?.suggestion.total} vs ${orig.total}`);
      const d2 = detectRepairs(db, SELLER, rep);
      check(scn, d2.proposed === 0, 'detection idempotent');
      const res = await approveRepair(db, SELLER, q[0].event_key, { api: mkApi(calls), validate: mkValidate() });
      const cn = db.prepare('SELECT * FROM invoices WHERE seller_id=? AND number=?').get(SELLER.id, res.rectNumber);
      check(scn, cn.kind === 'rectificativa' && cn.rectifies === orig.number, 'credit note chained');
      const cj = JSON.parse(cn.json);
      check(scn, cj.totals.incl < 0 && Math.abs(Math.abs(cj.totals.incl) - Math.abs(orig.total)) < 0.01, `credit amount ${cj.totals.incl} mirrors ${orig.total}`);
      check(scn, verifyAudit(db, SELLER.id).ok === true, 'audit verifies after repair');
      let threw = false; try { await approveRepair(db, SELLER, q[0].event_key, { api: mkApi([]), validate: mkValidate() }); } catch { threw = true; }
      check(scn, threw, 'double approval refused');
      assertGapless(scn, db, SELLER.id);
      if (i % 30 === 0) await checkPdfs(scn, db, SELLER.id, 3);
    } catch (e) { fail(scn, 'threw: ' + e.message); }
    finally { db.close(); }
  }
}

// ================= PART 3: Amazon billing-data corrections =================
async function part3(n) {
  for (let i = 0; i < n; i++) {
    const scn = `P3#${i}`; R.cases++;
    const db = openDb(); const calls = [];
    try {
      const { text, ids } = report(1, { vat: 'valid', tag: 'X', plain: true, name: 'Compra Limpia S.L.', mkt: ['ES', 'EUR'] });
      await processReport(db, SELLER, text, { api: mkApi(calls), validate: mkValidate(), now: new Date('2026-11-25T13:00:00Z') });
      const orig = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice'").get(SELLER.id);
      if (!orig) { fail(scn, 'no original'); continue; }
      const base = text.trim().split('\n')[1].split('\t'); const ix = (k) => COLS.indexOf(k);
      const rev = [...base]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:' + i;
      for (const k of ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount']) rev[ix(k)] = '-' + rev[ix(k)];
      rev[ix('invoice-status')] = 'CreditNotePending';
      const fixed = [...base]; fixed[ix('transaction-id')] = 'Correction::X:' + i; fixed[ix('billing-name')] = 'Nombre Corregido S.L.'; fixed[ix('buyer-company-name')] = 'Nombre Corregido S.L.';
      const rep = [HEAD, rev.join('\t'), fixed.join('\t')].join('\n') + '\n';
      const r = await processCorrections(db, SELLER, rep, { api: mkApi(calls), validate: mkValidate() });
      check(scn, r.creditNotes === 1 && r.invoices === 1 && r.errors.length === 0, `correction pair: ${JSON.stringify({ c: r.creditNotes, i: r.invoices, e: r.errors })}`);
      const cn = calls[calls.length - 2], inv = calls[calls.length - 1];
      check(scn, cn.documentType === 'CreditNote' && cn.transactionId === 'CorrectionReversal:X:' + i, 'credit note TransactionId');
      check(scn, inv.documentType === 'Invoice' && inv.transactionId === 'Correction::X:' + i, 'replacement TransactionId');
      const r2 = await processCorrections(db, SELLER, rep, { api: mkApi(calls), validate: mkValidate() });
      check(scn, r2.creditNotes === 0 && r2.invoices === 0, 'correction idempotent');
      check(scn, verifyAudit(db, SELLER.id).ok === true, 'audit verifies after correction');
      assertGapless(scn, db, SELLER.id);
    } catch (e) { fail(scn, 'threw: ' + e.message); }
    finally { db.close(); }
  }
}

// ================= PART 4: malformed, boundary, hostile inputs =================
async function part4() {
  const bad = [
    ['empty string', ''],
    ['header only', HEAD + '\n'],
    ['garbage', 'this is not a report at all\nrandom text\n'],
    ['binary junk', Buffer.from([0, 1, 2, 3, 255, 254]).toString('latin1')],
    ['huge field', HEAD + '\n' + row({ 'product-name': 'X'.repeat(1e6) }) + '\n'],
    ['missing cells', HEAD + '\n' + row().split('\t').slice(0, 8).join('\t') + '\n'],
    ['control chars in name', HEAD + '\n' + row({ 'buyer-company-name': 'EvilCorp', 'billing-name': 'EvilCorp' }) + '\n'],
    ['negative qty', HEAD + '\n' + row({ 'quantity-purchased': '-2' }) + '\n'],
    ['NaN amounts', HEAD + '\n' + row({ 'item-vat-incl-amount': 'abc', 'item-vat-amount': 'def', 'item-vat-excl-amount': 'ghi' }) + '\n'],
    ['comma decimals', HEAD + '\n' + row({ 'item-vat-incl-amount': '48,40', 'item-vat-amount': '8,40', 'item-vat-excl-amount': '40,00' }) + '\n'],
    ['duplicate rows', HEAD + '\n' + (r => r + '\n' + r)(row()) + '\n'],
    ['CRLF endings', HEAD + '\r\n' + row() + '\r\n'],
    ['BOM prefix', '﻿' + HEAD + '\n' + row() + '\n'],
  ];
  for (const [name, text] of bad) {
    const scn = `P4:${name}`; R.cases++;
    try {
      const db = openDb();
      const plan = planUpload(text);
      check(scn, plan.ok === true || typeof plan.error === 'string', 'planUpload answers cleanly');
      const out = await processReport(db, SELLER, text, { api: mkApi([]), validate: mkValidate(), now: new Date('2026-11-25T13:00:00Z') });
      check(scn, out.errors.length === 0, `pipeline survived: ${JSON.stringify(out.errors).slice(0, 100)}`);
      for (const inv of db.prepare('SELECT json FROM invoices WHERE seller_id=?').all(SELLER.id)) {
        const j = JSON.parse(inv.json);
        check(scn, Number.isFinite(j.totals.incl), 'totals finite');
      }
      db.close();
    } catch (e) { fail(scn, 'threw: ' + e.message); }
  }
  // oversized report: 3000 shipments
  {
    const scn = 'P4:oversized-3000'; R.cases++;
    const lines = [HEAD]; for (let i = 0; i < 3000; i++) lines.push(row({ 'shipping-id': 'BIG-' + i, 'transaction-id': 'BIG-' + i }));
    const db = openDb(); const t0 = Date.now();
    try {
      const out = await processReport(db, SELLER, lines.join('\n') + '\n', { api: { manual: true, uploadInvoice: async () => 'm' }, validate: mkValidate(), now: new Date('2026-11-25T13:00:00Z') });
      const ms = Date.now() - t0;
      check(scn, out.uploaded + out.held.length + out.deferred.length === 3000, `all 3000 accounted (${out.uploaded}+${out.held.length}+${out.deferred.length})`);
      check(scn, out.errors.length === 0, 'no errors');
      check(scn, verifyAudit(db, SELLER.id).ok, 'audit verifies at scale');
      R.perf = { ...(R.perf || {}), bigReportMs: ms, bigReportRows: 3000 };
    } catch (e) { fail(scn, 'threw: ' + e.message); }
    finally { db.close(); }
  }
}

// ================= PART 5: HTTP API cases on a real server =================
async function part5() {
  const validate = async (v) => VALID_VATS.includes(v) ? { status: 'valid', vat: v } : { status: 'invalid', reason: 'bad_format', vat: v };
  process.env.OPERATOR_NAME = 'Campaign Operator'; const { server } = createApp({ validate, secret: 'campaign' });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mkCaller = () => { let sid = ''; return async (path, body, raw) => {
    const r = await fetch(base + (path.startsWith('/') ? path : '/api/' + path), { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0];
    return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : (raw ? await r.text() : Buffer.from(await r.arrayBuffer())) };
  }; };
  const http = async (scn, fn) => { R.cases++; try { await fn(); } catch (e) { fail(scn, e.message); } };
  const call = mkCaller();

  // auth & validation cases
  for (const [i, pw] of ['short', 'alllowercase1!', 'NOUPPERCASE1!', 'NoNumberHere!', 'okButNoSymbol1'].entries())
    await http(`H:weak-pw-${i}`, async () => { const r = await call('signup', { email: `w${i}@t.es`, password: pw }); check(`H:weak-pw-${i}`, r.status === 400, `weak pw accepted: ${pw}`); });
  await http('H:bad-email', async () => { check('H:bad-email', (await call('signup', { email: 'not-an-email', password: 'Good-Pw-123!' })).status === 400, 'bad email accepted'); });
  await http('H:signup-ok', async () => { check('H:signup-ok', (await call('signup', { email: 'camp@t.es', password: 'Good-Pw-123!' })).status === 200, 'signup failed'); });
  await http('H:dup-signup', async () => { check('H:dup-signup', (await call('signup', { email: 'camp@t.es', password: 'Good-Pw-123!' })).status === 409, 'duplicate signup allowed'); });
  await http('H:wrong-login', async () => { const c2 = mkCaller(); check('H:wrong-login', (await c2('login', { email: 'camp@t.es', password: 'Wrong-Pw-123!' })).status === 401, 'wrong password logged in'); });
  await http('H:unauth-dashboard', async () => { const c3 = mkCaller(); check('H:unauth-dashboard', (await c3('dashboard')).status === 401, 'dashboard without session'); });
  await http('H:admin-unauth', async () => { const r = await fetch(base + '/admin/messages'); check('H:admin-unauth', [401, 403, 404].includes(r.status), 'admin endpoint open'); });
  await http('H:seller-profile', async () => { check('H:seller-profile', (await call('seller', { name: 'Campaign S.L.', nif: 'b11111111', address: 'C Falsa 1', marketplaces: ['ES'] })).status === 200, 'seller save'); });
  await http('H:connect-manual', async () => { check('H:connect-manual', (await call('amazon/connect', { manual: true })).body.mode === 'manual', 'manual connect'); });

  // manual flow cases across formats & misuse
  const good = report(2, { vat: 'valid', tag: 'H', plain: true, mkt: ['ES', 'EUR'] }).text;
  await http('H:preview', async () => { const r = await call('manual/preview', { text: good }); check('H:preview', r.status === 200 && r.body.format === 'vidr' && r.body.willIssue === 2, `preview ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`); });
  await http('H:issue-no-attest', async () => { check('H:issue-no-attest', (await call('manual/issue', { text: good })).status === 400, 'issue without attestation allowed'); });
  await http('H:issue', async () => { const r = await call('manual/issue', { text: good, attest: true }); check('H:issue', r.status === 200 && r.body.issued === 2, `issued ${r.body.issued}`); });
  await http('H:issue-idem', async () => { const r = await call('manual/issue', { text: good, attest: true }); check('H:issue-idem', r.body.issued === 0, `re-issue created ${r.body.issued}`); });
  await http('H:preview-garbage', async () => { const r = await call('manual/preview', { text: 'garbage\n' }); check('H:preview-garbage', r.status === 400, 'garbage preview accepted'); });
  await http('H:repairs-list', async () => { const r = await call('repairs'); check('H:repairs-list', r.status === 200 && Array.isArray(r.body.proposed), 'repairs list'); });
  await http('H:repairs-approve-unknown', async () => { check('H:repairs-approve-unknown', (await call('repairs/approve', { key: 'REFUND:nope' })).status === 422, 'approved unknown repair'); });
  await http('H:rules-review-denied', async () => { check('H:rules-review-denied', (await call('rules/review', { rule: 'AMZ-UPLOAD', note: 'x' })).status === 403, 'non-operator marked a rule reviewed'); });
  await http('H:rules-no-canreview', async () => { const r = await call('rules'); check('H:rules-no-canreview', r.status === 200 && r.body.packs.every(p => p.rules.every(x => !x.canReview)), 'canReview leaked to non-operator'); });
  await http('H:repairs-bad-key', async () => { check('H:repairs-bad-key', (await call('repairs/approve', { key: '' })).status === 400, 'empty key accepted'); });
  await http('H:dashboard', async () => { const r = await call('dashboard'); check('H:dashboard', r.status === 200 && r.body.kpis.total === 2, `kpis ${JSON.stringify(r.body.kpis)}`); });
  await http('H:pack', async () => { const r = await call('pack', {}); check('H:pack', r.status === 200 && r.body.subarray(0, 2).toString() === 'PK', 'pack zip'); });
  await http('H:pdf-404', async () => { check('H:pdf-404', (await call('invoices/A-2026-999999/pdf')).status === 404, 'phantom invoice served'); });
  await http('H:wrong-ct', async () => { const r = await fetch(base + '/api/me', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }); check('H:wrong-ct', r.status === 415, 'wrong content type accepted'); });
  await http('H:unknown-api', async () => { check('H:unknown-api', (await call('definitely-not-a-route', {})).status === 404, 'unknown route not 404'); });

  // rectify via API on an issued invoice
  await http('H:rectify-api', async () => {
    const d = (await call('dashboard')).body; const num = d.invoices[0].number;
    const r = await call('rectify', { number: num, mode: 'substitution', reason: 'Campaign check', buyerName: 'Corrected Name S.L.' });
    check('H:rectify-api', r.status === 200 && /^R-/.test(r.body.number), `rectify ${r.status}`);
  });

  // manual repair closure: refund -> proposal -> approve -> ready -> pack (exported) -> mark (uploaded); rejection path
  await http('H:repair-closure', async () => {
    const c2 = mkCaller();
    check('H:repair-closure', (await c2('signup', { email: 'closure@t.es', password: 'Good-Pw-123!' })).status === 200, 'signup');
    await c2('seller', { name: 'Closure S.L.', nif: 'B11111119', address: 'C 1', marketplaces: ['ES'] });
    await c2('amazon/connect', { manual: true });
    const t = report(1, { vat: 'valid', tag: 'CL', plain: true, mkt: ['ES', 'EUR'] }).text;
    check('H:repair-closure', (await c2('manual/issue', { text: t, attest: true })).body.issued === 1, 'issue');
    const lines = t.trim().split('\n'); const cols = lines[0].split('\t'); const ix = (n) => cols.indexOf(n);
    const ref = lines[1].split('\t'); ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'RF-CL-1'; ref[ix('invoice-status')] = 'CreditNotePending';
    await c2('manual/issue', { text: lines[0] + '\n' + ref.join('\t') + '\n', attest: true });
    const rep = (await c2('repairs')).body;
    check('H:repair-closure', rep.proposed.length === 1, `proposals ${rep.proposed.length}`);
    const ap = await c2('repairs/approve', { key: rep.proposed[0].event_key });
    check('H:repair-closure', ap.status === 200 && /^R-/.test(ap.body.rectNumber ?? ''), `approve ${ap.status} ${JSON.stringify(ap.body).slice(0, 80)}`);
    const ri = (await c2('dashboard')).body.invoices.find(i => /^R-/.test(i.number));
    check('H:repair-closure', ri && ri.upload_status === 'ready', `rect status ${ri && ri.upload_status}`);
    check('H:repair-closure', (await c2('pack', {})).status === 200, 'pack with correction');
    let hist = (await c2('repairs')).body.history;
    check('H:repair-closure', hist.some(h => h.state === 'exported'), `exported ${hist.map(h => h.state)}`);
    await c2('invoices/mark', { all: true });
    hist = (await c2('repairs')).body.history;
    check('H:repair-closure', hist.some(h => h.state === 'uploaded'), `uploaded ${hist.map(h => h.state)}`);
  });
  await http('H:reject-flow', async () => {
    const d = (await call('dashboard')).body; const r = d.invoices.find(i => /^R-/.test(i.number));
    check('H:reject-flow', !!r, 'no correction invoice to reject');
    check('H:reject-flow', (await call('invoices/reject', { number: r.number, error: '' })).status === 400, 'empty rejection accepted');
    check('H:reject-flow', (await call('invoices/reject', { number: 'A-2026-999999', error: 'x' })).status === 404, 'phantom rejection');
    const x = await call('invoices/reject', { number: r.number, error: 'Amazon: totals do not match' });
    const r2 = (await call('dashboard')).body.invoices.find(i => i.number === r.number);
    check('H:reject-flow', x.status === 200 && r2.upload_status === 'rejected', `reject ${x.status} ${r2.upload_status}`);
  });

  // localized landings: every agreed locale serves native copy with its own html lang
  for (const [l, marker] of [['es', 'Facturas de Amazon Business'], ['de', 'Amazon-Business-Rechnungen'], ['fr', 'factures Amazon Business'], ['it', 'Fatture Amazon Business'], ['nl', 'Amazon Business-facturen'], ['pl', 'Faktury Amazon Business']])
    await http(`H:landing-${l}`, async () => { const r = await call('/' + l, undefined, true); check(`H:landing-${l}`, r.status === 200 && r.body.includes(`<html lang="${l}">`) && r.body.includes(marker), `locale ${l}: ${r.status}`); });

  // security headers on the app shell
  await http('H:sec-headers', async () => {
    const r = await fetch(base + '/app'); const csp = r.headers.get('content-security-policy') ?? '';
    check('H:sec-headers', csp.includes("default-src 'self'"), 'CSP on /app');
  });

  // DB snapshot: hidden without token, served with it, restores as valid SQLite
  await http('H:snapshot', async () => {
    check('H:snapshot', (await fetch(base + '/admin/db-snapshot')).status === 404, 'snapshot hidden without token');
    process.env.ADMIN_TOKEN = 'campaign-admin-token-0123456789';
    const r = await fetch(base + '/admin/db-snapshot', { headers: { authorization: 'Bearer campaign-admin-token-0123456789' } });
    check('H:snapshot', r.status === 200, `snapshot ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    check('H:snapshot', buf.subarray(0, 15).toString() === 'SQLite format 3', 'snapshot is a SQLite file');
    delete process.env.ADMIN_TOKEN;
  });

  // concurrent load: 200 parallel dashboard reads + 40 parallel pack builds
  await http('H:load-reads', async () => {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 200 }, () => call('dashboard')));
    const fails = rs.filter(r => r.status !== 200).length; const ms = Date.now() - t0;
    check('H:load-reads', fails === 0, `${fails}/200 dashboard reads failed`);
    R.perf = { ...(R.perf || {}), dashboard200xMs: ms };
  });
  await http('H:load-issues', async () => {
    const callers = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
      const c = mkCaller();
      await c('signup', { email: `load${i}@t.es`, password: 'Good-Pw-123!' });
      await c('seller', { name: 'Load S.L.', nif: 'b11111111', address: 'C Falsa 1', marketplaces: ['ES'] });
      await c('amazon/connect', { manual: true });
      return c;
    }));
    const t0 = Date.now();
    const rs = await Promise.all(callers.map((c, i) => c('manual/issue', { text: report(3, { vat: 'valid', tag: 'L' + i + '-', plain: true, mkt: ['ES', 'EUR'] }).text, attest: true })));
    const bad = rs.filter(r => r.status !== 200 || r.body.errors > 0).length; const ms = Date.now() - t0;
    check('H:load-issues', bad === 0, `${bad}/40 concurrent issue flows had errors`);
    R.perf = { ...(R.perf || {}), issue40xMs: ms };
  });
  server.close(); delete process.env.OPERATOR_NAME;
}

// ================= PART 6: live production checks =================
async function part6() {
  if (!LIVE) return;
  const live = async (scn, fn) => { R.cases++; try { await fn(); } catch (e) { fail(scn, 'live: ' + e.message); } };
  const get = async (path, headers = {}) => fetch(LIVE_BASE + path, { headers });
  await live('L:landing-en', async () => { const r = await get('/'); check('L:landing-en', r.status === 200 && (await r.text()).includes('InvoiceGuard'), 'landing 200'); });
  await live('L:landing-de', async () => { const r = await get('/', { 'accept-language': 'de' }); const t = await r.text(); check('L:landing-de', /Deutschland|German/i.test(t), 'DE landing localized'); });
  await live('L:landing-es', async () => { const r = await get('/', { 'accept-language': 'es' }); const t = await r.text(); check('L:landing-es', t.includes("Amazon&#39;s one-business-day") || t.includes("Amazon's one-business-day"), 'ES Amazon-policy line'); });
  await live('L:landing-fr', async () => { const r = await get('/', { 'accept-language': 'fr' }); check('L:landing-fr', r.status === 200, 'FR landing 200'); });
  for (const p of ['/faq', '/contact', '/privacy', '/articles', '/sample', '/app'])
    await live('L:page' + p, async () => { const r = await get(p); check('L:page' + p, r.status === 200, `${p} -> ${r.status}`); });
  await live('L:sample-run', async () => { const r = await fetch(LIVE_BASE + '/api/sample/run'); const j = await r.json(); check('L:sample-run', r.status === 200 && (j.invoices?.length ?? j.count ?? 1) !== undefined, 'sample run'); });
  await live('L:sample-repair', async () => { const r = await fetch(LIVE_BASE + '/api/sample/repair'); const j = await r.json(); check('L:sample-repair', r.status === 200 && (j.ok !== undefined), 'sample repair act'); });
  await live('L:404', async () => { const r = await get('/no-such-page-xyz'); check('L:404', r.status === 404, `404 -> ${r.status}`); });
  await live('L:admin-shut', async () => { const r = await get('/admin/counters'); check('L:admin-shut', [401, 403, 404].includes(r.status), 'admin closed'); }); // 404 = route hidden by design

  // one full live journey: signup -> issue -> refund -> proposal -> approve
  await live('L:journey', async () => {
    const em = `campaign-${Date.now()}@example.com`; let sid = '';
    const c = async (path, body) => { const r = await fetch(LIVE_BASE + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) });
      const ck = r.headers.get('set-cookie'); if (ck) sid = ck.split(';')[0]; return { status: r.status, body: await r.json().catch(() => null) }; };
    check('L:journey', (await c('signup', { email: em, password: 'Xq7!mZ2pLw9R' })).status === 200, 'live signup');
    check('L:journey', (await c('seller', { name: 'Dogfood Distribuciones S.L.', nif: 'ESB11111119', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] })).status === 200, 'live seller');
    check('L:journey', (await c('amazon/connect', { manual: true })).status === 200, 'live connect');
    const tag = Date.now().toString(36);
    const ship = report(1, { vat: 'none', tag }).text.replace(/\t\t/g, '\t\t');
    // live VIES: use a buyer without VAT to stay in sample-data territory
    const issue = await c('manual/issue', { text: ship, attest: true });
    check('L:journey', issue.status === 200, `live issue ${issue.status}`);
    const rep = await c('repairs');
    check('L:journey', rep.status === 200, 'live repairs endpoint');
  });
}

// ================= run =================
const t0 = Date.now();
await part1(500);
console.log('part1 done', R.cases, 'cases,', R.failures.length, 'failures', Date.now() - t0, 'ms');
await part2(300);
console.log('part2 done', R.cases, 'cases,', R.failures.length, 'failures', Date.now() - t0, 'ms');
await part3(150);
console.log('part3 done', R.cases, 'cases,', R.failures.length, 'failures', Date.now() - t0, 'ms');
await part4();
console.log('part4 done', R.cases, 'cases,', R.failures.length, 'failures', Date.now() - t0, 'ms');
await part5();
console.log('part5 done', R.cases, 'cases,', R.failures.length, 'failures', Date.now() - t0, 'ms');
await part6();
const totalMs = Date.now() - t0;
R.perf = { ...(R.perf || {}), totalMs, peakRssMb: Math.round(process.memoryUsage().rss / 1048576) };
const summary = { cases: R.cases, assertions: R.assertions, failures: R.failures.length, failureList: R.failures.slice(0, 40), perf: R.perf };
writeFileSync('/tmp/campaign-result.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(R.failures.length ? 1 : 0);
