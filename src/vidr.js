import { classifyTransactionId } from './txid.js';
import { normalizeReport, unreadableCells, absentColumns } from './vidr-input.js';
// Parser for Amazon's VAT Invoice Data Report (GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT), tab-separated.
// Locale-safe amounts: the rightmost of '.'/',' is the decimal separator, the other is grouping -
// "1.234,56" (ES), "1,234.56" (US) and "1234,56" all parse to 1234.56. A single separator is taken
// as-is (the documented report format uses '.'), so "1,56" becomes 1.56 and "1,234" stays 1234.
const num = (x) => {
  let s = String(x ?? '').trim(); if (!s) return 0;
  const dot = s.lastIndexOf('.'), com = s.lastIndexOf(',');
  if (dot >= 0 && com >= 0) s = com > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (com >= 0) s = /,\d{1,2}$/.test(s) && s.indexOf(',') === com ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const bool = (x) => String(x).toUpperCase() === 'TRUE';
/** A flag that must be read exactly as written. TRUE or FALSE (case and spaces ignored) when every value agrees; null (UNKNOWN) for a blank, an unreadable value or values that disagree. A blank is never FALSE and is never inferred from any other column. */
export const readFlag = (values) => { const v = new Set([].concat(values).map(x => String(x ?? '').trim().toUpperCase())); return v.size === 1 && v.has('TRUE') ? true : v.size === 1 && v.has('FALSE') ? false : null; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Row integrity. A raw newline inside a text cell splits one report row into physical lines, and each piece looks like a row. A piece is accepted only when it is complete by the file's OWN header:
// exactly as many cells as the header, or fewer where every missing cell is a trailing OPTIONAL column (an editor may drop a trailing empty tab). Anything else (a missing required cell, an extra cell)
// is an invalid row: quarantined, never read as a shipment. IDs and dates alone are not enough: the first piece of a split row keeps them.
const OPTIONAL_TRAILING = new Set(['citation-en', 'citation-es']);
export function checkTsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => l.trim());
  if (!lines.length) return { rows: [], rowLines: [], invalid: [], head: [] };
  const head = lines[0][0].split('\t').map(h => h.trim().toLowerCase());
  const dupNames = [...new Set(head.filter((h, i) => h && head.indexOf(h) !== i))];
  const missingOf = (n) => n < head.length ? head.slice(n).filter(h => !OPTIONAL_TRAILING.has(h)) : [];
  const items = [], invalid = []; let prev = null; // prev = the accepted row on the physical line directly before, if any
  for (const [l, no] of lines.slice(1)) {
    const c = l.split('\t'); const missing = missingOf(c.length);
    if (c.length > head.length || missing.length) {
      invalid.push({ line: no, cells: c.length, expected: head.length, missing, reason: c.length > head.length ? 'more cells than the header' : 'required cells are missing (the row is cut off or split)' });
      // The known limit of a cell count: a newline inside the LAST cells leaves a first piece that already looks complete. If the short line joined to the row before it makes EXACTLY a complete row, they are one row split by a newline: quarantine both. Never repaired.
      if (prev && c.length <= head.length && prev.cells + c.length - 1 <= head.length && !missingOf(prev.cells + c.length - 1).length) {
        prev.item.drop = true; invalid.push({ line: prev.no, cells: prev.cells, expected: head.length, missing: [], reason: 'this row and the unreadable line after it look like one row split by a newline inside a cell (the line after it cannot start a row), so neither is used' });
      }
      prev = null; continue;
    }
    // A header that repeats a column name makes the value of that column ambiguous: when the repeated cells disagree, "the last one wins" would be a guess. The row is quarantined, never repaired.
    const clash = dupNames.find(n => new Set(head.flatMap((h, i) => h === n ? [(c[i] ?? '').trim()] : [])).size > 1);
    if (clash) { invalid.push({ line: no, cells: c.length, expected: head.length, missing: [], reason: `the header repeats the column ${clash} and the repeated cells disagree, so its value is not known` }); prev = null; continue; }
    const item = { row: Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()])), line: no }; items.push(item); prev = { item, no, cells: c.length };
  }
  return { rows: items.filter(i => !i.drop).map(i => i.row), rowLines: items.filter(i => !i.drop).map(i => i.line), invalid: invalid.sort((x, y) => x.line - y.line), head };
}
export function parseTsv(text) { return checkTsv(text).rows; }

const PARTS = ['item', 'shipping', 'gift-wrap', 'item-promo', 'shipping-promo', 'gift-promo'];
/** Round 3 (owner ruling Nov 28 2026): report columns a person's approval is bound to, although the document builder does not read them. invoice-status is deliberately NOT here (a lifecycle field). */
export const BOUND_COLUMNS = ['fulfilled-by', 'order-date', 'recipient-name', 'buyer-name', 'sku', 'product-name', 'is-amazon-invoiced', 'is-business-order', 'citation-es'];
export const CONFLICT_FIELDS = ['currency', 'buyer-vat-number', 'billing-name', 'bill-address-1', 'bill-city', 'bill-postal-code', 'bill-country', 'ship-country', 'ship-from-country', 'shipment-date', 'seller-vat-number', 'marketplace-id', 'order-id', 'buyer-company-name', 'buyer-tax-registration-type', 'invoice-status'];

/** Group item rows into shipments (an invoice is due per shipment, not per order). */
export function parseVidr(rawText) {
  // Input layer: comma-separated and XML variants of the report are turned into the canonical tab-separated form first. Unreadable text (wrong encoding, line breaks in a cell) is carried per shipment and held, never repaired.
  const nrm = normalizeReport(rawText); const text = nrm.text;
  const checked = checkTsv(text); let { rows, invalid } = checked;
  // A file whose header does not identify shipments (no order-id, or neither shipping-id nor transaction-id) is not a VAT Invoice Data Report: every row of it is invalid, because a row count can only be checked against a header that means something.
  if (checked.head.length && (!checked.head.includes('order-id') || !(checked.head.includes('shipping-id') || checked.head.includes('transaction-id')))) {
    const n = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim()).length - 1;
    invalid = Array.from({ length: Math.max(n, 0) }, (_, i) => ({ line: i + 2, cells: 0, expected: checked.head.length, missing: ['order-id', 'shipping-id or transaction-id'], reason: 'the header does not identify shipments, so this is not a VAT Invoice Data Report' })); rows = [];
  }
  const map = new Map(); let ri = -1; const rowLines = checked.rowLines ?? [];
  for (const r of rows) {
    ri++;
    const key = `${r['transaction-type'] || 'SHIPMENT'}:${r['transaction-id'] || r['shipping-id']}`;
    let s = map.get(key);
    if (!s) {
      s = map.set(key, {
        key, orderId: r['order-id'], shippingId: r['shipping-id'], transactionId: r['transaction-id'] || r['shipping-id'],
        transactionType: r['transaction-type'] || 'SHIPMENT', marketplace: r['marketplace-id'], orderDate: r['order-date'], shipmentDate: r['shipment-date'],
        currency: r.currency || 'EUR', isBusiness: null, isAmazonInvoiced: null, flagValues: [], businessValues: [],
        invoiceStatus: r['invoice-status'], invoiceStatusDesc: r['invoice-status-description'] || null, sellerVat: r['seller-vat-number'], buyerVat: r['buyer-vat-number'] || null,
        buyerTaxType: r['buyer-tax-registration-type'] || null, buyerCompany: r['buyer-company-name'] || r['billing-name'] || r['buyer-name'],
        poNumber: r['purchase-order-number'] || null,
        billing: { name: r['billing-name'], lines: [r['bill-address-1'], r['bill-address-2'], r['bill-address-3']].filter(Boolean), city: r['bill-city'], postal: r['bill-postal-code'], country: r['bill-country'] },
        shipCountry: r['ship-country'], shipFromCountry: r['ship-from-country'], isCorrection: bool(r['is-invoice-corrected']),
        isCorrectionReversal: classifyTransactionId(r['transaction-id'], r['transaction-type']).role === 'REVERSAL', isCorrectedTx: classifyTransactionId(r['transaction-id'], r['transaction-type']).role === 'CORRECTED', unknownTxFormat: classifyTransactionId(r['transaction-id'], r['transaction-type']).unknown, originalInvoiceNumber: r['original-vat-invoice-number'] || null, correctionDetails: r['invoice-correction-details'] || null,
        citation: r['citation-es'] || r['citation-en'] || null, items: [], incl: 0, vat: 0, excl: 0,
      }).get(key);
    }
    // Provenance for the integrity gate: the physical line and the raw tokens of every row that fed this shipment. Nothing is interpreted here.
    (s.src ??= []).push({ line: rowLines[ri] ?? null, qty: r['quantity-purchased'] ?? '', itemId: r['order-item-id'] ?? '', sig: Object.values(r).join('\t'), orderDate: r['order-date'] ?? '', attrs: Object.fromEntries(CONFLICT_FIELDS.map(f => [f, r[f] ?? ''])), bound: Object.fromEntries(BOUND_COLUMNS.map(f => [f, r[f] ?? ''])), parts: Object.fromEntries(PARTS.map(p => [p, { incl: r[`${p}-vat-incl-amount`] ?? '', vat: r[`${p}-vat-amount`] ?? '', excl: r[`${p}-vat-excl-amount`] ?? '', rate: r[`${p}-vat-rate`] ?? '' }])) });
    for (const col of unreadableCells(r)) (s.unreadable ??= new Set()).add(col);
    (s.rowMeta ??= []).push({ status: r['invoice-status'] ?? '', invoiceNumber: r['invoice-number'] ?? '', orderId: r['order-id'] ?? '', shippingId: r['shipping-id'] ?? '', currency: r.currency ?? '', marketplace: r['marketplace-id'] ?? '', type: r['transaction-type'] ?? '', transactionId: r['transaction-id'] || r['shipping-id'] || '', originalInvoiceNumber: r['original-vat-invoice-number'] ?? '', incl: PARTS.reduce((q, p) => q + num(r[`${p}-vat-incl-amount`]), 0), vat: PARTS.reduce((q, p) => q + num(r[`${p}-vat-amount`]), 0) }); s.invoiceNumberColumn = checked.head.includes('invoice-number'); // per-row evidence for the credit-note acceptance gate (src/cn-gate.js); nothing here changes a financial figure
    s.flagValues.push(r['is-amazon-invoiced']); s.businessValues.push(r['is-business-order']);
    const inclSum = PARTS.reduce((a, p) => a + num(r[`${p}-vat-incl-amount`]), 0);
    const vatSum = PARTS.reduce((a, p) => a + num(r[`${p}-vat-amount`]), 0);
    s.incl += inclSum; s.vat += vatSum; s.excl += inclSum - vatSum;
    s.items.push({
      sku: r.sku, asin: r.asin, name: r['product-name'], qty: num(r['quantity-purchased']) || 1,
      unitExcl: r2(num(r['item-vat-excl-amount']) / (num(r['quantity-purchased']) || 1)), vatRate: num(r['item-vat-rate']),
      exclTotal: r2(num(r['item-vat-excl-amount'])), vatTotal: r2(num(r['item-vat-amount'])),
      extras: PARTS.slice(1).map(p => ({ part: p, excl: r2(num(r[`${p}-vat-excl-amount`])), vat: r2(num(r[`${p}-vat-amount`])), rate: num(r[`${p}-vat-rate`]) })).filter(x => x.excl || x.vat),
    });
  }
  const list = [...map.values()].map(({ flagValues, businessValues, ...s }) => ({ ...s, isAmazonInvoiced: readFlag(flagValues), isBusiness: readFlag(businessValues), incl: r2(s.incl), vat: r2(s.vat), excl: r2(s.excl) }));
  const perOrder = new Map(); for (const s of list) { const k = s.marketplace + '|' + s.orderId; perOrder.set(k, (perOrder.get(k) ?? 0) + 1); } for (const s of list) s.orderShipments = perOrder.get(s.marketplace + '|' + s.orderId);
  list.inputSource = nrm.source; list.inputNotes = nrm.notes; list.inputError = nrm.error ?? null; list.inputHead = checked.head; list.absent = absentColumns(checked.head);
  for (const s of list) if (s.unreadable) s.unreadable = [...s.unreadable].sort();
  list.invalidRows = invalid; // rows rejected by the integrity check: never shipments
  return list;
}

/** Shipments the seller still has to invoice themselves. */
export const needsInvoice = (s) => !s.unknownTxFormat && s.isBusiness === true && s.isAmazonInvoiced === false && s.transactionType === 'SHIPMENT' && !s.isCorrectedTx && !s.isCorrection &&
  ['InvoicePending', 'InvoiceRejected', 'NoTaxCalculated', ''].includes(s.invoiceStatus || '');

/** Which of the two flags a shipment leaves UNKNOWN (blank, unreadable, or rows that disagree). */
export const unknownFlags = (s) => [s.isBusiness == null && 'is-business-order', s.isAmazonInvoiced == null && 'is-amazon-invoiced'].filter(Boolean);
/** True when a flag is unknown and the shipment could still need a seller invoice: a shipment (not a correction) that is not known to be consumer (is-business-order FALSE) or Amazon-invoiced (is-amazon-invoiced TRUE). The invoice-status plays no part: a blank flag is held in every status. Such a shipment is neither issued nor skipped. */
export const heldForUnknownFlags = (s) => !s.unknownTxFormat && unknownFlags(s).length > 0 && s.transactionType === 'SHIPMENT' && !s.isCorrectedTx && !s.isCorrection && s.isBusiness !== false && s.isAmazonInvoiced !== true;
/** The seller's words for a held shipment: which column, that nothing was guessed or issued, and what would resolve it. kind ABSENT = the report type has no such column. */
export const unknownFlagsReason = (fields, kind = 'BLANK') => {
  const cols = fields.join(' and '), shows = fields.length === 2 ? 'whether this is a business order or who issues the invoice' : fields[0] === 'is-business-order' ? 'whether this is a business order' : 'who issues the invoice';
  const head = kind === 'ABSENT' ? `The Order Report does not carry ${cols}, so it cannot show ${shows} for this order.` : `${cols} ${fields.length > 1 ? 'are' : 'is'} blank, unreadable or disagree between the rows of this order in the report, so the report does not show ${shows}.`;
  const tail = kind === 'ABSENT' ? ` To resolve it, load the VAT Invoice Data Report, which carries ${cols} with TRUE or FALSE for each order.` : ` To resolve it, load a VAT Invoice Data Report in which ${cols} holds TRUE or FALSE for this order.`;
  return `${head} We did not guess, and nothing was issued for this order. Company name and VAT number are buyer data and prove neither the business flag nor who issues the invoice.${fields.includes('is-amazon-invoiced') ? ' The invoice-status column is not used as a substitute.' : ''}${tail}`;
};
