// Manual path: the seller downloads an order report from Seller Central and uploads it here. No Amazon connection.
// Verified against Amazon's API documentation only (developer-docs.amazon.com, report type pages); NOT against real downloaded files yet.
// Every column that is not documented is optional. Anything we cannot read exactly is held with a reason, never guessed.
import { assessShipment } from './integrity-core.js';
import { parseVidr, needsInvoice, readFlag, unknownFlags, heldForUnknownFlags, unknownFlagsReason } from './vidr.js';

export const FORMATS = {
  vidr: 'VAT Invoice Data Report',
  order: 'Order Report (with buyer VAT columns)',
  allorders: 'All Orders Report',
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const MAX_ROWS = 20000;

/** Reads a tab-separated Amazon flat file. DECISION on blank lines: leading and trailing blank lines are file terminators and are ignored.
 *  A blank line BETWEEN records is a corrupt record, never a separator: it is counted in `blankLines` (and any row with the wrong number of cells in
 *  `raggedRows`), nothing is dropped silently, and the reconciliation treats the import as incomplete. */
export function parseTable(text) {
  text = String(text ?? '').replace(/^\uFEFF/, '');
  const all = text.split(/\r?\n/), isBlank = (l) => !l.trim();
  let lo = 0, hi = all.length; while (lo < hi && isBlank(all[lo])) lo++; while (hi > lo && isBlank(all[hi - 1])) hi--;
  const lines = all.slice(lo, hi);
  if (lines.length < 2) return { head: [], rows: [], blankLines: 0, raggedRows: 0 };
  const delim = (lines[0].match(/\t/g) || []).length >= 2 ? '\t' : (lines[0].match(/;/g) || []).length >= 2 ? ';' : ',';
  if (delim !== '\t') return { head: [], rows: [], blankLines: 0, raggedRows: 0, unsupported: 'This does not look like a tab-separated Amazon flat file. Download the report as a text (tab-delimited) file, not Excel or CSV.' };
  const head = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const body = lines.slice(1), kept = body.slice(0, MAX_ROWS), blankLines = kept.filter(isBlank).length;
  const records = kept.filter(l => !isBlank(l)); let raggedRows = 0;
  const rows = records.map(l => { const c = l.split('\t'); if (c.length !== head.length) raggedRows++; return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim().replace(/^"|"$/g, '')])); });
  return { head, rows, truncated: body.length > MAX_ROWS, blankLines, raggedRows };
}

export function detectFormat(head) {
  const has = (...c) => c.every(x => head.includes(x));
  if (has('shipping-id', 'transaction-id', 'item-vat-incl-amount')) return 'vidr';
  if (has('amazon-order-id', 'item-price') && !head.includes('buyer-name') && !head.includes('buyer-company-name')) return 'allorders';
  if (has('order-id', 'item-price', 'item-tax', 'quantity-purchased', 'currency') && (head.includes('buyer-name') || head.includes('recipient-name') || head.includes('buyer-company-name'))) return 'order';
  return null;
}

const money = (v) => { v = String(v ?? '').trim(); if (v === '') return 0; if (!/^-?\d+([.,]\d{1,2})?$/.test(v)) return NaN; return parseFloat(v.replace(',', '.')); };
const COUNTRY_BY_DOMAIN = { 'amazon.es': 'ES', 'amazon.fr': 'FR', 'amazon.de': 'DE', 'amazon.it': 'IT', 'amazon.nl': 'NL', 'amazon.pl': 'PL', 'amazon.se': 'SE', 'amazon.com.be': 'BE', 'amazon.ie': 'IE', 'amazon.co.uk': 'GB' };
const rateOf = (excl, vat) => { // the VAT rate read from Amazon's own amounts, to the nearest half point; null when it cannot be read safely
  if (vat === 0) return 0; if (!(excl > 0) || vat < 0) return null; const raw = vat / excl * 100, near = Math.round(raw * 2) / 2, tol = excl >= 10 ? 0.2 : excl >= 3 ? 0.6 : 1.5;
  return Math.abs(raw - near) <= tol && near > 0 && near <= 30 ? near : null;
};

/** Reads one flag of an Order Report order exactly as written. state: ABSENT (no such column), VALUE (true or false), UNKNOWN (blank, unreadable or the rows disagree). */
const orderFlag = (lines, col) => { if (!lines.some(l => col in l)) return { state: 'ABSENT', value: null }; const vals = lines.map(l => l[col]), v = readFlag(vals); if (v !== null) return { state: 'VALUE', value: v }; return { state: vals.every(x => String(x ?? '').trim() === '') ? 'BLANK' : 'UNKNOWN', value: null }; };

const ORDER_REPORT_PREVIEW_ONLY = 'Issuing needs a VAT Invoice Data Report. The Order Report is a preview only: it shows what we can read, and it never allows an invoice to be issued. To resolve it, load the VAT Invoice Data Report for these orders.';
/** Order Report preview. Returns { shipments (always empty), held, skipped, problems }. */
export function parseOrderReport(rows) {
  const byOrder = new Map(), out = { shipments: [], held: [], skipped: [], problems: [] };
  for (const r of rows) { const id = r['order-id']; if (!id) continue; if (!byOrder.has(id)) byOrder.set(id, []); byOrder.get(id).push(r); }
  for (const [orderId, lines] of byOrder) {
    const f = lines[0], holdWith = (reason, s = null) => out.held.push({ orderId, reason, s });
    // The Order Report has no is-business-order or is-amazon-invoiced column. Absent evidence is UNKNOWN, never FALSE and never TRUE. The seller declaration is a documented possible later route (per-order, audited, never shown as Amazon evidence); it has no code path today.
    const bf = orderFlag(lines, 'is-business-order'), af = orderFlag(lines, 'is-amazon-invoiced');
    const isBusiness = bf.state === 'VALUE' ? bf.value : null, isAmazonInvoiced = af.state === 'VALUE' ? af.value : null; // as written by the report; nothing is declared or inferred
    if (isAmazonInvoiced === true) { out.skipped.push({ orderId, why: 'Amazon creates this invoice' }); continue; }
    if (isBusiness === false) { out.skipped.push({ orderId, why: 'Not a business order: the report says is-business-order FALSE' }); continue; }
    const unknown = [isBusiness === null && 'is-business-order', isAmazonInvoiced === null && 'is-amazon-invoiced'].filter(Boolean);
    if (unknown.length) { holdWith(unknownFlagsReason(unknown, unknown.every(k => (k === 'is-business-order' ? bf : af).state === 'ABSENT') ? 'ABSENT' : 'BLANK') + ' Issuing needs a VAT Invoice Data Report: the Order Report is a preview only.', null); continue; }
    // Issuing needs a VAT Invoice Data Report. The Order Report is a PREVIEW path: it never produces a shipment, whatever it carries and whatever option is passed.
    holdWith(ORDER_REPORT_PREVIEW_ONLY);
  }
  return out;
}

/** Why a VIDR shipment will not produce an invoice, in the words the preview shows. Mirrors needsInvoice() in vidr.js. */
const vidrSkipReason = (s) => s.unknownTxFormat ? 'The transaction id looks like a correction but has an unknown format, so we did not guess' : s.isAmazonInvoiced === true ? 'Amazon creates this invoice'
  : s.isBusiness === false ? 'Not a business order: the report says is-business-order FALSE'
  : s.transactionType !== 'SHIPMENT' ? 'Not a shipment (transaction type: ' + (s.transactionType || 'unknown') + ')'
  : s.isCorrection || s.isCorrectedTx ? 'A correction row: it belongs with the original invoice, not a new one'
  : !needsInvoice(s) ? 'Amazon is not waiting for an invoice for this order (status: ' + (s.invoiceStatus || 'none') + ')'
  : null;

/** Pair state per original shipment, from the rows of ONE upload. Informational: the pipeline decides what is issued. A pair split across two uploads shows as reversal-only / correction-only here; the pipeline completes it when the other half arrives. */
export function correctionPairs(list) {
  const by = new Map();
  for (const s of list) { const e = by.get(s.shippingId) ?? { shippingId: s.shippingId, reversals: [], replacements: [] }; (s.isCorrectionReversal ? e.reversals : e.replacements).push(s.transactionId); by.set(s.shippingId, e); }
  return [...by.values()].map(e => ({ shippingId: e.shippingId, reversals: e.reversals, replacements: e.replacements, state: e.reversals.length > 1 || e.replacements.length > 1 ? 'multiple' : e.reversals.length && e.replacements.length ? 'complete' : e.reversals.length ? 'reversal-only' : 'correction-only' }));
}

/** Full file -> plan. Pure: nothing is stored. */
export function planUpload(text, opts = {}) {
  const t = parseTable(text);
  if (t.unsupported) return { ok: false, error: t.unsupported };
  if (!t.rows.length) return { ok: false, error: 'The file is empty or has no header line.' };
  const format = detectFormat(t.head);
  if (!format) return { ok: false, error: 'We do not recognise this file. Use the Order Report (with the buyer tax columns switched on) or the VAT Invoice Data Report, both as tab-delimited text.' };
  if (format === 'allorders') return { ok: false, format, error: 'The All Orders Report has no buyer name, address or VAT number, so it cannot make an invoice. Use the Order Report with the buyer columns switched on.' };
  if (format === 'vidr') {
    // Same honesty as the Order Report: rows that cannot produce an invoice are counted as skipped up front,
    // so the preview's "Ready to invoice" matches what issue will actually attempt.
    const kept = [], skipped = [], held = [], notes = [], unsupported = [], corrections = [];
    const parsed = parseVidr(text);
    for (const s of parsed) {
      // CORRECTIONS_MANUAL (opts.corrections): a well-formed CorrectionReversal / Correction:: row is a correction event, not a skipped row. It is handed to processCorrections, which holds it for a person's pair review. Everything else below is unchanged; flag off = this branch never runs.
      if (opts.corrections && (s.isCorrectionReversal || s.isCorrectedTx) && !s.unknownTxFormat && s.isAmazonInvoiced !== true && s.isBusiness !== false) { corrections.push(s); continue; } if (heldForUnknownFlags(s)) { held.push({ orderId: s.orderId, reason: unknownFlagsReason(unknownFlags(s)) }); continue; } const why = vidrSkipReason(s); if (why) { skipped.push({ orderId: s.orderId, why }); if (s.transactionType !== 'SHIPMENT' && !s.isCorrectedTx && !s.isCorrectionReversal && !s.isCorrection && !s.unknownTxFormat) unsupported.push({ orderId: s.orderId, type: s.transactionType, reason: `A ${s.transactionType} row: refunds and returns are not built in this stage, so nothing will be issued for it.` }); continue; } const a = assessShipment(s); const hf = a.findings.filter(f => f.severity !== 'INFO'); if (hf.length && !(opts.isReleased && hf.every(f => f.severity === 'HOLD' && f.resolution === 'HUMAN_DECISION' && opts.isReleased(s, f)))) { held.push({ orderId: s.orderId, reason: 'Not issued: ' + hf.map(f => f.explanation).join(' ') }); continue; } for (const f of a.findings.filter(f => f.severity === 'INFO')) notes.push({ orderId: s.orderId, code: f.code, text: f.explanation }); kept.push(s); }
    kept.invalidRows = parsed.invalidRows ?? []; // the list is handed to processReport as `shipments`: the invalid rows must travel with it
    return { ok: true, format, formatName: FORMATS.vidr, rows: t.rows.length, shipments: kept, held, skipped, notes, unsupported, invalidRows: kept.invalidRows, truncated: !!t.truncated, ...(opts.corrections ? { corrections, correctionPairs: correctionPairs(corrections) } : {}) };
  }
  const p = parseOrderReport(t.rows);
  return { ok: true, format, formatName: FORMATS.order, rows: t.rows.length, truncated: !!t.truncated, ...p };
}
