// Strict identity gate for Amazon's "CreditNoteUploaded" verdict (owner ruling, Nov 28 2026).
// A credit note is marked 'uploaded' (the condition that opens the replacement invoice) only when the report PROVES that Amazon finished
// processing OUR document: every report row of the transaction agrees, and each identity field the report really carries matches what we stored.
// Anything unproven or contradictory is a HOLD for a person; this module never changes a document and never auto-picks a row.
// Fields used are real columns of the VAT Invoice Data Report: invoice-status, invoice-number (All view), transaction-type/-id, marketplace-id,
// order-id, shipping-id, currency, the amount columns, original-vat-invoice-number. seller-vat-number is NOT used as proof of seller identity.
import { createHash } from 'node:crypto';
import { writeLedger } from './integrity.js';
import { logEvent } from './db.js';
const cents = (x) => Math.round(Number(x) * 100);
const uniq = (a) => [...new Set(a)];
export const CN_HOLD_CODES = ['CREDIT_NOTE_IDENTITY_UNPROVEN', 'CREDIT_NOTE_ROWS_CONFLICT', 'CREDIT_NOTE_VERDICT_CONTRADICTION'];
/** All rows of the transaction must carry the SAME status (exact literal, after the parser's cell trim). Row order never matters. */
export function rowStatuses(s) { return uniq((s.rowMeta ?? []).map(r => r.status ?? '')); }
/** Returns { ok: true } or { ok: false, code, failed: [condition names], why }. */
export function evaluateCreditNoteUploaded(db, sellerId, s, rect, { reportSeq, expect = 'CreditNoteUploaded' } = {}) {
  const failed = []; const rows = s.rowMeta ?? []; const fail = (c, why) => failed.push({ c, why });
  const statuses = rowStatuses(s);
  if (statuses.length !== 1) return { ok: false, code: 'CREDIT_NOTE_ROWS_CONFLICT', failed: [{ c: 'rows-agree-on-status', why: `The rows of this transaction carry different statuses (${statuses.map(x => JSON.stringify(x)).join(', ')}). No row was picked.` }] };
  if (statuses[0] !== expect) fail('status', `The status is not exactly ${expect}.`);
  if (!Number.isInteger(reportSeq)) fail('authenticated-report', 'This report did not come with the sequence of the authenticated download, so its order against our upload attempts is unknown.');
  const rj = (() => { try { return JSON.parse(rect.json); } catch { return null; } })();
  if (!rj) fail('stored-credit-note', 'Our stored credit note could not be read.');
  // document identity: blank is never a match
  if (!s.invoiceNumberColumn) fail('invoice-number', 'The report has no invoice-number column (use the All view): Amazon\'s document number cannot be compared.');
  else {
    const nums = uniq(rows.map(r => r.invoiceNumber ?? ''));
    if (nums.length !== 1) fail('invoice-number', 'The rows of this transaction disagree on the document number.');
    else if (nums[0] === '') fail('invoice-number', 'The document number in the report is blank.');
    else if (nums[0] !== rect.number) fail('invoice-number', `The report names document ${nums[0]}, not ours (${rect.number}).`);
  }
  const same = (name, get, want, label) => { const v = uniq(rows.map(get)); if (v.length !== 1) fail(name, `The rows disagree on ${label}.`); else if (v[0] === '' || v[0] == null) fail(name, `${label} is blank in the report.`); else if (want == null || v[0] !== String(want)) fail(name, `${label} in the report (${v[0]}) is not the one we stored (${want ?? 'unknown'}).`); };
  const orig = db.prepare("SELECT number, shipment_key FROM invoices WHERE seller_id=? AND number=? AND kind='invoice'").get(sellerId, rect.rectifies);
  if (!orig) fail('original-invoice', `The original invoice ${rect.rectifies} is not one of ours.`);
  let mp = null; try { mp = orig ? JSON.parse(db.prepare('SELECT raw FROM shipments WHERE seller_id=? AND key=?').get(sellerId, orig.shipment_key)?.raw ?? 'null')?.marketplace : null; } catch { mp = null; }
  same('marketplace-id', r => r.marketplace ?? '', mp, 'the marketplace');
  same('order-id', r => r.orderId ?? '', rj?.orderId, 'the order id'); same('shipping-id', r => r.shippingId ?? '', rj?.shippingId, 'the shipping id');
  same('currency', r => r.currency ?? '', rj?.currency, 'the currency');
  const types = uniq(rows.map(r => r.type ?? '')); if (types.length !== 1 || !types[0] || `${types[0]}:${rows[0].transactionId}` !== rect.shipment_key) fail('transaction', 'The transaction type and id of the rows are not those of our credit note.');
  // the original VAT invoice number, only when the report carries it
  const ov = uniq(rows.map(r => r.originalInvoiceNumber ?? '')); if (ov.length > 1) fail('original-invoice-number', 'The rows disagree on the original invoice number.'); else if (ov[0] && ov[0] !== rect.rectifies) fail('original-invoice-number', `The report names original invoice ${ov[0]}, not ${rect.rectifies}.`);
  // financial values: the sum of the report's amount columns against OUR credit note, sign as it is (no absolute values). Unknown sign or any difference = HOLD.
  const sumIncl = rows.reduce((a, r) => a + cents(r.incl), 0), sumVat = rows.reduce((a, r) => a + cents(r.vat), 0);
  if (rj?.totals == null) fail('amounts', 'Our credit note has no totals.');
  else if (sumIncl !== cents(rj.totals.incl) || sumVat !== cents(rj.totals.vat)) fail('amounts', `The report amounts (incl ${(sumIncl / 100).toFixed(2)}, VAT ${(sumVat / 100).toFixed(2)}) are not our credit note's (incl ${Number(rj.totals.incl).toFixed(2)}, VAT ${Number(rj.totals.vat).toFixed(2)}), signs compared as they are. The sign convention of Amazon refund rows is not proven by a real report, so a difference is held, not corrected.`);
  return failed.length ? { ok: false, code: 'CREDIT_NOTE_IDENTITY_UNPROVEN', failed } : { ok: true };
}
/** The normalized evidence a hold is about: the ACTUAL values of the report rows, the status set, the report order and time, and the identity of our stored credit note. No full report, no buyer personal data. */
export function evidenceSnapshot(s, rect, { reportSeq = null, reportReqTs = null } = {}) {
  const rows = s.rowMeta ?? []; const u = (f) => uniq(rows.map(f)).sort();
  const sum = (f) => rows.reduce((a, r) => a + cents(f(r)), 0);
  return { documentNumbers: u(r => r.invoiceNumber ?? ''), transactionTypes: u(r => r.type ?? ''), transactionIds: u(r => r.transactionId ?? ''), orderIds: u(r => r.orderId ?? ''), shippingIds: u(r => r.shippingId ?? ''), marketplaces: u(r => r.marketplace ?? ''), currencies: u(r => r.currency ?? ''), originalInvoiceNumbers: u(r => r.originalInvoiceNumber ?? ''),
    statuses: u(r => r.status ?? ''), rowCount: rows.length, sumInclCents: sum(r => r.incl), sumVatCents: sum(r => r.vat), signInclCents: Math.sign(sum(r => r.incl)),
    reportSeq: Number.isInteger(reportSeq) ? reportSeq : null, reportRequestedAt: reportReqTs != null && !Number.isNaN(new Date(reportReqTs).getTime()) ? new Date(reportReqTs).toISOString() : null,
    storedNumber: rect?.number ?? null, storedHash: rect?.json ? createHash('sha256').update(String(rect.json)).digest('hex').slice(0, 16) : null };
}
/** Open (or refresh) the human-review hold for this credit note. No document is changed. The fingerprint covers the actual evidence snapshot, so different evidence is a CHANGED finding and an old human decision never covers it. Other open credit-note holds of the same key are kept. */
export function openCreditNoteHold(db, sellerId, key, code, failed, extra = {}) {
  const { snapshot = null, ...rest } = extra;
  const evidence = { field: 'credit-note-acceptance', reversalKey: key, failed: failed.map(f => f.c), snapshot, ...rest };
  const f = { code, severity: 'HOLD', resolution: 'HUMAN_DECISION', fingerprint: createHash('sha256').update(JSON.stringify([code, key, evidence, failed.map(x => x.why)])).digest('hex'), evidence,
    explanation: failed.map(x => x.why).join(' '), action: 'A person compares the Amazon report row with our credit note before anything else is done. Nothing was changed automatically and no replacement invoice is issued from this.' };
  writeLedger(db, sellerId, key, [f], { partial: true }); logEvent(db, sellerId, 'credit_note_hold', { key, code, failed: evidence.failed });
}
/** Is a credit-note hold open on this original's pair (any of its credit notes, or the given key)? Friendly pre-check; the database trigger is the enforcement. */
export function pairHoldOpen(db, sellerId, originalNumber, key = null) {
  const keys = db.prepare("SELECT DISTINCT shipment_key k FROM invoices WHERE seller_id=? AND kind='rectificativa' AND rectifies=?").all(sellerId, originalNumber).map(r => r.k); if (key) keys.push(key);
  return keys.some(k => hasOpenCreditNoteHold(db, sellerId, k));
}
export const hasOpenCreditNoteHold = (db, sellerId, key) => !!db.prepare(`SELECT 1 FROM integrity_findings WHERE seller_id=? AND shipment_key=? AND status='OPEN' AND code IN (${CN_HOLD_CODES.map(() => '?').join(',')})`).get(sellerId, key, ...CN_HOLD_CODES);
