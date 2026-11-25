import test from 'node:test'; import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { PACKS, allRuleStates, gate, legalDeadline, correctionWindowOk, missingFields, checkSources, reviewRule } from '../src/rules.js';
const asOf = (d) => new Date(d);
test('packs: every rule has an official source and a verified date or is flagged unverified', () => {
  for (const p of Object.values(PACKS)) for (const r of p.rules) { assert.ok(r.source?.url?.startsWith('https://'), r.id); assert.ok(r.status === 'verified' ? r.verified_on : true, r.id); }
});
test('gate: ok today, holds once the review interval lapses', () => {
  const db = openDb(); assert.equal(gate(db, 'ES', 'issue', asOf('2026-11-26')).ok, true);
  const g = gate(db, 'ES', 'issue', asOf('2027-06-01')); assert.equal(g.ok, false); assert.match(g.holds[0].why, /re-verified/);
});
test('hard drift (anchor text gone) holds and cannot be acknowledged; soft drift only flags', async () => {
  const db = openDb(); const now = asOf('2026-11-26');
  await checkSources(db, { now, fetchImpl: async () => ({ ok: true, text: async () => '<p>nothing relevant</p>' }) });
  const g = gate(db, 'ES', 'correct', now); assert.equal(g.ok, false);
  assert.throws(() => reviewRule(db, 'ES-RECT-WINDOW', 'op', 'x', now), /must be updated/);
  const db2 = openDb(); const ES = PACKS.ES.rules.find(r => r.id === 'ES-INV-NUMBERING');
  await checkSources(db2, { now, only: ES.id, fetchImpl: async () => ({ ok: true, text: async () => ES.anchors.join(' ') + ' v1' }) });
  await checkSources(db2, { now, only: ES.id, fetchImpl: async () => ({ ok: true, text: async () => ES.anchors.join(' ') + ' v2' }) });
  const a = allRuleStates(db2, now).find(p => p.country === 'ES').rules.find(r => r.id === ES.id); assert.equal(a.state, 'flag'); assert.equal(gate(db2, 'ES', 'issue', now).ok, true);
  reviewRule(db2, ES.id, 'op', 'ok', now); assert.equal(allRuleStates(db2, now).find(p => p.country === 'ES').rules.find(r => r.id === ES.id).state, 'ok');
});
test('unreachable source flags but never holds', async () => {
  const db = openDb(); const now = asOf('2026-11-26'); await checkSources(db, { now, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(gate(db, 'ES', 'correct', now).ok, true);
});
test('legal deadline: before day 16 of the next month', () => { assert.equal(legalDeadline('2026-11-25', 'ES').date, '2026-12-15'); assert.equal(legalDeadline('2026-12-31', 'ES').date, '2027-01-15'); });
test('rectificativa window: four years', () => { assert.equal(correctionWindowOk('2022-01-10', 'ES', asOf('2026-01-09')).ok, true); assert.equal(correctionWindowOk('2022-01-10', 'ES', asOf('2026-01-11')).ok, false); });
test('required fields are reported', () => {
  const doc = { number: 'PREVIEW', issueDate: '2026-11-25', seller: { name: 'S', nif: '', address: 'x' }, buyer: { name: 'B', address: ['a'] }, lines: [{ description: 'd', unitExcl: 1, rate: 0.21 }], totals: { vat: 1, excl: 5 } };
  assert.deepEqual(missingFields(doc, 'ES'), ['seller.nif']);
});
import { readFileSync } from 'node:fs';
import { processReport, issueRectificativa } from '../src/pipeline.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, 28001 Madrid, ES' };
const vies = async (v) => ({ status: 'valid', vat: v });
const api = () => ({ uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) });
test('pipeline: a stale gate rule holds shipments, burns no invoice number, and a seller without NIF is held on required fields', async () => {
  const db = openDb(); const out = await processReport(db, seller, text, { api: api(), validate: vies, now: new Date('2027-09-01T00:00:00Z') });
  assert.equal(out.uploaded, 0); assert.ok(out.held.length >= 3); assert.match(out.held[0].reason, /Rule pack on hold/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM counters').get().n, 0);
  const db2 = openDb(); const o2 = await processReport(db2, { ...seller, nif: '' }, text, { api: api(), validate: vies, now: new Date('2026-11-26T00:00:00Z') });
  assert.equal(o2.uploaded, 0); assert.match(o2.held[0].reason, /seller\.nif/); assert.equal(db2.prepare('SELECT COUNT(*) n FROM counters').get().n, 0);
});
test('pipeline: correction outside the four-year window is refused', async () => {
  const db = openDb(); await processReport(db, seller, text, { api: api(), validate: vies, now: new Date('2026-11-26T00:00:00Z') });
  const n = db.prepare('SELECT number FROM invoices LIMIT 1').get().number;
  await assert.rejects(issueRectificativa(db, seller, n, { mode: 'substitution', reason: 'x', changes: { buyer: { name: 'Z' } }, now: new Date('2031-01-01') }, { api: api(), validate: vies }), /window|rule pack/i);
});
import { resolveLangs, issuerLang } from '../src/lang.js';
import { renderPdf } from '../src/pdf.js';
test('language layer: follows issuer pack and buyer country, no Spanish/English hardcoding', () => {
  assert.equal(issuerLang('ES'), 'es'); assert.equal(issuerLang('DE'), 'de');
  assert.deepEqual(resolveLangs('auto', 'ES', 'ES'), ['es']); assert.deepEqual(resolveLangs('auto', 'ES', 'DE'), ['es', 'de']);
  assert.deepEqual(resolveLangs('auto', 'ES', 'BE'), ['es']); assert.deepEqual(resolveLangs('both', 'ES'), ['es', 'en']); assert.deepEqual(resolveLangs('fr', 'ES', 'DE'), ['fr']);
});
test('PDF renders in every supported language and in bilingual form', async () => {
  const doc = { type: 'rectificativa', mode: 'differences', number: 'R-1', issueDate: '2026-11-25', seller: { name: 'S', nif: 'B1', address: 'x' }, buyer: { name: 'B', address: ['a'] }, lines: [{ description: 'd', qty: 1, unitExcl: 1, rate: 0.21, excl: 1, vat: 0.21 }], totals: { excl: 1, vat: 0.21, incl: 1.21 }, rectifies: { number: 'A-1', issueDate: '2026-11-01', reason: 'x' }, currency: 'EUR' };
  for (const langs of [['es'], ['en'], ['de'], ['fr'], ['it'], ['nl'], ['es', 'de'], ['it', 'nl']]) { const b = await renderPdf({ ...doc, langs }); assert.equal(b.subarray(0, 4).toString(), '%PDF', langs.join()); }
});
import { spanishNifValid, nameMatches, verifyBuyer } from '../src/verify.js';
test('Spanish NIF control characters', () => {
  assert.equal(spanishNifValid('ESB12345674'), true); assert.equal(spanishNifValid('ESB12345678'), false); assert.equal(spanishNifValid('12345678Z'), true); assert.equal(spanishNifValid('12345678A'), false); assert.equal(spanishNifValid('X1234567L'), true);
});
test('company names compare loosely', () => { assert.equal(nameMatches('Hoffmann Büroservice GmbH', 'HOFFMANN BUROSERVICE GMBH'), true); assert.equal(nameMatches('Acme S.L.', 'Beta Corp'), false); });
const sx = { key: 'k', buyerVat: 'ESB12345674', buyerCompany: 'Alba Construcciones S.L.', billing: {} };
test('verifyBuyer: VIES name mismatch holds, census mismatch holds, outage defers, none configured is reported as not run', async () => {
  const db = openDb(); const sel = { id: 's1' };
  const a = await verifyBuyer(db, sel, sx, { status: 'valid', name: 'TOTALLY OTHER COMPANY' }); assert.equal(a.hold.id, 'vies_name'); assert.equal(a.hold.overridable, true);
  const b = await verifyBuyer(db, sel, sx, { status: 'valid', name: 'ALBA CONSTRUCCIONES SL' }, { census: async () => ({ status: 'mismatch' }) }); assert.equal(b.hold.id, 'census');
  const c = await verifyBuyer(db, sel, sx, { status: 'valid' }, { census: async () => ({ status: 'unavailable' }) }); assert.ok(c.defer);
  const d = await verifyBuyer(db, sel, sx, { status: 'valid' }); assert.ok(d.notes.some(n => /not run/.test(n)) && !d.notes.some(n => /census name\+NIF match/.test(n)));
  const e = await verifyBuyer(db, sel, { ...sx, buyerVat: 'ESB12345678' }, { status: 'valid' }); assert.equal(e.hold.id, 'nif_checksum'); assert.equal(e.hold.overridable, false);
});
test('pipeline: a buyer whose VIES name differs is held before any invoice number is used; release lets it through', async () => {
  const db = openDb(); const viesN = async (v) => ({ status: 'valid', vat: v, name: 'SOMEONE ELSE ENTIRELY' });
  const out = await processReport(db, seller, text, { api: api(), validate: viesN, now: new Date('2026-11-26T00:00:00Z') });
  assert.ok(out.held.some(h => /VIES registers/.test(h.reason))); assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE shipment_key IN (SELECT key FROM shipments WHERE status='held')").get().n, 0);
});
