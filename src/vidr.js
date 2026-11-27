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
        currency: r.currency || 'EUR', isBusiness: bool(r['is-business-order']), isAmazonInvoiced: bool(r['is-amazon-invoiced']),
        invoiceStatus: r['invoice-status'], invoiceStatusDesc: r['invoice-status-description'] || null, sellerVat: r['seller-vat-number'], buyerVat: r['buyer-vat-number'] || null,
        buyerTaxType: r['buyer-tax-registration-type'] || null, buyerCompany: r['buyer-company-name'] || r['billing-name'] || r['buyer-name'],
        poNumber: r['purchase-order-number'] || null,
        billing: { name: r['billing-name'], lines: [r['bill-address-1'], r['bill-address-2'], r['bill-address-3']].filter(Boolean), city: r['bill-city'], postal: r['bill-postal-code'], country: r['bill-country'] },
        shipCountry: r['ship-country'], shipFromCountry: r['ship-from-country'], isCorrection: bool(r['is-invoice-corrected']),
        isCorrectionReversal: classifyTransactionId(r['transaction-id'], r['transaction-type']).role === 'REVERSAL', isCorrectedTx: classifyTransactionId(r['transaction-id'], r['transaction-type']).role === 'CORRECTED', unknownTxFormat: classifyTransactionId(r['transaction-id'], r['transaction-type']).unknown, originalInvoiceNumber: r['original-vat-invoice-number'] || null, correctionDetails: r['invoice-correction-details'] || null,
        citation: r['citation-es'] || r['citation-en'] || null, items: [], incl: 0, vat: 0, excl: 0,
      }).get(key);
    }
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
  return [...map.values()].map(s => ({ ...s, incl: r2(s.incl), vat: r2(s.vat), excl: r2(s.excl) }));
}

/** Shipments the seller still has to invoice themselves. */
export const needsInvoice = (s) => !s.unknownTxFormat && s.isBusiness && !s.isAmazonInvoiced && s.transactionType === 'SHIPMENT' && !s.isCorrectedTx && !s.isCorrection &&
  ['InvoicePending', 'InvoiceRejected', 'NoTaxCalculated', ''].includes(s.invoiceStatus || '');
