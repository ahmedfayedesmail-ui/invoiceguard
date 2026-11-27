// Manual path: the seller downloads an order report from Seller Central and uploads it here. No Amazon connection.
// Verified against Amazon's API documentation only (developer-docs.amazon.com, report type pages); NOT against real downloaded files yet.
// Every column that is not documented is optional. Anything we cannot read exactly is held with a reason, never guessed.
import { parseVidr, needsInvoice } from './vidr.js';

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

/** Order Report -> the same shipment objects the engine already uses. Returns { shipments, held, skipped, problems }. */
export function parseOrderReport(rows, { useDeliveryAddress = false } = {}) {
  const byOrder = new Map(), out = { shipments: [], held: [], skipped: [], problems: [] };
  for (const r of rows) { const id = r['order-id']; if (!id) continue; if (!byOrder.has(id)) byOrder.set(id, []); byOrder.get(id).push(r); }
  for (const [orderId, lines] of byOrder) {
    const f = lines[0], holdWith = (reason, s = null) => out.held.push({ orderId, reason, s });
    if (lines.some(l => String(l['is-amazon-invoiced']).toUpperCase() === 'TRUE')) { out.skipped.push({ orderId, why: 'Amazon creates this invoice' }); continue; }
    const company = f['buyer-company-name'] || '', taxIdRaw = (f['buyer-tax-registration-id'] || '').replace(/\s+/g, '').toUpperCase();
    if (!company && !taxIdRaw) { out.skipped.push({ orderId, why: 'No company name or VAT number: looks like a consumer order' }); continue; }
    const differs = (k) => lines.some(l => (l[k] ?? '') !== (f[k] ?? ''));
    if (['buyer-name', 'buyer-company-name', 'buyer-tax-registration-id', 'currency', 'ship-country'].some(differs)) { holdWith('The rows of this order disagree on buyer or currency, so we did not guess which is right.'); continue; }
    let buyerVat = null;
    if (taxIdRaw) { const cc = (f['buyer-tax-registration-country'] || '').toUpperCase(); buyerVat = /^[A-Z]{2}/.test(taxIdRaw) ? taxIdRaw : (/^[A-Z]{2}$/.test(cc) ? cc + taxIdRaw : null); if (!buyerVat) { holdWith('The buyer VAT number has no country prefix and the report gives no country for it.'); continue; } }
    const hasBill = !!(f['bill-name'] || f['bill-address-1']);
    let billing;
    if (hasBill) billing = { name: f['bill-name'] || company, lines: [f['bill-address-1'], f['bill-address-2'], f['bill-address-3']].filter(Boolean), city: f['bill-city'] || '', postal: f['bill-postal-code'] || '', country: (f['bill-country'] || '').toUpperCase() };
    else if (useDeliveryAddress) billing = { name: company || f['recipient-name'] || f['buyer-name'], lines: [f['ship-address-1'], f['ship-address-2'], f['ship-address-3']].filter(Boolean), city: f['ship-city'] || '', postal: f['ship-postal-code'] || '', country: (f['ship-country'] || '').toUpperCase() };
    const items = []; let bad = null, incl = 0, vat = 0;
    for (const l of lines) {
      const q = parseInt(l['quantity-purchased'], 10), price = money(l['item-price']), tax = money(l['item-tax']), sp = money(l['shipping-price']), st = money(l['shipping-tax']);
      if ([price, tax, sp, st].some(Number.isNaN) || !(q > 0)) { bad = 'An amount or quantity in this order is not a plain number, so we did not guess.'; break; }
      if (money(l['item-promotion-discount']) || money(l['ship-promotion-discount'])) { bad = 'This order has a promotion discount. The report does not say how its VAT is split, so we did not guess.'; break; }
      const excl = r2(price - tax), rate = rateOf(excl, r2(tax)), sEx = r2(sp - st), sRate = sp ? rateOf(sEx, r2(st)) : 0;
      if (price < 0 || tax < 0 || rate === null || sRate === null) { bad = 'The VAT rate cannot be read safely from the report amounts (price and tax). Check this order in Seller Central.'; break; }
      items.push({ sku: l.sku, asin: l.asin, name: l['product-name'], qty: q, unitExcl: r2(excl / q), vatRate: rate, exclTotal: excl, vatTotal: r2(tax),
        extras: sp ? [{ part: 'shipping', excl: sEx, vat: r2(st), rate: sRate }] : [] });
      incl += price + sp; vat += tax + st;
    }
    const s = { key: `ORDER:${orderId}`, orderId, shippingId: orderId, transactionId: orderId, transactionType: 'SHIPMENT', marketplace: COUNTRY_BY_DOMAIN[String(f['sales-channel'] ?? '').toLowerCase().replace(/^www\./, '')] ?? null,
      orderDate: f['purchase-date'] || null, shipmentDate: null, currency: f.currency || 'EUR', isBusiness: true, isAmazonInvoiced: false, invoiceStatus: '', sellerVat: null, buyerVat, buyerTaxType: f['buyer-tax-registration-type'] || null,
      buyerCompany: company || f['buyer-name'] || f['recipient-name'], poNumber: null, billing: billing ?? { name: '', lines: [], city: '', postal: '', country: '' }, shipCountry: (f['ship-country'] || '').toUpperCase(), shipFromCountry: null,
      isCorrection: false, isCorrectionReversal: false, isCorrectedTx: false, originalInvoiceNumber: null, correctionDetails: null, citation: null, items, incl: r2(incl), vat: r2(vat), excl: r2(incl - vat), manual: true };
    if (bad) { holdWith(bad, s); continue; }
    if (!billing) { holdWith('The report has no billing address. Tick "use the delivery address" if that is the address on your invoices, or add the billing columns.', s); continue; }
    if (!billing.country) { holdWith('The address has no country, so we did not guess.', s); continue; }
    out.shipments.push(s);
  }
  return out;
}

/** Why a VIDR shipment will not produce an invoice, in the words the preview shows. Mirrors needsInvoice() in vidr.js. */
const vidrSkipReason = (s) => s.unknownTxFormat ? 'The transaction id looks like a correction but has an unknown format, so we did not guess' : s.isAmazonInvoiced ? 'Amazon creates this invoice'
  : !s.isBusiness ? 'Not a business order: looks like a consumer order'
  : s.transactionType !== 'SHIPMENT' ? 'Not a shipment (transaction type: ' + (s.transactionType || 'unknown') + ')'
  : s.isCorrection || s.isCorrectedTx ? 'A correction row: it belongs with the original invoice, not a new one'
  : !needsInvoice(s) ? 'Amazon is not waiting for an invoice for this order (status: ' + (s.invoiceStatus || 'none') + ')'
  : null;

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
    const kept = [], skipped = [];
    for (const s of parseVidr(text)) { const why = vidrSkipReason(s); if (why) skipped.push({ orderId: s.orderId, why }); else kept.push(s); }
    return { ok: true, format, formatName: FORMATS.vidr, rows: t.rows.length, shipments: kept, held: [], skipped, truncated: !!t.truncated };
  }
  const p = parseOrderReport(t.rows, opts);
  return { ok: true, format, formatName: FORMATS.order, rows: t.rows.length, truncated: !!t.truncated, ...p };
}
