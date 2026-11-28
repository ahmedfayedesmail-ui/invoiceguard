// Ruling 5 (Ahmed, WhatsApp 2026-11-28 15:27, forwarded verbatim by Main): an ORIGINAL (SHIPMENT) invoice is marked uploaded, processing or rejected only when the report PROVES the row is OUR document.
// This is NOT a copy of the credit-note gate. It is built for what an original invoice's report row carries: the document number (All view), the SHIPMENT transaction, order, shipping, marketplace, currency and
// the amounts, with zero tolerance and the sign as it is. Any required field that is missing, blank, split across rows or different = HOLD, and the status is applied by nothing. A full match only applies the status.
// Evidence-bound transition: (1) meaning of the record: exact status literal on a SHIPMENT row, (2) identity of the document, (3) recency: the authenticated report's attempt sequence against our attempt,
// (4) certainty of the external operation: the status verdict is Amazon's own document-level statement. Three exits: proven (apply), unresolved (HOLD, no change), manual authorization (never for this gate).
import { createHash } from 'node:crypto';
import { writeLedger, resolveGateFinding } from './integrity.js';
import { logEvent } from './db.js';
const cents = (x) => Math.round(Number(x) * 100);
const uniq = (a) => [...new Set(a)];
export const ORIG_HOLD = 'ORIGINAL_INVOICE_VERDICT_UNPROVEN';
export const RETURN_HOLD = 'RETURN_ROW_INVOICE_STATUS';
export function evaluateOriginalVerdict(db, sellerId, s, inv, { reportSeq, expect } = {}) {
  const failed = []; const rows = s.rowMeta ?? []; const fail = (c, why) => failed.push({ c, why });
  if (!rows.length) return { ok: false, failed: [{ c: 'rows', why: 'The report carries no row detail for this shipment.' }] };
  const statuses = uniq(rows.map(r => r.status ?? ''));
  if (statuses.length !== 1) return { ok: false, failed: [{ c: 'rows-agree-on-status', why: `The rows of this shipment carry different statuses (${statuses.map(x => JSON.stringify(x)).join(', ')}). No row was picked.` }] };
  if (statuses[0] !== expect) fail('status', `The status is not exactly ${expect}.`);
  const types = uniq(rows.map(r => r.type ?? '')); if (types.length !== 1 || types[0] !== 'SHIPMENT') fail('transaction-type', `The rows are not all SHIPMENT rows (${types.map(x => JSON.stringify(x)).join(', ')}).`);
  if (!Number.isInteger(reportSeq)) fail('authenticated-report', 'This report did not come with the sequence of the authenticated download, so its order against our upload attempts is unknown.');
  else if (inv.attempt_seq != null && inv.attempt_seq > reportSeq) fail('report-recency', 'Our current upload attempt is newer than this report, so the report cannot describe it.');
  const doc = (() => { try { return JSON.parse(inv.json); } catch { return null; } })();
  if (!doc) fail('stored-invoice', 'Our stored invoice could not be read.');
  if (!s.invoiceNumberColumn) fail('invoice-number', 'The report has no invoice-number column (use the All view): Amazon\'s document number cannot be compared.');
  else { const nums = uniq(rows.map(r => r.invoiceNumber ?? '')); if (nums.length !== 1) fail('invoice-number', 'The rows of this shipment disagree on the document number.'); else if (nums[0] === '') fail('invoice-number', 'The document number in the report is blank.'); else if (nums[0] !== inv.number) fail('invoice-number', `The report names document ${nums[0]}, not ours (${inv.number}).`); }
  const same = (name, get, want, label) => { const v = uniq(rows.map(get)); if (v.length !== 1) fail(name, `The rows disagree on ${label}.`); else if (v[0] === '' || v[0] == null) fail(name, `${label} is blank in the report.`); else if (want == null || want === '' || v[0] !== want) fail(name, `${label} in the report (${v[0]}) is not the one on our invoice (${want ?? 'unknown'}).`); };
  let mp = null; try { mp = JSON.parse(db.prepare('SELECT raw FROM shipments WHERE seller_id=? AND key=?').get(sellerId, inv.shipment_key)?.raw ?? 'null')?.marketplace ?? null; } catch { mp = null; }
  same('marketplace-id', r => r.marketplace ?? '', mp, 'the marketplace'); same('order-id', r => r.orderId ?? '', doc?.orderId, 'the order id'); same('shipping-id', r => r.shippingId ?? '', doc?.shippingId, 'the shipping id'); same('currency', r => r.currency ?? '', doc?.currency, 'the currency');
  if (`SHIPMENT:${doc?.shippingId}` !== inv.shipment_key || s.key !== inv.shipment_key) fail('transaction', 'The transaction of the rows is not the shipment of our invoice.');
  const sumIncl = rows.reduce((a, r) => a + cents(r.incl), 0), sumVat = rows.reduce((a, r) => a + cents(r.vat), 0);
  if (doc?.totals == null) fail('amounts', 'Our invoice has no totals.');
  else if (sumIncl !== cents(doc.totals.incl) || sumVat !== cents(doc.totals.vat)) fail('amounts', `The report amounts (incl ${(sumIncl / 100).toFixed(2)}, VAT ${(sumVat / 100).toFixed(2)}) are not our invoice's (incl ${Number(doc.totals.incl).toFixed(2)}, VAT ${Number(doc.totals.vat).toFixed(2)}). Sign and amount must match exactly.`);
  return failed.length ? { ok: false, failed } : { ok: true };
}
export function openOriginalHold(db, sellerId, key, failed, { number, status, reportSeq = null }) {
  const evidence = { field: 'original-invoice-verdict', documentNumber: number, reportStatus: status, failed: failed.map(f => f.c), reportSeq: Number.isInteger(reportSeq) ? reportSeq : null };
  writeLedger(db, sellerId, key, [{ code: ORIG_HOLD, severity: 'HOLD', resolution: 'NEW_EVIDENCE', evidence, fingerprint: createHash('sha256').update(JSON.stringify([ORIG_HOLD, key, evidence, failed.map(x => x.why)])).digest('hex'),
    explanation: failed.map(x => x.why).join(' '), action: 'Nothing was changed: the status was not applied. A corrected, authenticated report that matches our document exactly resolves this.' }], { partial: true });
  logEvent(db, sellerId, 'original_verdict_held', { number, status, failed: evidence.failed });
}
export const resolveOriginalHold = (db, sellerId, key) => resolveGateFinding(db, sellerId, key, ORIG_HOLD, 'a later report proves the document exactly');
export function openReturnHold(db, sellerId, s, { reportSeq = null } = {}) {
  const evidence = { field: 'return-row-invoice-status', reportStatus: s.invoiceStatus, transactionType: 'RETURN', transactionIds: uniq((s.rowMeta ?? []).map(r => r.transactionId ?? '')).sort(), orderIds: uniq((s.rowMeta ?? []).map(r => r.orderId ?? '')).sort(), reportSeq: Number.isInteger(reportSeq) ? reportSeq : null };
  writeLedger(db, sellerId, s.key, [{ code: RETURN_HOLD, severity: 'HOLD', resolution: 'NEW_EVIDENCE', evidence, fingerprint: createHash('sha256').update(JSON.stringify([RETURN_HOLD, s.key, evidence])).digest('hex'),
    explanation: `A RETURN row carries the status ${s.invoiceStatus}. What Amazon means by that is not proven, so it was not read as a verdict on the original invoice, the credit note or the replacement.`,
    action: 'Nothing was changed. Only documented Amazon evidence of what this combination means, or a corrected report, resolves it.' }], { partial: true });
  logEvent(db, sellerId, 'return_row_invoice_status_hold', { key: s.key, status: s.invoiceStatus });
}
