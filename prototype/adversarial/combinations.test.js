// PROTOTYPE (own branch, tests only, no production change): expanded adversarial generator (Ahmed's ruling, Nov 28 2026).
// A. combinations after approval: ALL pairs of approval-affecting atoms, targeted triples (financial x identity x documents), seeded random 3 and 4 changes, named high-risk combinations.
// B. input variations of every value: whitespace, empty, whitespace-only, null/missing, case, decimal representation, string vs number. Classified by comparing the DOCUMENT that was issued with the one the approval was for.
// C. invoice-status: proven not to touch the money, the approval, the evidence, or the acceptance gate of the correction pass; and exactly where it DOES act (the report-reconcile path, by design).
// Outcome classes: VOIDED (nothing issued), SAME-DOC (issued, and the issued documents equal the approved ones: harmless normalisation), GAP (issued and the documents DIFFER from what was approved).
// Run: node --test prototype/adversarial/combinations.test.js   (LOCAL evidence only, never CI)
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db.js'; import { processReport, processCorrections } from '../../src/pipeline.js'; import { approveAll } from '../../test/correction-helpers.js';
const text = readFileSync(new URL('../../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller0 = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies0 = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const [head0, ...body] = text.trim().split('\n'); const cols = head0.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
let FILL = null; const reversal = () => { const r = reversal0(); FILL?.(r, 'rv'); return r; }; const replacement = () => { const r = replacement0(); FILL?.(r, 'rp'); return r; };
const reversal0 = () => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r; };
const replacement0 = () => { const f = [...base]; f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = 'Name One SL'; return f; };
const build = (rv, rp, { drop = [], reason = 'Reason A' } = {}) => { const keep = cols.map((c, i) => drop.includes(c) ? -1 : i).filter(i => i >= 0); const pick = r => keep.map(i => r[i] ?? '').join('\t'); return [keep.map(i => cols[i]).join('\t') + '\tinvoice-correction-details', pick(rv) + '\t' + reason, pick(rp) + '\t' + reason].join('\n'); };
const isCorr = "(shipment_key LIKE 'REFUND:CorrectionReversal%' OR shipment_key LIKE 'Correction%' OR shipment_key LIKE 'SHIPMENT:Correction%')";
const nIssued = (db) => db.prepare(`SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND ${isCorr}`).get().c;
const strip = (o) => Array.isArray(o) ? o.map(strip) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !/number|date|issued|time|rectifies|feed|id$/i.test(k)).map(([k, v]) => [k, strip(v)])) : o;
const canon = (db) => JSON.stringify(db.prepare(`SELECT shipment_key k, kind, total, vat, json FROM invoices WHERE ${isCorr} OR kind='invoice' ORDER BY shipment_key, kind`).all().map(r => ({ k: r.k, kind: r.kind, total: r.total, vat: r.vat, doc: strip(JSON.parse(r.json || '{}')) })));
const fresh = async () => { const api = mkApi(), db = openDb(); await processReport(db, seller0, text, { api, validate: vies0, now: NOW }); await processCorrections(db, seller0, build(reversal(), replacement()), { api, validate: vies0 }); approveAll(db, seller0.id); return { api, db }; };
const mutate = (v) => /^-?\d+(\.\d+)?$/.test(v) ? String(Number(v) + 0.01) : (v === '' ? 'MUT' : v + ' MUT');
const origRow = (db) => db.prepare("SELECT number, json FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get();
// ---- atoms: one named change each. m = true when the change is MATERIAL (must void the approval)
const atoms = [];
const MATERIAL_COLS = [...AMT, 'billing-name', 'bill-address-1', 'bill-city', 'bill-postal-code', 'bill-country', 'buyer-vat-number', 'item-vat-rate', 'currency', 'quantity-purchased', 'sku', 'product-name', 'recipient-name', 'buyer-name'].filter(c => ix(c) >= 0);
for (const which of ['rv', 'rp']) for (const c of MATERIAL_COLS) atoms.push({ id: `${which}:${c}`, m: true, target: `${which}:${c}`, f: (x) => { const t = x[which]; t[ix(c)] = mutate(t[ix(c)] ?? ''); } });
for (const [k, v] of [['name', 'Other S.L.'], ['nif', 'B22222222'], ['address', 'Other 1'], ['country', 'DE'], ['invoice_lang', 'en']]) atoms.push({ id: `seller.${k}`, m: true, target: `seller.${k}`, f: (x) => { x.seller = { ...x.seller, [k]: v }; } });
atoms.push({ id: 'vies:invalid', m: true, target: 'vies', f: (x) => { x.validate = async (v) => ({ status: 'invalid', vat: v }); } }, { id: 'vies:unavailable', m: true, target: 'vies', f: (x) => { x.validate = async (v) => ({ status: 'unavailable', vat: v }); } }, { id: 'reason', m: true, target: 'reason', f: (x) => { x.reason = 'Reason B'; } });
atoms.push({ id: 'db:original-line', m: true, target: 'db:orig', f: (x) => x.pre.push((db) => { const o = origRow(db), j = JSON.parse(o.json); j.lines[0].unitExcl += 1; db.prepare('UPDATE invoices SET json=? WHERE number=?').run(JSON.stringify(j), o.number); }) });
atoms.push({ id: 'db:original-seller', m: true, target: 'db:orig', f: (x) => x.pre.push((db) => { const o = origRow(db), j = JSON.parse(o.json); j.seller.name = 'Changed'; db.prepare('UPDATE invoices SET json=? WHERE number=?').run(JSON.stringify(j), o.number); }) });
atoms.push({ id: 'db:extra-credit-note', m: true, target: 'db:credit', f: (x) => x.pre.push((db) => { const o = origRow(db); db.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(seller0.id, 'R-2026-000500', 'SHIPMENT:S1001', 'rectificativa', o.number, new Date().toISOString(), -5, -0.9, '{}', null, 'submitted'); }) });
atoms.push({ id: 'db:other-claim', m: true, target: 'db:claim', f: (x) => x.pre.push((db) => { const o = origRow(db); db.prepare('INSERT INTO credit_claims (seller_id, original_number, reversal_key, amount, claimed_at) VALUES (?,?,?,?,?)').run(seller0.id, o.number, 'REFUND:CorrectionReversal:OTHER:1', 10, new Date().toISOString()); }) });
for (const which of ['rv', 'rp']) atoms.push({ id: `${which}:invoice-status`, m: false, target: `${which}:invoice-status`, f: (x) => { x[which][ix('invoice-status')] = 'CreditNoteUploaded'; } });
const byId = Object.fromEntries(atoms.map(a => [a.id, a]));
async function run(ids, extra = (x) => {}) {
  const { api, db } = await fresh(); const n0 = api.calls.length; const x = { rv: reversal(), rp: replacement(), seller: seller0, validate: vies0, reason: 'Reason A', pre: [], drop: [] };
  for (const id of ids) byId[id].f(x); extra(x); for (const p of x.pre) p(db);
  const before = nIssued(db); await processCorrections(db, x.seller, build(x.rv, x.rp, { drop: x.drop, reason: x.reason }), { api, validate: x.validate });
  return { issued: nIssued(db) > before || api.calls.length > n0, db, api };
}
let controlCanon; const results = { combos: 0, voided: 0, sameDoc: [], gaps: [], nonMaterialVoided: [] };
test('control: nothing mutated -> the approved pair issues (reference documents for the SAME-DOC comparison)', async () => { const r = await run([]); assert.equal(r.issued, true); controlCanon = canon(r.db); });
async function judge(ids, label = ids.join(' + ')) {
  const r = await run(ids); results.combos++; const material = ids.some(i => byId[i]?.m !== false);
  if (!r.issued) { results.voided++; if (!material) results.nonMaterialVoided.push(label); return; }
  if (canon(r.db) === controlCanon) { if (material) results.sameDoc.push(label); } else results.gaps.push(label);
  if (material && r.issued && canon(r.db) === controlCanon) { /* issued with the approved documents although a material change was made: reported, see SAME-DOC list */ }
}
// ---- A1. ALL pairs of atoms (more than pairwise coverage: every pair, 1 change per target)
const pairs = []; for (let i = 0; i < atoms.length; i++) for (let j = i + 1; j < atoms.length; j++) if (atoms[i].target !== atoms[j].target) pairs.push([atoms[i].id, atoms[j].id]);
const CHUNK = Math.ceil(pairs.length / 4);
for (let k = 0; k < 4; k++) test(`A1.${k + 1}: pairs of changes after approval (${pairs.slice(k * CHUNK, (k + 1) * CHUNK).length} pairs)`, { timeout: 110000 }, async () => { for (const p of pairs.slice(k * CHUNK, (k + 1) * CHUNK)) await judge(p); });
// ---- A2. targeted triples: financial x identity x documents
test('A2: targeted triples: financial x identity x documents (80)', { timeout: 110000 }, async () => {
  const F = ['rv:item-vat-incl-amount', 'rv:item-vat-excl-amount', 'rp:item-vat-incl-amount', 'rp:shipping-vat-incl-amount'], I = ['seller.nif', 'seller.name', 'seller.country', 'rp:buyer-vat-number', 'rp:billing-name'], D = ['db:original-line', 'db:original-seller', 'db:extra-credit-note', 'db:other-claim'];
  for (const f of F) for (const i of I) for (const d of D) await judge([f, i, d]);
});
// ---- A3-A6. the named high-risk combinations Ahmed listed, plus multi-value changes
test('A3-A6: seller+stored original, VIES+reason, invoice data+credit note+claim, many values at once', { timeout: 110000 }, async () => {
  for (const s of ['seller.name', 'seller.nif', 'seller.address', 'seller.country']) for (const d of ['db:original-line', 'db:original-seller']) await judge([s, d]);
  for (const v of ['vies:invalid', 'vies:unavailable']) await judge([v, 'reason']);
  for (const a of ['rp:billing-name', 'rp:buyer-vat-number', 'rv:item-vat-incl-amount']) await judge([a, 'db:extra-credit-note', 'db:other-claim']);
  await judge(['rv:item-vat-incl-amount', 'rv:item-vat-amount', 'rv:item-vat-excl-amount', 'rv:shipping-vat-incl-amount'], 'all four reversal amounts');
  await judge(atoms.filter(a => a.id.startsWith('rv:') && a.m).map(a => a.id), 'EVERY material reversal column at once');
  await judge(atoms.filter(a => a.id.startsWith('rp:') && a.m).map(a => a.id), 'EVERY material replacement column at once');
  await judge(atoms.filter(a => a.m).map(a => a.id).filter((id, i, all) => all.findIndex(j => byId[j].target === byId[id].target) === i), 'EVERY material target at once (one change each)');
});
test('A7: seeded random 3 and 4 changes (300)', { timeout: 110000 }, async () => {
  let s = 20261128; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let n = 0; n < 300; n++) { const k = 3 + (n % 2), pick = []; while (pick.length < k) { const a = atoms[Math.floor(rnd() * atoms.length)]; if (!pick.some(p => byId[p].target === a.target)) pick.push(a.id); } await judge(pick); }
});
// ---- invoice-status inside combinations: a material change next to it must still void; alone it is the expected exception
test('A8: invoice-status alone (both rows) is the one expected non-void; next to any material change it still voids', { timeout: 110000 }, async () => {
  const alone = await run(['rv:invoice-status', 'rp:invoice-status']); assert.equal(alone.issued, true, 'expected exception'); assert.equal(canon(alone.db), controlCanon, 'and the documents are the approved ones');
  const gaps0 = results.gaps.length; for (const m of atoms.filter(a => a.m)) await judge(['rv:invoice-status', 'rp:invoice-status', m.id]); assert.equal(results.gaps.length, gaps0);
});
// ---- B. input variations
const swapcase = (v) => v.replace(/[a-zA-Z]/g, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
const variants = (v) => { const o = [['ws-around', ' ' + v + ' '], ['tab-around', '\t' + v + '\t'], ['empty', ''], ['ws-only', '   '], ['literal-null', 'null']]; if (/[a-zA-Z]/.test(v)) o.push(['case-swapped', swapcase(v)], ['lowercase', v.toLowerCase()], ['uppercase', v.toUpperCase()]); if (/^-?\d+(\.\d+)?$/.test(v)) { const n = Number(v); o.push(['decimal-trailing-zero', v.includes('.') ? v + '0' : v + '.0'], ['decimal-more-places', n.toFixed(4)], ['decimal-comma', v.replace('.', ',')], ['exponent', n.toExponential()], ['leading-zeros', v.startsWith('-') ? '-00' + v.slice(1) : '00' + v], ['plus-sign', n >= 0 ? '+' + v : v]); } return o; };
const bres = { noop: 0, n: 0, voided: 0, sameDoc: [], gaps: [] };
async function judgeVariant(label, mod, noop = false) { if (noop) { bres.noop++; return; } const r = await run([], mod); bres.n++; if (!r.issued) { bres.voided++; return; } if (canon(r.db) === controlCanon) bres.sameDoc.push(label); else bres.gaps.push(label); }
test('B1: every report column of both rows, every variation (whitespace, empty, null, case, decimal forms)', { timeout: 115000 }, async () => {
  for (const which of ['rv', 'rp']) for (const c of cols) { const v = (which === 'rv' ? reversal() : replacement())[ix(c)] ?? ''; for (const [name, nv] of variants(v)) await judgeVariant(`${which}:${c} ${name}`, (x) => { x[which][ix(c)] = nv; }, nv === v); }
});
test('B2: a column missing from the report altogether (header and cells), every column', { timeout: 115000 }, async () => { for (const c of cols) await judgeVariant(`column "${c}" missing from the report`, (x) => { x.drop = [c]; }); });
test('B3: seller fields, types (string vs number, null, undefined), VIES answers and the reason text', { timeout: 115000 }, async () => {
  for (const k of ['name', 'nif', 'address', 'country', 'invoice_lang']) for (const [name, nv] of [['ws-around', ' ' + seller0[k] + ' '], ['empty', ''], ['ws-only', '  '], ['null', null], ['undefined', undefined], ['number', 12345678], ['uppercase', String(seller0[k]).toUpperCase()], ['lowercase', String(seller0[k]).toLowerCase()], ['array', [seller0[k]]]]) await judgeVariant(`seller.${k} ${name}`, (x) => { x.seller = { ...x.seller, [k]: nv }; }, nv === seller0[k]);
  for (const [name, fn] of [['status VALID (upper)', async (v) => ({ status: 'VALID', vat: v })], ['status " valid "', async (v) => ({ status: ' valid ', vat: v })], ['status true (boolean)', async (v) => ({ status: true, vat: v })], ['status missing', async (v) => ({ vat: v })], ['returns null', async () => null], ['throws', async () => { throw new Error('down'); }], ['vat lowercase', async (v) => ({ status: 'valid', vat: String(v).toLowerCase() })], ['vat with spaces', async (v) => ({ status: 'valid', vat: ' ' + v + ' ' })]]) await judgeVariant(`VIES ${name}`, (x) => { x.validate = fn; });
  for (const [name, r] of [['reason ws-around', ' Reason A '], ['reason empty', ''], ['reason ws-only', '   '], ['reason uppercase', 'REASON A'], ['reason lowercase', 'reason a']]) await judgeVariant(name, (x) => { x.reason = r; });
});
test('B4: the bound columns that are blank in the fixture row (order-date, recipient-name, buyer-name, citation-es) are FILLED in the approved report, then blanked / whitespace / case-changed after approval', { timeout: 115000 }, async () => {
  const FILLS = { 'order-date': '2026-11-10T10:00:00+00:00', 'recipient-name': 'Ana Recipient', 'buyer-name': 'Ben Buyer', 'citation-es': 'Art. 7 test' }; FILL = (r) => { for (const [c, v] of Object.entries(FILLS)) r[ix(c)] = v; };
  try { const ctl = await run([]); assert.equal(ctl.issued, true, 'filled report issues when unchanged'); const saved = controlCanon; controlCanon = canon(ctl.db);
    for (const which of ['rv', 'rp']) for (const [c, v] of Object.entries(FILLS)) for (const [name, nv] of variants(v)) await judgeVariant(`FILLED ${which}:${c} ${name}`, (x) => { x[which][ix(c)] = nv; }, nv === v);
    controlCanon = saved; } finally { FILL = null; }
});
// ---- C. invoice-status can not touch the money, the approval, the evidence or the correction-pass gate
const STATUSES = ['', 'CreditNotePending', 'CreditNoteUploaded', 'CreditNoteProcessing', 'CreditNoteRejected', 'InvoiceUploaded', 'Invoiced', 'GARBAGE', ' CreditNoteUploaded ', 'creditnoteuploaded'];
const dump = (db, t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all().map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !/_at$|^at$|^ts$|^claimed_at|claim_id|^id$|fingerprint/i.test(k))))).replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|\+00:00)?/g, 'T');
test('C1: financial calculations, approval validity and evidence are identical for every invoice-status value on the correction pass', { timeout: 100000 }, async () => {
  const ref = await run([]); const refFind = dump(ref.db, 'integrity_findings'), refDec = dump(ref.db, 'integrity_decisions'), refHist = dump(ref.db, 'credit_claim_history');
  for (const st of STATUSES) for (const rows of [['rv'], ['rp'], ['rv', 'rp']]) {
    const r = await run([], (x) => rows.forEach(w => { x[w][ix('invoice-status')] = st; }));
    const lab = `status "${st}" on ${rows}`; assert.equal(r.issued, true, 'approval stays valid: ' + lab); assert.equal(canon(r.db), controlCanon, 'documents and amounts identical: ' + lab);
    assert.equal(dump(r.db, 'integrity_decisions'), refDec, 'decisions identical: ' + lab);
    assert.equal(dump(r.db, 'integrity_findings'), refFind, 'evidence findings identical: ' + lab); assert.equal(dump(r.db, 'credit_claim_history'), refHist, 'claim history identical: ' + lab);
    assert.equal(r.db.prepare("SELECT count(*) c FROM credit_claims").get().c, ref.db.prepare("SELECT count(*) c FROM credit_claims").get().c, 'claim balance identical: ' + lab);
  }
});
test('C2: acceptance gate, correction pass: no invoice-status value on the correction rows releases the replacement before our own credit note is recorded as uploaded', { timeout: 100000 }, async () => {
  for (const st of STATUSES) { const { api, db } = await fresh(); const rv = reversal(), rp = replacement(); rv[ix('invoice-status')] = st; rp[ix('invoice-status')] = st;
    const r = await processCorrections(db, seller0, build(rv, rp), { api, validate: vies0 }); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'Correction%'").get().c, 0, `no replacement document for status "${st}"`); assert.equal(r.invoices, 0);
    const again = await processCorrections(db, seller0, build(rv, rp), { api, validate: vies0 }); assert.equal(again.invoices, 0, `still none on a second pass, status "${st}"`);
    assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%' AND upload_status='uploaded'").get().c, 0, 'our credit note is NOT marked uploaded by the correction pass'); }
});
test('C3: where invoice-status DOES act, stated exactly: the report-reconcile path (processReport) is the one designed way our credit note becomes "uploaded"; it only reacts to the credit note\'s own transaction key', { timeout: 60000 }, async () => {
  // (a) a CreditNoteUploaded row for a transaction that is NOT ours changes nothing
  { const { api, db } = await fresh(); await processCorrections(db, seller0, build(reversal(), replacement()), { api, validate: vies0 }); const other = reversal(); other[ix('transaction-id')] = 'CorrectionReversal:NOT-OURS:9'; other[ix('invoice-status')] = 'CreditNoteUploaded';
    await processReport(db, seller0, [head0, other.join('\t')].join('\n'), { api, validate: vies0, now: NOW }); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND upload_status='uploaded'").get().c, 0, 'a foreign transaction does not mark ours uploaded'); }
  // (b) a CreditNoteUploaded row carrying OUR transaction key marks our credit note uploaded: this is the acceptance evidence by design (it must come from Amazon's report, with TransactionId, in a later cycle); a person must still hold real evidence
  { const { api, db } = await fresh(); await processCorrections(db, seller0, build(reversal(), replacement()), { api, validate: vies0 }); const mine = reversal(); mine[ix('invoice-status')] = 'CreditNoteUploaded';
    await processReport(db, seller0, [head0, mine.join('\t')].join('\n'), { api, validate: vies0, now: NOW }); const up = db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%' AND upload_status='uploaded'").get().c; console.log('C3(b) report row with our transaction key and CreditNoteUploaded marks our credit note uploaded: ' + (up === 1)); assert.equal(up, 1, 'documents CURRENT behaviour: the report is the acceptance evidence'); }
});
test('REPORT', () => {
  const lines = (a) => a.length ? '\n' + a.map(x => '  - ' + x).join('\n') : ' none';
  console.log(`ADVERSARIAL-EXPANDED A (combinations): cases=${results.combos}, voided=${results.voided}, issued with the SAME approved documents (material change had no effect on the output)=${results.sameDoc.length}${lines(results.sameDoc)}\n  GAPS (issued, documents differ from approved)=${results.gaps.length}${lines(results.gaps)}\n  non-material combos that voided=${results.nonMaterialVoided.length}${lines(results.nonMaterialVoided)}`);
  console.log(`ADVERSARIAL-EXPANDED B (variations): cases=${bres.n}, voided=${bres.voided}, no-op variants skipped (value unchanged)=${bres.noop}, SAME-DOC (harmless normalisation)=${bres.sameDoc.length}, GAPS=${bres.gaps.length}${lines(bres.gaps)}\n  SAME-DOC list:${lines(bres.sameDoc)}`);
  assert.equal(results.gaps.length + bres.gaps.length, 0, 'no unapproved content may be issued');
});
