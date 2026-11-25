import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { parseVidr, needsInvoice } from '../src/vidr.js';
import { checkFormat, validateVat } from '../src/vies.js';
import { processReport, pollFeeds, issueRectificativa } from '../src/pipeline.js';
import { SpApi } from '../src/spapi.js';
import { renderPdf } from '../src/pdf.js';
import { buildInvoice } from '../src/invoice.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, 28001 Madrid, ES' };
const fakeApi = () => { const calls = []; return { calls, uploadInvoice: async (a) => { calls.push(a); return `feed-${calls.length}`; }, feedStatus: async () => ({ status: 'DONE' }) }; };
const vies = async (v) => v === 'ESA1234567' ? { status: 'invalid', reason: 'bad_format', vat: v } : { status: 'valid', vat: v };

test('VIDR parsing groups shipments and detects who needs an invoice', () => {
  const s = parseVidr(text);
  assert.equal(s.length, 5);
  assert.deepEqual(s.filter(needsInvoice).map(x => x.shippingId), ['S1001', 'S1002', 'S1003']);
  const a = s[0]; assert.equal(a.incl, 54.45); assert.equal(a.vat, 9.45); assert.equal(a.excl, 45);
});

test('VAT format checks', () => {
  assert.equal(checkFormat('ES B1234 5678').ok, true);
  assert.equal(checkFormat('ESA1234567').ok, false);
  assert.equal(checkFormat('12345').reason, 'missing_country_prefix');
});

test('VIES: service outage is never treated as invalid', async () => {
  const r = await validateVat('DE811128135', { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), retries: 1 });
  assert.equal(r.status, 'unavailable');
  const ok = await validateVat('DE811128135', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, name: 'ACME GMBH', address: '---', requestDate: 'd' }) }) });
  assert.deepEqual([ok.status, ok.name, ok.address], ['valid', 'ACME GMBH', null]);
});

test('pipeline: uploads valid B2B, holds bad VAT, ignores B2C and already-uploaded, is idempotent', async () => {
  const db = openDb(); const api = fakeApi();
  const out = await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  assert.equal(out.detected, 3); assert.equal(out.uploaded, 2); assert.equal(out.held.length, 1); assert.equal(out.held[0].orderId, '405-2087716-3305528');
  assert.deepEqual(api.calls.map(c => c.number), ['A-2026-000001', 'A-2026-000002']);
  assert.equal(api.calls[0].total, 54.45); assert.equal(api.calls[0].vat, 9.45);
  const again = await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:05:00Z') });
  assert.equal(again.uploaded, 0); assert.equal(api.calls.length, 2, 'no duplicate upload');
  const p = await pollFeeds(db, seller, api); assert.equal(p.uploaded, 2);
  assert.equal(db.prepare("SELECT count(*) c FROM shipments WHERE status='uploaded'").get().c, 2);
});

test('intra-EU invoice carries Amazon citation text and zero VAT', async () => {
  const db = openDb(); const s = parseVidr(text)[1];
  const inv = buildInvoice(db, seller, s, { date: new Date('2026-11-24') });
  assert.equal(inv.totals.vat, 0); assert.match(inv.vatNote.text, /art\. 25/); assert.equal(inv.vatNote.source, 'amazon');
});

test('rectificativa by substitution: new R number, references original, VIES-checked, original untouched', async () => {
  const db = openDb(); const api = fakeApi();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const before = db.prepare('SELECT json FROM invoices WHERE number=?').get('A-2026-000001').json;
  const r = await issueRectificativa(db, seller, 'A-2026-000001', { mode: 'substitution', reason: 'Wrong buyer company name', changes: { buyer: { name: 'Mediterranea Logistica Norte S.L.' } } }, { api });
  assert.equal(r.rect.number, 'R-2026-000001'); assert.equal(r.rect.rectifies.number, 'A-2026-000001'); assert.equal(r.rect.rectifies.buyerChanged, true);
  assert.equal(r.documentType, 'Invoice'); assert.equal(r.rect.totals.incl, 54.45);
  assert.equal(db.prepare('SELECT json FROM invoices WHERE number=?').get('A-2026-000001').json, before);
  await assert.rejects(issueRectificativa(db, seller, 'A-2026-000001', { mode: 'substitution', reason: 'x', changes: { buyer: { vat: 'ESA1234567' } } }, { api }), /not valid/);
  await assert.rejects(issueRectificativa(db, seller, 'A-2026-000001', { mode: 'substitution', reason: '' }, { api }), /reason/);
});

test('rectificativa by differences: negative deltas become a credit note upload', async () => {
  const db = openDb(); const api = fakeApi();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const orig = JSON.parse(db.prepare('SELECT json FROM invoices WHERE number=?').get('A-2026-000001').json);
  const lines = orig.lines.map((l, i) => i === 0 ? { ...l, qty: 1, unitExcl: 20, excl: 20, vat: 4.2 } : l);
  const r = await issueRectificativa(db, seller, 'A-2026-000001', { mode: 'differences', reason: 'One unit returned', changes: { lines } }, { api });
  assert.equal(r.rect.totals.excl, -20); assert.equal(r.rect.totals.vat, -4.2); assert.equal(r.documentType, 'CreditNote');
  assert.equal(api.calls.at(-1).documentType, 'CreditNote'); assert.equal(api.calls.at(-1).total, 24.2);
});

test('SP-API client: LWA token, feed options, throttle, retry on 429', async () => {
  const log = []; let n429 = 0;
  const f = async (url, o = {}) => {
    log.push([o.method ?? 'GET', url, o.headers?.['x-amz-access-token']]);
    const J = (j, status = 200) => ({ ok: status < 300, status, json: async () => j, arrayBuffer: async () => new ArrayBuffer(0) });
    if (url.includes('/auth/o2/token')) return J({ access_token: 'Atza|t', expires_in: 3600 });
    if (url.includes('/feeds/2021-06-30/documents')) return J({ feedDocumentId: 'amzn1.tortuga.4.eu.X', url: 'https://s3.example/put' });
    if (url === 'https://s3.example/put') return J({});
    if (url.endsWith('/feeds/2021-06-30/feeds')) { if (n429++ === 0) return J({ errors: [] }, 429); return J({ feedId: 'F9' }); }
    throw new Error('unexpected ' + url);
  };
  const sleeps = []; const api = new SpApi({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: f, sleepFn: async (ms) => sleeps.push(ms) });
  const id = await api.uploadInvoice({ marketplaceId: 'A1RKKUPIHCS9HS', pdf: Buffer.from('x'), orderId: '405-1', shippingId: 'S1', number: 'A-2026-000001', total: 54.45, vat: 9.45 });
  assert.equal(id, 'F9'); assert.ok(sleeps.includes(1000), 'retried after 429');
  const feedCall = log.find(l => l[1].endsWith('/feeds/2021-06-30/feeds')); assert.equal(feedCall[2], 'Atza|t');
  await assert.rejects(api.uploadInvoice({ marketplaceId: 'x', pdf: Buffer.from('x'), orderId: '1', number: 'A"1', total: 1, vat: 0 }), /Invalid character/);
});

test('PDF renders and starts with %PDF (written to /tmp/sample-invoice.pdf for visual check)', async () => {
  const db = openDb(); const inv = buildInvoice(db, seller, parseVidr(text)[0], { date: new Date('2026-11-24') });
  const pdf = await renderPdf(inv); assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); writeFileSync('/tmp/sample-invoice.pdf', pdf);
  const rect = (await import('../src/invoice.js')).buildRectificativa(db, seller, inv, { mode: 'substitution', reason: 'Nombre del cliente incorrecto', changes: { buyer: { name: 'Mediterranea Norte S.L.' } } });
  writeFileSync('/tmp/sample-rect.pdf', await renderPdf(rect));
});

test('LIVE VIES (skipped offline): known-valid German VAT number', { skip: process.env.OFFLINE === '1' }, async () => {
  const r = await validateVat('DE811128135'); assert.ok(['valid', 'unavailable'].includes(r.status)); console.log('live VIES result:', r.status, r.name ?? r.reason);
});

test('failed upload keeps the invoice number and retry reuses it (no gaps, no duplicates)', async () => {
  const { openDb } = await import('../src/db.js'); const { processReport } = await import('../src/pipeline.js'); const { readFileSync } = await import('node:fs');
  const db = openDb(':memory:'); const seller = { id: 's1', name: 'T', nif: 'B11111111', address: 'x' };
  const report = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
  const ok = async () => ({ status: 'valid', vat: 'X' });
  let fail = true; const calls = [];
  const api = { uploadInvoice: async (a) => { calls.push(a.number); if (fail) throw new Error('boom'); return 'feed-' + calls.length; } };
  const r1 = await processReport(db, seller, report, { api, validate: ok }); assert.ok(r1.errors.length >= 1);
  fail = false; const r2 = await processReport(db, seller, report, { api, validate: ok });
  assert.equal(r2.errors.length, 0);
  const nums = db.prepare('SELECT number FROM invoices ORDER BY number').all().map(r => r.number);
  assert.equal(new Set(nums).size, nums.length); nums.forEach((n, i) => assert.equal(n, `A-${new Date().getFullYear()}-${String(i + 1).padStart(6, '0')}`));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE upload_status='pending'").get().n, 0);
});

test('VIES outage defers instead of rejecting', async () => {
  const { openDb } = await import('../src/db.js'); const { processReport } = await import('../src/pipeline.js'); const { readFileSync } = await import('node:fs');
  const db = openDb(':memory:'); const report = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
  const api = { uploadInvoice: async () => 'f' };
  const r = await processReport(db, { id: 's1', name: 'T', nif: 'B1', address: 'x' }, report, { api, validate: async (v) => ({ status: 'unavailable', vat: v, reason: 'timeout' }) });
  assert.equal(r.held.length, 0); assert.ok(r.deferred.length >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
});

test('applyEdits: amounts, address, seller details, removal', async () => {
  const { applyEdits, buildInvoice, buildRectificativa } = await import('../src/invoice.js'); const { parseVidr } = await import('../src/vidr.js');
  const db = openDb(':memory:'); const seller = { id: 's', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle 1' };
  const s = parseVidr(readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8')).find(x => x.buyerVat === 'ESB12345674'); const orig = buildInvoice(db, seller, s, { date: new Date() });
  assert.throws(() => applyEdits(orig, { lines: [{ index: 0, qty: -1 }] }), /zero or more/);
  assert.equal(applyEdits(orig, {}).changed, false);
  const e = applyEdits(orig, { lines: [{ index: 0, qty: 1 }] }); assert.equal(e.amountChanged, true); assert.equal(e.lines[0].excl, 20); assert.equal(e.lines[0].vat, 4.2);
  const d = buildRectificativa(db, seller, orig, { mode: 'differences', reason: 'Partial return', changes: e }); assert.equal(d.totals.incl, -24.2);
  const a = applyEdits(orig, { buyerAddress: 'Calle Nueva 3\n46002 Valencia' }); assert.deepEqual(a.buyer.address, ['Calle Nueva 3', '46002 Valencia']); assert.equal(a.amountChanged, false);
  const sw = applyEdits(orig, { sellerName: 'Tienda Demo Norte S.L.', sellerNif: 'b22222222' }); const r = buildRectificativa(db, seller, orig, { mode: 'substitution', reason: 'Seller details', changes: sw });
  assert.equal(r.seller.nif, 'B22222222'); assert.equal(r.rectifies.sellerChanged, true); assert.equal(orig.seller.nif, 'B11111111', 'original untouched');
  assert.throws(() => applyEdits(orig, { lines: [{ index: 0, remove: true }, { index: 1, remove: true }] }), /at least one line/);
  const n = applyEdits(orig, { newLines: [{ description: 'Extra', qty: 1, unitExcl: 10, rate: 0.21 }] }); assert.equal(n.lines.length, 3);
});

test('applyEdits: VAT percentage correction recomputes tax', async () => {
  const { applyEdits, buildInvoice, buildRectificativa } = await import('../src/invoice.js'); const { parseVidr } = await import('../src/vidr.js');
  const db = openDb(':memory:'); const seller = { id: 's', name: 'T', nif: 'B1', address: 'x' };
  const s = parseVidr(readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8')).find(x => x.buyerVat === 'ESB12345674'); const orig = buildInvoice(db, seller, s, { date: new Date() });
  const e = applyEdits(orig, { lines: [{ index: 0, rate: 0.1 }] }); assert.equal(e.lines[0].vat, 4); assert.equal(e.amountChanged, true);
  const d = buildRectificativa(db, seller, orig, { mode: 'differences', reason: 'Wrong VAT rate', changes: e }); assert.equal(d.totals.excl, 0); assert.equal(d.totals.vat, -4.4);
  assert.throws(() => applyEdits(orig, { lines: [{ index: 0, rate: 21 }] }), /fraction/);
});
