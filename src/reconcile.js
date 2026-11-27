// Reconciliation engine (read-only). Implements docs/EVIDENCE-CONTRACT.md.
// Pure module: no node imports, no network, no database, so the same file runs in the server and in the browser bundle.
// Input: VIDR imports plus what the seller declared about each one. Output: per-document state with its evidence, and counts.
// RULE 0: no state is inferred. A state is shown only when a named row says so; a missing row never means accepted.
import { parseTable } from './manual.js';

/** Literal strings, checked against Amazon's VCS developer guide section 6.1 (status table). Matching is exact (whitespace trimmed only). */
export const STATUS_MAP = Object.freeze({
  InvoicePending: 'PENDING', CreditNotePending: 'PENDING',
  InvoiceProcessing: 'PROCESSING', CreditNoteProcessing: 'PROCESSING',
  InvoiceUploaded: 'ACCEPTED', CreditNoteUploaded: 'ACCEPTED',
  InvoiceRejected: 'REJECTED', CreditNoteRejected: 'REJECTED',
});
/** Real Amazon statuses that mean no seller invoice is due. Shown as NOT_APPLICABLE, never as pending or accepted. */
export const NOT_DUE = Object.freeze(['NoTaxCalculated', 'InvoiceCreatedByAmazon']);

export const REPORT_TYPE = 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT';
const REQUIRED_COLUMNS = ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'invoice-status'];
const KEY_FIELDS = ['marketplace-id', 'order-id', 'shipping-id', 'transaction-id', 'transaction-type'];
const DAY = 86400000;
const isoDay = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null;
const ms = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const uniq = (a) => [...new Set(a)];

/** How a transaction relates to a correction cycle (Amazon guide 6.3.4: REFUND "CorrectionReversal...", SHIPMENT "Correction:..."). */
export function correctionRole(txId, txType) {
  const id = String(txId ?? '');
  if (id.startsWith('CorrectionReversal')) return 'REVERSAL';
  if (id.startsWith('Correction:')) return 'CORRECTED';
  return null;
}

const check = (name, ok, how, detail) => ({ name, ok, how, detail }); // how: 'from-file' | 'declared-by-seller' | 'from-declared-dates'

/** Import-level facts. Nothing here is proof of how the file was made: the declarations are the seller's words. */
export function classifyImport(imp, parsed) {
  const d = imp.declared ?? {}, head = parsed.head ?? [], problems = [];
  const missingCols = REQUIRED_COLUMNS.filter(c => !head.includes(c));
  if (parsed.unsupported) problems.push(parsed.unsupported);
  if (missingCols.length) problems.push(`Columns missing from the file: ${missingCols.join(', ')}`);
  const options = String(d.options ?? 'UNKNOWN').toUpperCase();
  if (options !== 'ALL') problems.push(options === 'PENDING_ONLY' ? 'Declared as the pending-only report: it leaves out invoices Amazon already accepted.' : 'The report version was not declared (all statuses or pending only).');
  const from = isoDay(d.rangeFrom), to = isoDay(d.rangeTo);
  const spanDays = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1 : null;
  if (options === 'ALL') {
    if (!from || !to) problems.push('No date range was declared.');
    else if (spanDays < 1) problems.push('The declared date range ends before it starts.');
    else if (spanDays > 30) problems.push(`The declared date range is ${spanDays} days. Amazon's all-statuses report allows at most 30.`);
  }
  const dates = parsed.rows.map(r => isoDay(r['order-date'])).filter(Boolean).sort();
  const outside = from && to ? parsed.rows.filter(r => { const x = isoDay(r['order-date']); return x && (x < from || x > to); }).length : 0;
  if (outside) problems.push(`${outside} row(s) have an order date outside the declared range.`);
  const warnings = [];
  const seen = new Set(parsed.rows.map(r => String(r['invoice-status'] ?? '').trim()));
  if (options === 'ALL' && parsed.rows.length && ![...seen].some(s => ['InvoiceUploaded', 'CreditNoteUploaded', 'InvoiceProcessing', 'CreditNoteProcessing', 'InvoiceCreatedByAmazon'].includes(s)))
    warnings.push('Declared as all statuses, but the file has only pending, rejected or not-due rows. It looks like a pending-only report. Check the download.');
  return {
    id: imp.id, fileName: imp.fileName ?? null, sha256: imp.sha256 ?? null, rows: parsed.rows.length,
    scope: problems.length ? 'INCOMPLETE_SOURCE' : 'COMPLETE_SCOPE', problems, warnings,
    declared: { reportType: d.reportType ?? null, options, rangeFrom: from, rangeTo: to, spanDays, marketplace: d.marketplace ?? null, createdAt: d.createdAt ?? null, downloadedAt: d.downloadedAt ?? null, createdAfterUploadConfirmed: d.createdAfterUploadConfirmed === true, obtainedHow: d.obtainedHow ?? null, labelledAs: 'declared by the seller, not verified by InvoiceGuard' },
    fileOrderDates: dates.length ? { first: dates[0], last: dates.at(-1) } : null,
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
    const raws = uniq(o.rows.map(r => String(r['invoice-status'] ?? '').trim())), nums = uniq(o.rows.map(r => r['invoice-number'] ?? '').filter(Boolean));
    const f = o.rows[0]; o.parts = Object.fromEntries(KEY_FIELDS.map(k => [k, f[k]])); o.itemIds = uniq(o.rows.map(r => r['order-item-id']));
    o.conflicts = [];
    if (raws.length > 1) o.conflicts.push(`Rows of this document disagree on invoice-status: ${raws.map(x => JSON.stringify(x)).join(' vs ')}`);
    if (nums.length > 1) o.conflicts.push(`Rows of this document carry different invoice numbers: ${nums.join(', ')}`);
    o.raw = raws[0] ?? ''; o.invoiceNumber = nums[0] ?? null; o.statusDescription = uniq(o.rows.map(r => r['invoice-status-description'] ?? '').filter(Boolean)).join(' | ') || null;
    o.mapped = o.conflicts.length ? 'UNMATCHED' : STATUS_MAP[o.raw] ?? (NOT_DUE.includes(o.raw) ? 'NOT_APPLICABLE' : 'UNKNOWN_STATUS');
    o.unmatchedReason = o.conflicts.length ? 'AMBIGUOUS' : null;
    if (o.mapped === 'ACCEPTED') {
      const d = imp.declared ?? {}, od = isoDay(f['order-date']), pre = [];
      pre.push(check('all-status report', cls.declared.options === 'ALL', 'declared-by-seller', `declared option: ${cls.declared.options}. The file cannot prove which option was used.`));
      pre.push(check('report type stored', d.reportType === REPORT_TYPE, 'declared-by-seller', `declared type: ${d.reportType ?? 'none'}`));
      pre.push(check('range no longer than 30 days', cls.declared.spanDays !== null && cls.declared.spanDays >= 1 && cls.declared.spanDays <= 30, 'from-declared-dates', cls.declared.spanDays === null ? 'no range declared' : `${cls.declared.rangeFrom} to ${cls.declared.rangeTo} (${cls.declared.spanDays} days). Checked on the declared dates only.`));
      pre.push(check('range covers the order date', !!(od && cls.declared.rangeFrom && cls.declared.rangeTo && od >= cls.declared.rangeFrom && od <= cls.declared.rangeTo), 'from-file', `order-date ${od ?? 'blank'} (UTC day) against the declared range`));
      pre.push(check('marketplace matches', !!(d.marketplace && d.marketplace === f['marketplace-id']), 'declared-by-seller', `declared ${d.marketplace ?? 'none'}, row ${f['marketplace-id']}`));
      pre.push(check('report created after the upload', cls.declared.createdAfterUploadConfirmed && ms(d.createdAt) !== null, 'declared-by-seller', 'The file has no creation time. The seller confirmed it, with a creation time, or it is unmet.'));
      pre.push(check('download time stored', ms(d.downloadedAt) !== null, 'declared-by-seller', `downloadedAt: ${d.downloadedAt ?? 'none'}`));
      pre.push(check('file hash stored', /^[0-9a-f]{64}$/.test(imp.sha256 ?? ''), 'from-file', 'SHA-256 of the raw file, computed on this device. It shows the file is unchanged since import, not where it came from.'));
      pre.push(check('how the file was obtained stored', !!String(d.obtainedHow ?? '').trim(), 'declared-by-seller', d.obtainedHow ?? 'none'));
      pre.push(check('document number present', !!o.invoiceNumber, 'from-file', o.invoiceNumber ?? 'invoice-number is blank'));
      pre.push(check('rows agree (no conflict)', !o.conflicts.length, 'from-file', o.conflicts.join('; ') || 'all rows of the document agree'));
      o.preconditions = pre; o.unmet = pre.filter(p => !p.ok).map(p => p.name);
      if (o.unmet.length) o.mapped = 'INCOMPLETE_SOURCE';
    }
  }
  return { observations: [...obs.values()], unkeyed };
}

const EXPLAIN = {
  ACCEPTED: (c) => `In the file loaded on ${c.date}, Amazon showed this document as processed with no error (status ${c.raw}).`,
  PROCESSING: (c) => `In the file loaded on ${c.date}, Amazon showed this document as received and still being processed (status ${c.raw}).`,
  PENDING: (c) => `In the file loaded on ${c.date}, Amazon showed this document as waiting for the seller's upload (status ${c.raw}).`,
  REJECTED: (c) => `In the file loaded on ${c.date}, Amazon showed an error in the upload (status ${c.raw}). Amazon says the seller must upload this document again.`,
  INCOMPLETE_SOURCE: (c) => `The file says ${c.raw}, but the file or its declared settings cannot support showing it as accepted: ${c.why}`,
  UNMATCHED: (c) => `We could not tie this to one document with confidence: ${c.why}`,
  UNKNOWN_STATUS: (c) => `The file has a status we do not recognise (${JSON.stringify(c.raw)}). We did not guess. This is counted as cannot determine.`,
  NOT_APPLICABLE: (c) => `In the file loaded on ${c.date}, Amazon showed ${c.raw}: no seller invoice is due for this one.`,
  PARTIALLY_ACCEPTED: (c) => `One side of this correction is accepted and the other is not. The correction counts as open until both sides are.`,
};

/**
 * @param {Array<{id:string, text?:string, rows?:object[], sha256?:string, fileName?:string, importedAt?:string, declared?:object}>} imports
 * Order of the array does not matter: the result depends only on the evidence and its times.
 */
export function reconcile(imports) {
  const importSummaries = [], byDoc = new Map(), unkeyedAll = [], warnings = [];
  for (const imp of imports) {
    const parsed = imp.rows ? { head: Object.keys(imp.rows[0] ?? {}), rows: imp.rows } : parseTable(imp.text ?? '');
    const cls = classifyImport(imp, parsed); importSummaries.push(cls);
    cls.warnings.forEach(w => warnings.push({ importId: imp.id, warning: w }));
    const { observations, unkeyed } = observe(imp, cls, parsed);
    unkeyed.forEach(r => unkeyedAll.push({ importId: imp.id, row: r }));
    for (const o of observations) { o.importScope = cls.scope; if (!byDoc.has(o.key)) byDoc.set(o.key, []); byDoc.get(o.key).push(o); }
  }
  const docs = [];
  for (const [key, list] of byDoc) {
    const sorted = [...list].sort((a, b) => (a.et.t ?? -Infinity) - (b.et.t ?? -Infinity) || String(a.importId).localeCompare(String(b.importId)));
    const last = sorted.at(-1), sameTime = sorted.filter(o => o.et.t !== null && o.et.t === last.et.t);
    let cur = last, why = null;
    if (sameTime.length > 1 && uniq(sameTime.map(o => o.mapped + '|' + o.raw)).length > 1) { cur = { ...last, mapped: 'UNMATCHED', unmatchedReason: 'AMBIGUOUS' }; why = 'Two reports with the same time show different statuses for it.'; }
    if (last.et.t === null && sorted.length > 1) { cur = { ...last, mapped: 'UNMATCHED', unmatchedReason: 'AMBIGUOUS' }; why = 'Reports without any time cannot be put in order.'; }
    if (cur.conflicts?.length) why = cur.conflicts.join('; ');
    const anomalies = [];
    const rank = { PENDING: 0, PROCESSING: 1, REJECTED: 1, ACCEPTED: 2 };
    const prevBest = sorted.slice(0, -1).filter(o => o.mapped in rank).sort((a, b) => rank[b.mapped] - rank[a.mapped])[0];
    if (prevBest && cur.mapped in rank && rank[cur.mapped] < rank[prevBest.mapped]) anomalies.push(`A later report shows ${cur.raw}, an earlier one showed ${prevBest.raw}. The later report decides the current state.`);
    const role = correctionRole(cur.parts['transaction-id'], cur.parts['transaction-type']);
    const date = cur.et.iso ? cur.et.iso.slice(0, 10) : 'unknown date';
    const ctx = { raw: cur.raw, date, why: why ?? (cur.unmet?.length ? `unmet: ${cur.unmet.join(', ')}.` : 'import scope is incomplete.') };
    docs.push({
      key, parts: cur.parts, itemIds: cur.itemIds, state: cur.mapped, unmatchedReason: cur.unmatchedReason ?? null, rawStatus: cur.raw, ownState: cur.mapped,
      correction: role ? { role, cycleKey: null, cycleState: null } : null,
      current: { importId: cur.importId, effectiveTime: cur.et.iso, timeBasis: cur.et.basis, importScope: cur.importScope },
      history: sorted.map(o => ({ importId: o.importId, effectiveTime: o.et.iso, timeBasis: o.et.basis, rawStatus: o.raw, mapped: o.mapped, current: o === last })),
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
    const missing = [!rev.length && 'reversal (credit note) side', !cor.length && 'corrected invoice side'].filter(Boolean);
    cycleList.push({ key: k, state, missing, sides: sides.map(s => s.key) });
    for (const s of sides) { s.correction.cycleState = state; s.correction.missingSides = missing; if (state === 'PARTIALLY_ACCEPTED' && s.ownState === 'ACCEPTED') s.state = 'PARTIALLY_ACCEPTED'; }
  }
  for (const d of docs) {
    const c = d.ctx; delete d.ctx;
    d.explanation = (EXPLAIN[d.state] ?? (() => d.state))(c);
    if (d.correction && d.state === 'PARTIALLY_ACCEPTED') d.explanation += d.correction.missingSides?.length ? ` Not in the loaded files: ${d.correction.missingSides.join(', ')}.` : '';
  }
  docs.sort((a, b) => a.key.localeCompare(b.key));
  return { docs, imports: importSummaries, cycles: cycleList, unkeyed: unkeyedAll, warnings, headline: headline(docs, cycleList, unkeyedAll, importSummaries) };
}

/** Counts computed from the evidence above. "cannot determine" is a count of its own. */
export function headline(docs, cycles, unkeyed, importSummaries) {
  const n = (s) => docs.filter(d => d.state === s).length;
  const cannot = n('INCOMPLETE_SOURCE') + n('UNMATCHED') + n('UNKNOWN_STATUS') + unkeyed.length;
  const open = cycles.filter(c => c.state !== 'ACCEPTED').length;
  const counts = { documents: docs.length, accepted: n('ACCEPTED'), processing: n('PROCESSING'), pending: n('PENDING'), rejected: n('REJECTED'), notApplicable: n('NOT_APPLICABLE'), correctionCyclesNotClosed: open, cannotDetermine: cannot,
    cannotDetermineParts: { incompleteSource: n('INCOMPLETE_SOURCE'), unmatched: n('UNMATCHED'), unknownStatus: n('UNKNOWN_STATUS'), rowsWithoutKey: unkeyed.length } };
  const exceptions = counts.rejected + open + cannot;
  const sentence = `Out of ${counts.documents} document(s) in the loaded files: ${exceptions} exception(s): ${counts.rejected} rejected by Amazon, ${open} correction(s) not closed on both sides, ${cannot} we cannot determine. ${counts.processing + counts.pending} in progress (pending or processing), ${counts.accepted} accepted. State of the files as loaded; it says nothing about files that were not loaded.`;
  return { ...counts, exceptions, accountingComparison: 'not available: needs the seller invoice export (Issued is not visible in the Amazon files)', sentence, anyCompleteImport: importSummaries.some(i => i.scope === 'COMPLETE_SCOPE') };
}

/** Evidence log for one ACCEPTED document (contract section F). Returns null for anything else: no log, no acceptance. */
export function evidenceLog(doc, imports, summaries) {
  if (doc.state !== 'ACCEPTED') return null;
  const imp = imports.find(i => i.id === doc.current.importId), cls = summaries.find(i => i.id === doc.current.importId);
  return {
    contract: 'EVIDENCE-CONTRACT v1', document: doc.parts,
    importedReport: { id: imp.id, fileName: imp.fileName ?? null, sha256: imp.sha256, sha256Means: 'the file is unchanged since import; it does not show where the file came from' },
    howObtained: imp.declared?.obtainedHow, declaredBySeller: cls.declared, reportType: imp.declared?.reportType,
    importedAt: imp.importedAt ?? null, effectiveTime: doc.current.effectiveTime, timeBasis: doc.current.timeBasis,
    matchedRows: doc.evidence.rows, documentNumber: doc.evidence.invoiceNumber, transactionId: doc.evidence.transactionId,
    finalStatusAmazonReported: doc.evidence.rawStatusVerbatim, statusDescription: doc.evidence.statusDescription,
    preconditions: doc.evidence.preconditions, history: doc.history,
    notVerifiedAutomatically: ['all-status option', 'report created after the upload', 'how the file was obtained'],
  };
}

/** The four stages of the contract for one document, each with its evidence or NOT VISIBLE. */
export function stages(doc) {
  const h = doc.history, rows = doc.evidence.rows, f = rows[0] ?? {};
  const first = h.find(x => x.mapped !== 'NOT_APPLICABLE' && x.mapped !== 'UNKNOWN_STATUS');
  const upl = h.find(x => ['PROCESSING', 'ACCEPTED', 'REJECTED'].includes(x.mapped) || x.rawStatus in STATUS_MAP && STATUS_MAP[x.rawStatus] !== 'PENDING');
  const hasDue = !!first;
  return {
    expected: hasDue ? { state: 'EVIDENCE', source: `import ${first.importId}`, columns: { 'is-business-order': f['is-business-order'] ?? null, 'is-amazon-invoiced': f['is-amazon-invoiced'] ?? null, 'invoice-status': first.rawStatus, 'shipment-date': f['shipment-date'] ?? null }, seenAt: first.effectiveTime, documentId: doc.key } : { state: 'NOT VISIBLE' },
    issued: { state: 'NOT VISIBLE in these files', why: 'The seller invoice system is not one of the loaded files. invoice-number in the Amazon report is Amazon\'s record of an upload.' },
    uploaded: upl ? { state: 'EVIDENCE', source: `import ${upl.importId}`, column: 'invoice-status', value: upl.rawStatus, seenAt: upl.effectiveTime, documentId: doc.evidence.invoiceNumber ?? 'NOT VISIBLE', note: 'first report that shows an upload; seenAt is when that report was made or downloaded, not the upload time' } : { state: 'NOT VISIBLE' },
    accepted: doc.state === 'ACCEPTED' ? { state: 'EVIDENCE', source: `import ${doc.current.importId}`, column: 'invoice-status', value: doc.rawStatus, asOf: doc.current.effectiveTime, documentId: doc.evidence.invoiceNumber, transactionId: doc.evidence.transactionId, declaredBySeller: true } : { state: 'NOT SHOWN', currentState: doc.state },
  };
}
