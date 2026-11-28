// InvoiceGuard local end-to-end demo (SYNTHETIC data only, in-memory database, no network, no Amazon, no real seller).
// Walks one correction pair through the whole credit-note journey and shows the system's explanation at each stop. Run: node tools/demo-e2e.mjs
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb, currentAttemptSeq } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js'; import { approveAll } from '../test/correction-helpers.js'; import { listHolds, decideHold } from '../src/holds.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const [head0, ...body] = text.trim().split('\n'); const cols = head0.split('\t'); const X = ['invoice-number', 'original-vat-invoice-number']; const ix = n => cols.includes(n) ? cols.indexOf(n) : cols.length + X.indexOf(n);
const H = head0 + '\t' + X.join('\t'); const base = body[0].split('\t'); const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const pad = (r) => { while (r.length < cols.length + X.length) r.push(''); return r; };
const rv = (status = 'CreditNotePending') => { const r = pad([...base]); r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = status; return r; };
const rp = () => { const f = pad([...base]); f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = 'Name One SL'; return f; };
const rep = (a, b) => [H + '\tinvoice-correction-details', a.join('\t') + '\tReason A', b.join('\t') + '\tReason A'].join('\n');
const KEY = 'REFUND:CorrectionReversal:X:1';
async function setup() { const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies }); return { api, db, seq: currentAttemptSeq(db, seller.id) }; }
const cn = (db) => db.prepare("SELECT number, upload_status, json FROM invoices WHERE kind='rectificativa' AND shipment_key=?").get(KEY);
const repl = (db) => db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE '%Correction::%'").get().c;
const holds = (db, code) => db.prepare("SELECT code FROM integrity_findings WHERE status='OPEN' AND code LIKE 'CREDIT_NOTE_%'" + (code ? ' AND code=?' : ''), ).all(...(code ? [code] : []));
// the exactly-right acceptance row for our credit note; mod() breaks one thing
const good = (n, mod) => { const r = rv('CreditNoteUploaded'); r[ix('invoice-number')] = n; mod?.(r); return r; };
const doc = (...rows) => [H, ...rows.map(r => r.join('\t'))].join('\n');
const ing = (db, api, t, extra = {}, sl = seller) => processReport(db, sl, t, { api, validate: vies, ...extra });
const nextPass = (db, api) => processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies });
const say = (s) => console.log('\n' + s); const show = (h) => { for (const x of h) { console.log(`  HOLD ${x.code} (${x.status})`); console.log(`    what happened : ${x.happened}`); console.log(`    why           : ${x.why}`); console.log(`    known         : ${x.known.join(' | ')}`); console.log(`    not known     : ${x.unknown.join(' | ')}`); console.log(`    allowed       : ${x.allowed.join(' | ') || '-'}`); console.log(`    blocked       : ${x.blocked.join(' | ')}`); console.log(`    next          : ${x.next}`); } };
const T1 = new Date('2026-11-25T09:00:00Z'), T2 = new Date('2026-11-25T11:00:00Z');
say('1. Amazon report arrives: an invoice, a correction reversal (credit note) and the corrected replacement data. The correction is proposed as a PAIR; here a reviewer approves the pair (test helper), then the credit note is issued and sent.');
const { api, db, seq } = await setup(); const n = cn(db).number;
say(`   credit note ${n} issued and sent: status ${cn(db).upload_status}; replacements issued: ${repl(db)}`);
say('2. A report names a WRONG document number for our credit note. Nothing is applied, nothing is issued:');
await ing(db, api, doc(good(n, r => { r[ix('invoice-number')] = 'R-2026-999999'; })), { reportAttemptSeq: seq, reportRequestedAt: T1 });
console.log(`   credit note status: ${cn(db).upload_status}; replacements: ${repl(db)}`); const sid = seller.id; show(listHolds(db, sid));
say('3. A person compares the report row with our credit note and records a documented decision (who, why) for exactly this evidence:');
const h = listHolds(db, sid)[0]; decideHold(db, sid, { key: h.key, code: h.code, fingerprint: h.fingerprint, reason: 'Compared the report row with our stored credit note: wrong number in the sample report.' }, 'demo-reviewer'); console.log('   decision recorded; hold open now: ' + listHolds(db, sid).length);
say('4. The CORRECT acceptance report arrives (our document number, transaction, order, shipping, currency and amounts all match, with the authenticated report sequence):');
await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 }); console.log(`   credit note status: ${cn(db).upload_status}`);
say('5. Only now may the replacement invoice be issued:'); await nextPass(db, api); console.log(`   replacements issued: ${repl(db)}`);
say('6. A LATER report contradicts the acceptance (rejected). The accepted document is never changed or cancelled automatically; a hold opens instead:');
await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; })), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-26T09:00:00Z') });
console.log(`   credit note status: ${cn(db).upload_status}`); show(listHolds(db, sid));
say('7. The database itself refuses to move an accepted document back (state machine):'); try { db.prepare("UPDATE invoices SET upload_status='sending' WHERE number=?").run(n); } catch (e) { console.log('   refused: ' + e.message); }
say('Done. Synthetic data only. This demo proves the local logic, not Amazon acceptance: no real Amazon report was used.');
