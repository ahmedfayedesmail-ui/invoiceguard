// Reconciliation engine (read-only). Implements docs/EVIDENCE-CONTRACT.md.
// Pure module: no node imports, no network, no database, so the same file runs in the server and in the browser bundle.
// Input: VIDR imports plus what the seller declared about each one. Output: per-document state with its evidence, and counts.
// RULE 0: no state is inferred. A state is shown only when a named row says so; a missing row never means accepted.
// STRUCTURE: the string 'ACCEPTED' is produced in exactly one place, gateAccepted(). Every other path from a status string stops at
// ACCEPTED_CANDIDATE, which is not a state anyone sees. The gate takes the import classification and the truncation flag.
import { parseTable } from './manual.js';
import { classifyTransactionId } from './txid.js';

/** Literal strings, from Amazon's status table (SP-API "Create and upload invoices"; VCS guide 6.1 has 10 of the 11). Exact match, whitespace trimmed only. */
export const STATUS_MAP = Object.freeze({
  InvoicePending: 'PENDING', CreditNotePending: 'PENDING',
  InvoiceProcessing: 'PROCESSING', CreditNoteProcessing: 'PROCESSING',
  InvoiceUploaded: 'ACCEPTED', CreditNoteUploaded: 'ACCEPTED',
  InvoiceRejected: 'REJECTED', CreditNoteRejected: 'REJECTED',
  // Amazon made the document: the seller owes no upload. Kept strictly apart from every seller-upload state.
  InvoiceCreatedByAmazon: 'CREATED_BY_AMAZON', CreditNoteCreatedByAmazon: 'CREATED_BY_AMAZON',
  // Amazon did NOT calculate the tax: the SELLER must upload the invoice. This creates an obligation, it is not a shrug.
  NoTaxCalculated: 'SELLER_UPLOAD_REQUIRED',
});
export const KNOWN_STATUSES = Object.freeze(Object.keys(STATUS_MAP));
/** Which transaction types each status family may appear with. Invoice* belongs to SHIPMENT, CreditNote* to REFUND or RETURN.
 *  NoTaxCalculated is not restricted by Amazon's table ("the seller must upload the invoice for this transaction"), so it is allowed with all three. */
export const TRANSACTION_TYPES = Object.freeze(['SHIPMENT', 'REFUND', 'RETURN']);
const FAMILY = Object.freeze(Object.fromEntries(KNOWN_STATUSES.map(k => [k, k.startsWith('Invoice') ? 'invoice' : k.startsWith('CreditNote') ? 'credit' : 'any'])));
export function statusTypeCompatibility(raw, type) {
  const fam = FAMILY[raw], t = String(type ?? '').trim();
  if (!fam) return { ok: true };
  if (!TRANSACTION_TYPES.includes(t)) return { ok: false, code: 'UNKNOWN_TRANSACTION_TYPE', why: `the transaction type ${JSON.stringify(t)} is not SHIPMENT, REFUND or RETURN` };
  if (fam === 'any') return { ok: true };
  if (fam === 'invoice' && t === 'SHIPMENT') return { ok: true };
  if (fam === 'credit' && (t === 'REFUND' || t === 'RETURN')) return { ok: true };
  return { ok: false, code: 'FAMILY_MISMATCH', why: fam === 'invoice' ? `${raw} is an invoice status and belongs with SHIPMENT, not ${t}` : `${raw} is a credit note status and belongs with REFUND or RETURN, not ${t}` };
}

export const REPORT_TYPE = 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT';
const REQUIRED_COLUMNS = ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'invoice-status', 'invoice-number', 'order-date'];
const KEY_FIELDS = ['marketplace-id', 'order-id', 'shipping-id', 'transaction-id', 'transaction-type'];
const DAY = 86400000;
const validDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return m >= 1 && m <= 12 && d >= 1 && d <= 31 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const iso3 = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** DECLARED dates (the seller's own settings typed into our page, a date picker): ISO YYYY-MM-DD, whole string, real calendar day. A different parser from the file's. */
const declaredDay = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim()); return m && validDay(+m[1], +m[2], +m[3]) ? iso3(+m[1], +m[2], +m[3]) : null; };
const isoDay = declaredDay; // used for the declared range only
/** FILE dates (Amazon's own column `order-date`). Amazon's documented example is 17/05/2018 (DD/MM/YYYY), source:
 *  https://developer-docs.amazon/sp-api/docs/report-type-values-invoice-data . No other format is documented, so no other format is accepted.
 *  The whole string is matched (no prefix matching). Returns the two readings; which one applies is decided per FILE, never per value. */
const FILE_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
function fileDateReadings(v) {
  const t = String(v ?? '').trim(); if (t === '') return { kind: 'blank' };
  const m = FILE_DATE.exec(t); if (!m) return { kind: 'unrecognized' };
  const a = +m[1], b = +m[2], y = +m[3];
  const dayFirst = validDay(y, b, a) ? iso3(y, b, a) : null, monthFirst = validDay(y, a, b) ? iso3(y, a, b) : null;
  if (!dayFirst && !monthFirst) return { kind: 'impossible' };
  return { kind: 'ok', dayFirst, monthFirst, provesDayFirst: !!dayFirst && a > 12, provesMonthFirst: !!monthFirst && b > 12 };
}
/** Per-file date reading. DD/MM/YYYY is the ONLY accepted format. A value that proves month-first (second field over 12) is not a parse path:
 *  it makes the file unreadable (MONTH_FIRST_NOT_SUPPORTED, with the value as the example). A value that proves day-first (first field over 12)
 *  proves the order. If at least one valid date exists and every valid date is ambiguous, nothing in the file proves the order: the order is
 *  UNCONFIRMED and the seller must confirm DD/MM/YYYY at import (a declaration, not a verification). With no valid date at all there is no
 *  order and no assumption is claimed. */
export function readFileDates(rows) {
  const rd = rows.map(r => fileDateReadings(r['order-date']));
  const count = (k) => rd.filter(x => x.kind === k).length;
  const out = { blank: count('blank'), unrecognized: count('unrecognized'), impossible: count('impossible'), order: null, basis: null, days: rows.map(() => null), contradiction: false, monthFirstExample: null, needsConfirmation: false };
  const dayProof = rd.filter(x => x.provesDayFirst).length, monthIdx = rd.findIndex(x => x.provesMonthFirst);
  if (dayProof && monthIdx >= 0) { out.contradiction = true; out.monthFirstExample = String(rows[monthIdx]['order-date']).trim(); return out; }
  if (monthIdx >= 0) { out.monthFirstExample = String(rows[monthIdx]['order-date']).trim(); return out; }
  const valid = rd.filter(x => x.kind === 'ok').length;
  if (!valid) return out;
  out.order = 'DAY_FIRST';
  out.basis = dayProof ? 'proven by values in the file' : 'not proven by the file: every valid date is ambiguous, so the seller must confirm DD/MM/YYYY (a declaration, not verified by us)';
  out.needsConfirmation = !dayProof;
  out.days = rd.map(x => x.kind === 'ok' ? x.dayFirst : null);
  rd.forEach((x, i) => { if (x.kind === 'ok' && out.days[i] === null) out.impossible++; }); // real only as month-first: not readable under the documented order
  return out;
}
const ROW_DAY = new WeakMap(); // row object -> ISO day read from the file by readFileDates
const blank = (v) => !String(v ?? '').trim();
/** Single exported contract version. docs/EVIDENCE-CONTRACT.md states the same string on its first line; a test fails if they differ. */
export const CONTRACT_VERSION = 'v1.5';
export const CONTRACT_LABEL = `EVIDENCE-CONTRACT ${CONTRACT_VERSION}`;
const ms = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const uniq = (a) => [...new Set(a)];

export const correctionRole = (txId, txType) => classifyTransactionId(txId, txType).role;
const check = (name, ok, how, detail) => ({ name, ok, how, detail }); // how: 'from-file' | 'declared-by-seller' | 'from-declared-dates'

/** Import-level facts. Nothing here is proof of how the file was made: the declarations are the seller's words.
 *  problemCodes: TRUNCATED_FILE, MISSING_COLUMNS, NOT_ALL_STATUSES, NO_RANGE, RANGE_INVALID, RANGE_TOO_LONG, ROWS_OUTSIDE_RANGE, UNSUPPORTED_FORMAT. */
export function classifyImport(imp, parsed) {
  const d = imp.declared ?? {}, head = parsed.head ?? [], problems = [], add = (code, text) => problems.push({ code, text });
  const missingCols = REQUIRED_COLUMNS.filter(c => !head.includes(c));
  if (parsed.unsupported) add('UNSUPPORTED_FORMAT', parsed.unsupported);
  if (missingCols.length) add('MISSING_COLUMNS', `Columns missing from the file: ${missingCols.join(', ')}`);
  if (parsed.truncated) add('TRUNCATED_FILE', 'Only part of the file was read: the reader stops after a fixed number of rows and this file has more. Nothing from a partly read file can be shown as accepted.');
  const options = String(d.options ?? 'UNKNOWN').toUpperCase();
  if (options !== 'ALL') add('NOT_ALL_STATUSES', options === 'PENDING_ONLY' ? 'Declared as the pending-only report: it leaves out invoices Amazon already accepted.' : 'The report version was not declared (all statuses or pending only).');
  const from = isoDay(d.rangeFrom), to = isoDay(d.rangeTo);
  const spanDays = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1 : null;
  if (options === 'ALL') {
    if (!from || !to) add('NO_RANGE', 'No date range was declared.');
    else if (spanDays < 1) add('RANGE_INVALID', 'The declared date range ends before it starts.');
    else if (spanDays > 30) add('RANGE_TOO_LONG', `The declared date range is ${spanDays} days. Amazon's all-statuses report allows at most 30.`);
  }
  // Every row must carry a valid order-date, a full key, an item id and a status. A row that lacks one is never dropped: it fails the import.
  const fd = readFileDates(parsed.rows); parsed.rows.forEach((r, i) => ROW_DAY.set(r, fd.days[i]));
  if (fd.monthFirstExample && !fd.contradiction) add('MONTH_FIRST_NOT_SUPPORTED', `The order dates in this file look month-first (for example ${JSON.stringify(fd.monthFirstExample)}). Amazon documents DD/MM/YYYY for this report, so this file cannot be read as it is. Download the report again and load it unchanged.`);
  if (fd.contradiction) add('DATE_ORDER_CONTRADICTION', 'The order dates in this file contradict each other: some can only be day/month/year and others only month/day/year. We do not guess. Download the report again and load it unchanged.');
  if (fd.unrecognized) add('UNRECOGNIZED_DATE_FORMAT', `${fd.unrecognized} order date(s) in the file are not in a format we recognise. Amazon documents DD/MM/YYYY (for example 17/05/2018). This file is not shown as a complete read.`);
  if (fd.impossible) add('MISSING_OR_INVALID_ORDER_DATE', `${fd.impossible} order date(s) are not real calendar days (for example 31/02/2018) or cannot be read in the order the rest of the file uses.`);
  if (fd.blank) add('MISSING_OR_INVALID_ORDER_DATE', `${fd.blank} row(s) have an empty order date. Every row needs one, so this file is not shown as a complete read.`);
  if (parsed.blankLines) add('BLANK_LINE_IN_DATA', `${parsed.blankLines} blank line(s) sit between records. A blank line can hide a broken row, so the file is not shown as a complete read. Download the report again and load it unchanged.`);
  if (parsed.raggedRows) add('RAGGED_ROWS', `${parsed.raggedRows} row(s) have a different number of columns from the header.`);
  const noKey = parsed.rows.filter(r => KEY_FIELDS.some(k => blank(r[k]))).length;
  if (noKey) add('ROWS_WITHOUT_KEY', `${noKey} row(s) have a blank marketplace, order, shipping, transaction id or transaction type, so they cannot be tied to a document. They are not dropped: the import is incomplete.`);
  const noReq = parsed.rows.filter(r => blank(r['order-item-id']) || blank(r['invoice-status'])).length;
  if (noReq) add('MISSING_REQUIRED_VALUE', `${noReq} row(s) have a blank order-item-id or invoice-status.`);
  const dates = fd.days.filter(x => x !== null).sort();
  const outside = from && to ? fd.days.filter(x => x !== null && (x < from || x > to)).length : 0;
  if (outside) add('ROWS_OUTSIDE_RANGE', `${outside} row(s) have an order date outside the declared range. The range is checked against the order date, because Amazon's all-statuses report covers orders placed within the period.`);
  const warnings = [];
  const confirmed = String(d.dateOrderConfirmed ?? '').trim() === 'DD/MM/YYYY';
  if (fd.needsConfirmation) warnings.push(confirmed ? 'Every valid order date in this file is ambiguous between day/month and month/day. The seller confirmed DD/MM/YYYY at import (declared by the seller, not verified by us).' : 'Every valid order date in this file is ambiguous between day/month and month/day. Nothing in the file proves the order, so nothing is shown as accepted until the seller confirms DD/MM/YYYY, the format Amazon documents for this report.');
  const seen = new Set(parsed.rows.map(r => String(r['invoice-status'] ?? '').trim()));
  if (options === 'ALL' && parsed.rows.length && ![...seen].some(s => ['InvoiceUploaded', 'CreditNoteUploaded', 'InvoiceProcessing', 'CreditNoteProcessing', 'InvoiceCreatedByAmazon', 'CreditNoteCreatedByAmazon'].includes(s)))
    warnings.push('Declared as all statuses, but the file has only pending, rejected or other not-yet-uploaded rows. It looks like a pending-only report. Check the download.');
  if (parsed.truncated) warnings.push('Only part of this file was read.');
  return {
    id: imp.id, fileName: imp.fileName ?? null, sha256: imp.sha256 ?? null, rows: parsed.rows.length, truncated: !!parsed.truncated,
    scope: problems.length ? 'INCOMPLETE_SOURCE' : 'COMPLETE_SCOPE', problems: problems.map(p => p.text), problemCodes: problems.map(p => p.code), warnings,
    declared: { reportType: d.reportType ?? null, options, rangeFrom: from, rangeTo: to, spanDays, marketplace: d.marketplace ?? null, createdAt: d.createdAt ?? null, downloadedAt: d.downloadedAt ?? null, createdAfterUploadConfirmed: d.createdAfterUploadConfirmed === true, dateOrderConfirmed: confirmed ? 'DD/MM/YYYY' : null, obtainedHow: d.obtainedHow ?? null, labelledAs: 'declared by the seller, not verified by InvoiceGuard' },
    dateOrder: fd.order ? { order: fd.order, basis: fd.basis, provenByFile: !fd.needsConfirmation, sellerConfirmed: fd.needsConfirmation ? confirmed : null, confirmationLabel: fd.needsConfirmation ? 'declared by the seller, not verified by InvoiceGuard' : null } : null, fileOrderDates: dates.length ? { first: dates[0], last: dates.at(-1) } : null,
    importedAt: imp.importedAt ?? null,
  };
}

/** Time used to order reports. The seller-confirmed creation time wins; else download time; else import time. The basis is always reported. */
function effectiveTime(imp) {
  const d = imp.declared ?? {};
  for (const [k, v] of [['createdAt (seller-confirmed)', d.createdAt], ['downloadedAt (declared)', d.downloadedAt], ['importedAt', imp.importedAt]]) { const t = ms(v); if (t !== null) return { t, basis: k, iso: new Date(t).toISOString() }; }
  return { t: null, basis: 'none', iso: null };
}

const docKey = (r) => KEY_FIELDS.map(k => r[k] ?? '').join('|');

/**
 * THE gate. The only function that returns 'ACCEPTED'. It takes the import classification and the truncation flag as arguments:
 * a document from an import that is not COMPLETE_SCOPE, or from a truncated file, can never be ACCEPTED, whatever its row says.
 * Anything that does not pass is INCOMPLETE_SOURCE with the unmet checks named.
 */
function gateAccepted({ cls, truncated, imp, row, invoiceNumber, conflicts }) {
  const d = imp.declared ?? {}, od = ROW_DAY.get(row) ?? null, pre = [];
  pre.push(check('file was read in full', !truncated, 'from-file', truncated ? 'only part of the file was read' : 'all rows were read'));
  pre.push(check('import is complete (every import-level check passed)', cls.scope === 'COMPLETE_SCOPE', 'from-file', cls.problems.join(' ') || 'no import-level problem'));
  pre.push(check('all-status report', cls.declared.options === 'ALL', 'declared-by-seller', `declared option: ${cls.declared.options}. The file cannot prove which option was used.`));
  pre.push(check('report type stored', d.reportType === REPORT_TYPE, 'declared-by-seller', `declared type: ${d.reportType ?? 'none'}`));
  pre.push(check('range no longer than 30 days', cls.declared.spanDays !== null && cls.declared.spanDays >= 1 && cls.declared.spanDays <= 30, 'from-declared-dates', cls.declared.spanDays === null ? 'no range declared' : `${cls.declared.rangeFrom} to ${cls.declared.rangeTo} (${cls.declared.spanDays} days). Checked on the declared dates only.`));
  pre.push(check('range covers the order date', !!(od && cls.declared.rangeFrom && cls.declared.rangeTo && od >= cls.declared.rangeFrom && od <= cls.declared.rangeTo), 'from-file', `order-date ${od ?? 'blank'} (UTC day) against the declared range`));
  pre.push(check('marketplace matches', !!(d.marketplace && d.marketplace === row['marketplace-id']), 'declared-by-seller', `declared ${d.marketplace ?? 'none'}, row ${row['marketplace-id']}`));
  pre.push(check('report created after the upload', cls.declared.createdAfterUploadConfirmed && ms(d.createdAt) !== null, 'declared-by-seller', 'The file has no creation time. The seller confirmed it, with a creation time, or it is unmet.'));
  { const o = cls.dateOrder, conflict = cls.dateOrderConflict ?? null;
    pre.push(check('date order known', !!o && (o.provenByFile || (o.sellerConfirmed === true && !conflict)), o && o.provenByFile ? 'from-file' : 'declared-by-seller',
      !o ? 'no readable order date, so the order is not known' : o.provenByFile ? 'a value in the file proves DD/MM/YYYY' : conflict ? `the seller confirmed DD/MM/YYYY for this import, but ${conflict}. A confirmation does not carry across files and is not silently overridden.` : o.sellerConfirmed ? 'nothing in the file proves the order; the seller confirmed DD/MM/YYYY at import (declared, not verified)' : 'nothing in the file proves the order and the seller has not confirmed DD/MM/YYYY')); }
  pre.push(check('download time stored', ms(d.downloadedAt) !== null, 'declared-by-seller', `downloadedAt: ${d.downloadedAt ?? 'none'}`));
  pre.push(check('file hash stored', /^[0-9a-f]{64}$/.test(imp.sha256 ?? ''), 'from-file', 'SHA-256 of the raw file, computed on this device. It shows the file is unchanged since import, not where it came from.'));
  pre.push(check('how the file was obtained stored', !!String(d.obtainedHow ?? '').trim(), 'declared-by-seller', d.obtainedHow ?? 'none'));
  pre.push(check('document number present', !!invoiceNumber, 'from-file', invoiceNumber ?? 'invoice-number is blank'));
  pre.push(check('rows agree (no conflict)', !conflicts.length, 'from-file', conflicts.join('; ') || 'all rows of the document agree'));
  const unmet = pre.filter(p => !p.ok);
  const reasonCode = !unmet.length ? null : (unmet.length === 1 && unmet[0].name === 'date order known' && !cls.problems.length) ? 'DATE_ORDER_UNCONFIRMED' : !truncated ? (cls.problemCodes.includes('MISSING_COLUMNS') ? 'MISSING_COLUMNS' : cls.problemCodes.includes('MONTH_FIRST_NOT_SUPPORTED') ? 'MONTH_FIRST_NOT_SUPPORTED' : cls.problemCodes.includes('UNRECOGNIZED_DATE_FORMAT') ? 'UNRECOGNIZED_DATE_FORMAT' : cls.problemCodes.includes('DATE_ORDER_CONTRADICTION') ? 'DATE_ORDER_CONTRADICTION' : cls.problemCodes.includes('MISSING_OR_INVALID_ORDER_DATE') ? 'MISSING_OR_INVALID_ORDER_DATE' : unmet.some(p => p.name.startsWith('import is complete')) ? 'IMPORT_NOT_COMPLETE' : 'PRECONDITION_UNMET') : 'TRUNCATED_FILE';
  const onlyDate = unmet.length === 1 && unmet[0].name === 'date order known' && !cls.problems.length;
  return { state: !unmet.length ? 'ACCEPTED' : onlyDate ? 'DATE_ORDER_UNCONFIRMED' : 'INCOMPLETE_SOURCE', preconditions: pre, unmet: unmet.map(p => p.name), unmetDetail: unmet.map(p => `${p.name} (${p.detail})`).join('; '), reasonCode };
}

/** Per-document observation in ONE import. Conflicts inside it block acceptance. */
function observe(imp, cls, parsed) {
  const obs = new Map(), unkeyed = [];
  const et = effectiveTime(imp);
  for (const r of parsed.rows) {
    if (KEY_FIELDS.some(k => !String(r[k] ?? '').trim())) { unkeyed.push(r); continue; }
    const k = docKey(r); if (!obs.has(k)) obs.set(k, { key: k, importId: imp.id, et, rows: [], duplicateRows: 0 });
    const o = obs.get(k), same = o.rows.find(x => JSON.stringify(x) === JSON.stringify(r));
    if (same) o.duplicateRows++; else o.rows.push(r);
  }
  for (const o of obs.values()) {
    const raws = uniq(o.rows.map(r => String(r['invoice-status'] ?? '').trim())), allNums = uniq(o.rows.map(r => String(r['invoice-number'] ?? '').trim())), nums = allNums.filter(x => x !== ''), mixedBlank = nums.length >= 1 && allNums.includes('');
    const f = o.rows[0]; o.parts = Object.fromEntries(KEY_FIELDS.map(k => [k, f[k]])); o.itemIds = uniq(o.rows.map(r => r['order-item-id']));
    o.conflicts = []; o.mixedBlank = mixedBlank;
    if (raws.length > 1) o.conflicts.push(`Rows of this document disagree on invoice-status: ${raws.map(x => JSON.stringify(x)).join(' vs ')}`);
    if (nums.length > 1) o.conflicts.push(`Rows of this document carry different invoice numbers: ${nums.join(', ')}`);
    o.raw = raws[0] ?? ''; o.invoiceNumber = mixedBlank ? null : (nums[0] ?? null); o.statusDescription = uniq(o.rows.map(r => String(r['invoice-status-description'] ?? '').trim()).filter(x => x !== '')).join(' | ') || null;
    const tx = classifyTransactionId(f['transaction-id'], f['transaction-type']), compat = statusTypeCompatibility(o.raw, f['transaction-type']);
    o.tx = tx; o.reasonCode = null; o.why = null;
    if (tx.unknown) { o.mapped = 'UNKNOWN_TRANSACTION_ID_FORMAT'; o.why = tx.why; }
    else if (o.conflicts.length) { o.mapped = 'UNMATCHED'; o.unmatchedReason = 'AMBIGUOUS'; o.why = o.conflicts.join('; '); }
    else if (mixedBlank) { o.mapped = 'INVOICE_NUMBER_INCOMPLETE'; o.why = `Some rows of this document carry the invoice number ${nums.map(x => JSON.stringify(x)).join(', ')} and others have it blank. A blank is treated as a value, so the rows do not agree.`; }
    else if (!(o.raw in STATUS_MAP)) o.mapped = 'UNKNOWN_STATUS';
    else if (!compat.ok) { o.mapped = 'INCOMPATIBLE_STATUS_AND_TYPE'; o.why = compat.why; o.reasonCode = compat.code; }
    else if (STATUS_MAP[o.raw] === 'ACCEPTED') {
      const g = gateAccepted({ cls, truncated: cls.truncated, imp, row: f, invoiceNumber: o.invoiceNumber, conflicts: o.conflicts });
      o.mapped = g.state; o.preconditions = g.preconditions; o.unmet = g.unmet; o.reasonCode = g.reasonCode; o.why = g.unmetDetail || null;
    } else o.mapped = STATUS_MAP[o.raw];
    o.times = { reportCreated: { value: imp.declared?.createdAt ?? null, source: 'declared by the seller' }, downloaded: { value: imp.declared?.downloadedAt ?? null, source: 'declared by the seller' }, imported: { value: imp.importedAt ?? null, source: 'recorded by InvoiceGuard at import' } };
  }
  return { observations: [...obs.values()], unkeyed };
}

const EXPLAIN = {
  // Wording rule: a report shows the state it shows on the day it was made. It never shows when that state began, so there is no "accepted on".
  ACCEPTED: (c) => `Observed as ${c.raw} in the report dated ${c.date} ${c.dn}. Amazon's report shows the final successful state. It does not show when that state began.`,
  PROCESSING: (c) => `Observed as ${c.raw} in the report dated ${c.date} ${c.dn}: Amazon has the upload and is still processing it.`,
  PENDING: (c) => `Observed as ${c.raw} in the report dated ${c.date} ${c.dn}: Amazon is waiting for the seller's upload.`,
  SELLER_UPLOAD_REQUIRED: (c) => `Observed as ${c.raw} in the report dated ${c.date} ${c.dn}. Amazon did not calculate the tax for this transaction, so the seller must upload the invoice. Nothing has been uploaded as far as this report shows. This is an exception.`,
  REJECTED: (c) => `Observed as ${c.raw} in the report dated ${c.date} ${c.dn}: Amazon found errors in the upload. Amazon says the seller must upload this document again.`,
  CREATED_BY_AMAZON: (c) => `Observed as ${c.raw} in the report dated ${c.date} ${c.dn}: Amazon made this document itself. The seller has nothing to upload for it.`,
  INCOMPLETE_SOURCE: (c) => `The file says ${c.raw}, but it is not shown as accepted. ${c.why}`,
  UNMATCHED: (c) => `We could not tie this to one document with confidence: ${c.why}`,
  UNKNOWN_STATUS: (c) => `The file has a status we do not recognise (${JSON.stringify(c.raw)}). We did not guess. This is counted as cannot determine.`,
  UNKNOWN_TRANSACTION_ID_FORMAT: (c) => `The transaction id starts with "Correction" but is not one of the known shapes (${c.why}). We did not treat it as a correction and did not treat it as an ordinary transaction. This is counted as cannot determine.`,
  DATE_ORDER_UNCONFIRMED: (c) => `The file says ${c.raw}, but it is not shown as accepted: nothing in the file proves whether its dates are day/month or month/day. ${c.why} Confirm DD/MM/YYYY (the format Amazon documents) when importing, and the other checks will run.`,
  INVOICE_NUMBER_INCOMPLETE: (c) => `The rows of this document do not agree on the invoice number. ${c.why} It is not shown as accepted and it is counted as cannot determine.`,
  INCOMPATIBLE_STATUS_AND_TYPE: (c) => `The status ${c.raw} cannot go with this transaction type: ${c.why}. The row is refused. It is not shown as accepted, rejected or pending, and it is counted as cannot determine.`,
  PARTIALLY_ACCEPTED: () => `One side of this correction was observed as accepted and the other was not. The correction counts as open until both sides are.`,
};

/**
 * @param {Array<{id:string, text?:string, rows?:object[], sha256?:string, fileName?:string, importedAt?:string, declared?:object, truncated?:boolean}>} imports
 * Order of the array does not matter: the result depends only on the evidence and its times.
 */
export function reconcile(imports) {
  const importSummaries = [], byDoc = new Map(), unkeyedAll = [], warnings = [];
  const pre = imports.map(imp => { const parsed = imp.rows ? { head: Object.keys(imp.rows[0] ?? {}), rows: imp.rows, truncated: !!imp.truncated } : parseTable(imp.text ?? ''); const cls = classifyImport(imp, parsed); return { imp, parsed, cls }; });
  // A confirmation is a per-import declaration. It never follows the seller to another file, and a later file that contradicts it is surfaced.
  const monthFirst = pre.filter(x => x.cls.problemCodes.includes('MONTH_FIRST_NOT_SUPPORTED') || x.cls.problemCodes.includes('DATE_ORDER_CONTRADICTION'));
  const dateOrderConflicts = [];
  for (const x of pre) if (x.cls.dateOrder?.sellerConfirmed) for (const m of monthFirst) { if (m.cls.id === x.cls.id) continue; x.cls.dateOrderConflict = `import ${m.cls.id} contains dates that look month-first`; dateOrderConflicts.push({ confirmedImport: x.cls.id, contradictingImport: m.cls.id, note: 'The seller confirmed DD/MM/YYYY for the first import; the second contains a month-first value. Nothing is overridden silently.' }); }
  for (const { imp, parsed, cls } of pre) {
    importSummaries.push(cls);
    if (cls.dateOrderConflict) warnings.push({ importId: imp.id, warning: `The seller confirmed DD/MM/YYYY for this import, but ${cls.dateOrderConflict}. The confirmation is not applied.` });
    cls.warnings.forEach(w => warnings.push({ importId: imp.id, warning: w }));
    const { observations, unkeyed } = observe(imp, cls, parsed);
    unkeyed.forEach(r => unkeyedAll.push({ importId: imp.id, row: r }));
    for (const o of observations) { o.importScope = cls.scope; if (!byDoc.has(o.key)) byDoc.set(o.key, []); byDoc.get(o.key).push(o); }
  }
  const docs = [];
  const snap = (o) => ({ importId: o.importId, rawStatus: o.raw, mapped: o.mapped, times: o.times, rows: o.rows, invoiceNumber: o.invoiceNumber, transactionId: o.parts['transaction-id'], statusDescription: o.statusDescription });
  for (const [key, list] of byDoc) {
    const sorted = [...list].sort((a, b) => (a.et.t ?? -Infinity) - (b.et.t ?? -Infinity) || String(a.importId).localeCompare(String(b.importId)));
    const last = sorted.at(-1), sameTime = sorted.filter(o => o.et.t !== null && o.et.t === last.et.t);
    let cur = last, why = null;
    if (sameTime.length > 1 && uniq(sameTime.map(o => o.mapped + '|' + o.raw)).length > 1) { cur = { ...last, mapped: 'UNMATCHED', unmatchedReason: 'AMBIGUOUS' }; why = 'Two reports with the same time show different statuses for it.'; }
    if (last.et.t === null && sorted.length > 1) { cur = { ...last, mapped: 'UNMATCHED', unmatchedReason: 'AMBIGUOUS' }; why = 'Reports without any time cannot be put in order.'; }
    if (!why) why = cur.why;
    const anomalies = [];
    const rank = { PENDING: 0, SELLER_UPLOAD_REQUIRED: 0, PROCESSING: 1, REJECTED: 1, ACCEPTED: 2 };
    const prevBest = sorted.slice(0, -1).filter(o => o.mapped in rank).sort((a, b) => rank[b.mapped] - rank[a.mapped])[0];
    if (prevBest && cur.mapped in rank && rank[cur.mapped] < rank[prevBest.mapped]) anomalies.push(`A later report shows ${cur.raw} (${cur.mapped.toLowerCase()}); we kept the earlier ${prevBest.raw} in history. The later report decides the current state.`);
    const role = classifyTransactionId(cur.parts['transaction-id'], cur.parts['transaction-type']).role;
    const date = cur.et.iso ? cur.et.iso.slice(0, 10) : 'unknown date';
    const accObs = sorted.find(o => o.mapped === 'ACCEPTED'), firstObs = sorted[0];
    const ctx = { raw: cur.raw, date, dn: cur.et.basis.startsWith('createdAt') ? '(date as declared by the seller)' : cur.et.basis.startsWith('downloadedAt') ? '(download date as declared by the seller; no creation date was given)' : '(import date recorded by InvoiceGuard; the seller gave no report date)', why: why ?? 'import scope is incomplete.' };
    docs.push({
      key, parts: cur.parts, itemIds: cur.itemIds, state: cur.mapped, reasonCode: cur.reasonCode ?? null, unmatchedReason: cur.unmatchedReason ?? null, rawStatus: cur.raw, ownState: cur.mapped,
      correction: role ? { role, cycleKey: null, cycleState: null } : null,
      current: { importId: cur.importId, effectiveTime: cur.et.iso, timeBasis: cur.et.basis, importScope: cur.importScope },
      // Every observation keeps its OWN snapshot of the matched rows. Stages read only their own snapshot.
      history: sorted.map(o => ({ ...snap(o), effectiveTime: o.et.iso, timeBasis: o.et.basis, current: o === last })),
      firstObserved: { ...snap(firstObs), meaning: 'first report of those loaded that shows this document, as that report shows it; not the moment it happened' },
      acceptedObserved: accObs ? { ...snap(accObs), meaning: `first report of those loaded that shows ${accObs.raw} with every precondition met; it does not show when Amazon reached that state` } : null,
      evidence: { rows: cur.rows, invoiceNumber: cur.invoiceNumber, transactionId: cur.parts['transaction-id'], statusDescription: cur.statusDescription, rawStatusVerbatim: cur.raw, preconditions: cur.preconditions ?? null, duplicateRowsIgnored: cur.duplicateRows },
      anomalies, ctx,
    });
  }
  // Correction cycles: both sides must be independently accepted (guide 6.3.4: a credit note for the reversal AND a new invoice for the corrected transaction).
  const cycles = new Map();
  for (const d of docs) if (d.correction) { const k = `${d.parts['marketplace-id']}|${d.parts['order-id']}|${d.parts['shipping-id']}`; d.correction.cycleKey = k; if (!cycles.has(k)) cycles.set(k, []); cycles.get(k).push(d); }
  const cycleList = [];
  for (const [k, sides] of cycles) {
    const rev = sides.filter(s => s.correction.role === 'REVERSAL'), cor = sides.filter(s => s.correction.role === 'CORRECTED');
    const okSide = (a) => a.length === 1 && a[0].ownState === 'ACCEPTED';
    const accepted = (okSide(rev) ? 1 : 0) + (okSide(cor) ? 1 : 0);
    const state = accepted === 2 ? 'ACCEPTED' : accepted === 1 ? 'PARTIALLY_ACCEPTED' : 'NOT_CLOSED';
    const missing = [!rev.length && 'reversal (credit note) side', !cor.length && 'corrected invoice side'].filter(x => x !== false);
    cycleList.push({ key: k, state, missing, sides: sides.map(s => s.key) });
    for (const s of sides) { s.correction.cycleState = state; s.correction.missingSides = missing; if (state === 'PARTIALLY_ACCEPTED' && s.ownState === 'ACCEPTED') s.state = 'PARTIALLY_ACCEPTED'; }
  }
  for (const d of docs) {
    const c = d.ctx; delete d.ctx;
    d.explanation = (EXPLAIN[d.state] ?? (() => d.state))(c);
    if (d.correction && d.state === 'PARTIALLY_ACCEPTED') d.explanation += d.correction.missingSides?.length ? ` Not in the loaded files: ${d.correction.missingSides.join(', ')}.` : '';
  }
  docs.sort((a, b) => a.key.localeCompare(b.key));
  return { docs, imports: importSummaries, dateOrderConflicts, cycles: cycleList, unkeyed: unkeyedAll, warnings, headline: headline(docs, cycleList, unkeyedAll, importSummaries) };
}

/** Counts computed from the evidence above. Per-document states use documents (rows with a full key) as the denominator. Rows without a key are
 *  their own line and never enter that denominator. `exceptions` counts distinct documents, so it can never exceed `documents`. */
export function headline(docs, cycles, unkeyed, importSummaries) {
  const n = (s) => docs.filter(d => d.state === s).length, inc = (code) => docs.filter(d => d.state === 'INCOMPLETE_SOURCE' && d.reasonCode === code).length;
  const parts = { truncatedFile: inc('TRUNCATED_FILE'), missingColumns: inc('MISSING_COLUMNS'), importNotComplete: inc('IMPORT_NOT_COMPLETE'), preconditionUnmet: inc('PRECONDITION_UNMET'), orderDateMissingOrUnreadable: inc('MISSING_OR_INVALID_ORDER_DATE'), dateFormatUnrecognized: inc('UNRECOGNIZED_DATE_FORMAT') + inc('DATE_ORDER_CONTRADICTION') + inc('MONTH_FIRST_NOT_SUPPORTED'), dateOrderUnconfirmed: n('DATE_ORDER_UNCONFIRMED'), invoiceNumberIncomplete: n('INVOICE_NUMBER_INCOMPLETE'), unmatched: n('UNMATCHED'), unknownStatus: n('UNKNOWN_STATUS'), unknownTransactionIdFormat: n('UNKNOWN_TRANSACTION_ID_FORMAT'), incompatibleStatusAndType: n('INCOMPATIBLE_STATUS_AND_TYPE') };
  const cannot = Object.values(parts).reduce((a, b) => a + b, 0);
  const openCycles = cycles.filter(c => c.state !== 'ACCEPTED'), openDocKeys = new Set(openCycles.flatMap(c => c.sides));
  const EXC = ['REJECTED', 'SELLER_UPLOAD_REQUIRED', 'INCOMPLETE_SOURCE', 'UNMATCHED', 'UNKNOWN_STATUS', 'UNKNOWN_TRANSACTION_ID_FORMAT', 'INCOMPATIBLE_STATUS_AND_TYPE', 'INVOICE_NUMBER_INCOMPLETE', 'DATE_ORDER_UNCONFIRMED'];
  const exceptions = docs.filter(d => EXC.includes(d.state) || openDocKeys.has(d.key)).length;
  const counts = { documents: docs.length, accepted: n('ACCEPTED'), partiallyAccepted: n('PARTIALLY_ACCEPTED'), processing: n('PROCESSING'), pending: n('PENDING'), rejected: n('REJECTED'), sellerUploadRequired: n('SELLER_UPLOAD_REQUIRED'), createdByAmazon: n('CREATED_BY_AMAZON'),
    correctionCyclesNotClosed: openCycles.length, cannotDetermine: cannot, cannotDetermineParts: parts, rowsWithoutKey: unkeyed.length };
  const sentence = `Out of ${counts.documents} document(s) in the loaded files: ${exceptions} document(s) with an exception (one document can be in more than one line below): ${counts.rejected} rejected by Amazon, ${counts.sellerUploadRequired} where the seller must upload the invoice and nothing is uploaded (NoTaxCalculated), ${counts.correctionCyclesNotClosed} correction(s) not closed on both sides, ${cannot} we cannot determine (${parts.truncatedFile} from a partly read file, ${parts.missingColumns} from a file with missing columns, ${parts.importNotComplete} from another incomplete import, ${parts.preconditionUnmet} with an unmet check, ${parts.orderDateMissingOrUnreadable} with a missing or unreadable order date, ${parts.dateFormatUnrecognized} with dates in a format we do not recognise, that look month-first or that contradict each other, ${parts.dateOrderUnconfirmed} waiting for the seller to confirm the date format, ${parts.invoiceNumberIncomplete} with an invoice number blank on some rows, ${parts.unmatched} unmatched, ${parts.unknownStatus} unknown status, ${parts.unknownTransactionIdFormat} unknown correction id format, ${parts.incompatibleStatusAndType} status that does not fit the transaction type). ${counts.processing + counts.pending} in progress (pending or processing), ${counts.accepted} observed as accepted, ${counts.createdByAmazon} created by Amazon (nothing to upload). Separately, ${counts.rowsWithoutKey} row(s) have a blank key field and are not counted as documents. State of the files as loaded; it says nothing about files that were not loaded.`;
  return { ...counts, exceptions, accountingComparison: 'not available: needs the seller invoice export (Issued is not visible in the Amazon files)', sentence, anyCompleteImport: importSummaries.some(i => i.scope === 'COMPLETE_SCOPE') };
}

/** Evidence log for one ACCEPTED document (contract section 9). Returns null for anything else: no log, no acceptance. */
export function evidenceLog(doc, imports, summaries) {
  if (doc.state !== 'ACCEPTED') return null;
  const imp = imports.find(i => i.id === doc.current.importId), cls = summaries.find(i => i.id === doc.current.importId);
  return {
    contract: CONTRACT_LABEL, document: doc.parts,
    importedReport: { id: imp.id, fileName: imp.fileName ?? null, sha256: imp.sha256, sha256Means: 'the file is unchanged since import; it does not show where the file came from' },
    howObtained: imp.declared?.obtainedHow, declaredBySeller: cls.declared, reportType: imp.declared?.reportType,
    importedAt: imp.importedAt ?? null, times: doc.history.find(h => h.current).times, effectiveTime: doc.current.effectiveTime, timeBasis: doc.current.timeBasis,
    dateReading: { dateOrder: cls.dateOrder?.order ?? null, dateOrderBasis: cls.dateOrder?.basis ?? null, sellerConfirmedDateOrder: cls.dateOrder?.sellerConfirmed ?? null, confirmationLabel: cls.dateOrder?.confirmationLabel ?? null, fileOrderDates: cls.fileOrderDates, dateWarnings: cls.warnings.filter(w => /order date|DD\/MM\/YYYY|ambiguous/.test(w)) },
    acceptedObserved: doc.acceptedObserved, firstObserved: doc.firstObserved, matchedRows: doc.evidence.rows, documentNumber: doc.evidence.invoiceNumber, transactionId: doc.evidence.transactionId,
    finalStatusAmazonReported: doc.evidence.rawStatusVerbatim, statusDescription: doc.evidence.statusDescription,
    preconditions: doc.evidence.preconditions, history: doc.history.map(({ rows, ...h }) => ({ ...h, rowCount: rows.length })),
    notVerifiedAutomatically: ['all-status option', 'report created after the upload', 'how the file was obtained', ...(cls.dateOrder?.provenByFile === false ? ['date order (confirmed by the seller, not proven by the file)'] : [])],
  };
}

/** The four stages for one document. Each stage reads ONLY its own report's snapshot (history entry). If its snapshot cannot support the stage, it says so. */
export function stages(doc) {
  const h = doc.history;
  const isUploadState = (x) => ['PROCESSING', 'ACCEPTED', 'REJECTED'].includes(x.mapped) || (x.mapped === 'INCOMPLETE_SOURCE' && ['PROCESSING', 'ACCEPTED', 'REJECTED'].includes(STATUS_MAP[x.rawStatus]));
  // Expected is evidenced ONLY by states that prove an upload (or re-upload) is owed. Processing, accepted and incomplete-source are not such evidence.
  const dueStates = ['PENDING', 'REJECTED', 'SELLER_UPLOAD_REQUIRED'];
  const processing = h.find(x => x.mapped === 'PROCESSING');
  const amzEntry = h.find(x => x.mapped === 'CREATED_BY_AMAZON'), first = h.find(x => dueStates.includes(x.mapped)), upl = h.find(isUploadState);
  const col = (entry, c) => entry.rows[0]?.[c] ?? null;
  return {
    expected: amzEntry ? { state: 'NOT DUE', why: 'Amazon made this document. The seller owes no upload.', value: amzEntry.rawStatus, source: `import ${amzEntry.importId}` }
      : first ? { state: 'EVIDENCE', source: `import ${first.importId}`, columns: { 'is-business-order': col(first, 'is-business-order'), 'is-amazon-invoiced': col(first, 'is-amazon-invoiced'), 'invoice-status': first.rawStatus, 'shipment-date': col(first, 'shipment-date') }, observedInReportDated: first.effectiveTime, times: first.times, documentId: doc.key, obligation: first.rawStatus === 'NoTaxCalculated' ? 'Amazon did not calculate the tax: the seller must upload the invoice (Amazon status table)' : first.mapped === 'REJECTED' ? 'Re-upload required: Amazon found errors in the upload and says the seller must upload this document again' : 'Amazon is waiting for the seller\'s upload' }
      : processing ? { state: 'NO NEW UPLOAD REQUIRED', why: 'Amazon has the upload and is processing it. No new action is required of the seller on this evidence.', source: `import ${processing.importId}` }
      : { state: 'NOT VISIBLE', why: 'No loaded report shows a state that proves an upload is owed. An accepted or incomplete document is not evidence of Expected.' },
    issued: { state: 'NOT VISIBLE in these files', why: 'The seller invoice system is not one of the loaded files. invoice-number in the Amazon report is Amazon\'s record of an upload.' },
    uploaded: amzEntry && !upl ? { state: 'NOT APPLICABLE', why: 'Created by Amazon, not uploaded by the seller.' } : upl ? { state: 'EVIDENCE', source: `import ${upl.importId}`, column: 'invoice-status', value: upl.rawStatus, firstObservedInReportDated: upl.effectiveTime, times: upl.times, documentId: upl.invoiceNumber ?? 'NOT VISIBLE in that report', note: 'first report that shows an upload; the dates are when that report was made or downloaded, not the upload time. The document id is the number in that same report.' } : { state: 'NOT VISIBLE' },
    accepted: doc.state === 'ACCEPTED' && doc.acceptedObserved ? { state: 'EVIDENCE', source: `import ${doc.acceptedObserved.importId}`, column: 'invoice-status', value: doc.acceptedObserved.rawStatus, observedAsInReportDated: doc.acceptedObserved.times.reportCreated.value, times: doc.acceptedObserved.times, documentId: doc.acceptedObserved.invoiceNumber, transactionId: doc.acceptedObserved.transactionId, declaredBySeller: true, note: 'Observed as this status in that report. It is not the date Amazon accepted it.' } : { state: 'NOT SHOWN', currentState: doc.state },
  };
}
