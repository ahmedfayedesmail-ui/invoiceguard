import { classifyTransactionId } from './txid.js';
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

export function parseTsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split('\t').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(l => { const c = l.split('\t'); return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()])); });
}

const PARTS = ['item', 'shipping', 'gift-wrap', 'item-promo', 'shipping-promo', 'gift-promo'];

/** Group item rows into shipments (an invoice is due per shipment, not per order). */
export function parseVidr(text) {
  const rows = parseTsv(text);
  const map = new Map();
  for (const r of rows) {
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
  return [...map.values()].map(({ flagValues, businessValues, ...s }) => ({ ...s, isAmazonInvoiced: readFlag(flagValues), isBusiness: readFlag(businessValues), incl: r2(s.incl), vat: r2(s.vat), excl: r2(s.excl) }));
}

/** Shipments the seller still has to invoice themselves. */
export const needsInvoice = (s) => !s.unknownTxFormat && s.isBusiness === true && s.isAmazonInvoiced === false && s.transactionType === 'SHIPMENT' && !s.isCorrectedTx && !s.isCorrection &&
  ['InvoicePending', 'InvoiceRejected', 'NoTaxCalculated', ''].includes(s.invoiceStatus || '');

/** Which of the two flags a shipment leaves UNKNOWN (blank, unreadable, or rows that disagree). */
export const unknownFlags = (s) => [s.isBusiness == null && 'is-business-order', s.isAmazonInvoiced == null && 'is-amazon-invoiced'].filter(Boolean);
/** True when a flag is unknown AND the shipment would need a seller invoice if it were known the way an invoice needs it. Such a shipment is HELD: it is neither issued nor skipped as consumer or as Amazon-created. */
export const heldForUnknownFlags = (s) => !s.unknownTxFormat && unknownFlags(s).length > 0 && needsInvoice({ ...s, isBusiness: s.isBusiness ?? true, isAmazonInvoiced: s.isAmazonInvoiced ?? false });
/** The seller's words for a held shipment: which column, that nothing was guessed or issued, and what would resolve it. kind ABSENT = the report type has no such column. */
export const unknownFlagsReason = (fields, kind = 'BLANK') => {
  const cols = fields.join(' and '), shows = fields.length === 2 ? 'whether this is a business order or who issues the invoice' : fields[0] === 'is-business-order' ? 'whether this is a business order' : 'who issues the invoice';
  const head = kind === 'ABSENT' ? `The Order Report does not carry ${cols}, so it cannot show ${shows} for this order.` : `${cols} ${fields.length > 1 ? 'are' : 'is'} blank, unreadable or disagree between the rows of this order in the report, so the report does not show ${shows}.`;
  const tail = kind === 'ABSENT' ? ` To resolve it, load the VAT Invoice Data Report, which carries ${cols} with TRUE or FALSE for each order.` : ` To resolve it, load a VAT Invoice Data Report in which ${cols} holds TRUE or FALSE for this order.`;
  return `${head} We did not guess, and nothing was issued for this order. Company name and VAT number are buyer data and prove neither the business flag nor who issues the invoice.${fields.includes('is-amazon-invoiced') ? ' The invoice-status column is not used as a substitute.' : ''}${tail}`;
};
