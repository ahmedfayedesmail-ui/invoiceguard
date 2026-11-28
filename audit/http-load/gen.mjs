// Synthetic Amazon Order Report (tab-delimited), same columns as fixtures/order-report.tsv.
export const HEAD = 'order-id\tpurchase-date\tsales-channel\tbuyer-name\trecipient-name\tbuyer-company-name\tbuyer-tax-registration-id\tbuyer-tax-registration-country\tbill-name\tbill-address-1\tbill-city\tbill-postal-code\tbill-country\tship-country\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\titem-tax\tshipping-price\tshipping-tax\tis-amazon-invoiced';
export function orderReport(rows, sellerIdx = 0, salt = 0) {
  const out = [HEAD];
  for (let i = 0; i < rows; i++) {
    const n = String(i).padStart(7, '0');
    out.push([
      `40${sellerIdx % 10}-${String(1000000 + i + salt * 100000).slice(0, 7)}-${n}`,
      '2026-11-20T09:00:00Z', 'amazon.es', `Buyer ${i}`, `Buyer ${i}`, `Synthetic Buyer ${i} S.L.`,
      'B12345674', 'ES', `Synthetic Buyer ${i} S.L.`, `Calle Falsa ${i}`, 'Madrid', '28001', 'ES', 'ES',
      `SKU-${i}`, 'Widget', '1', 'EUR', '121.00', '21.00', '0', '0', 'FALSE',
    ].join('\t'));
  }
  return out.join('\n');
}
// Pads a valid report to an exact character count with a long product-name cell in one extra row.
export function padReport(rows, sellerIdx, targetChars, ch = 'a', salt = 0) {
  const base = orderReport(rows, sellerIdx, salt);
  if (targetChars <= base.length) return base;
  const need = targetChars - base.length - 1;
  const cells = [];
  let left = need;
  while (left > 0) { const n = Math.min(left, 100000); cells.push(ch.repeat(n)); left -= n; }
  return base + '\n' + cells.join('');
}

// Synthetic VAT Invoice Data Report (VIDR) with the 38 columns of fixtures/vidr.tsv, is-business-order TRUE.
export const VIDR_HEAD = ['order-id','order-item-id','shipping-id','fulfilled-by','order-date','marketplace-id','recipient-name','buyer-name','ship-country','shipment-date','billing-name','bill-address-1','bill-city','bill-postal-code','bill-country','ship-from-country','sku','product-name','quantity-purchased','currency','item-vat-incl-amount','item-vat-amount','item-vat-excl-amount','item-vat-rate','shipping-vat-incl-amount','shipping-vat-amount','shipping-vat-excl-amount','shipping-vat-rate','transaction-id','transaction-type','is-amazon-invoiced','invoice-status','is-business-order','seller-vat-number','buyer-vat-number','buyer-company-name','buyer-tax-registration-type','citation-es'].join('\t');
export function vidrReport(rows, sellerIdx = 0, salt = 0, { padTo = 0, padChar = 'a' } = {}) {
  const out = [VIDR_HEAD];
  for (let i = 0; i < rows; i++) {
    const k = salt * 100000 + i;
    const orderId = `40${sellerIdx % 10}-${String(2000000 + k).slice(0, 7)}-${String(k).padStart(7, '0')}`;
    const sid = `S${sellerIdx}${String(k).padStart(6, '0')}`;
    out.push([orderId, '', sid, 'MFN', '2026-11-18T08:00:00Z', 'amazon.es', '', '', 'ES', '2026-11-20T08:00:00Z', `Synthetic Buyer ${k} S.L.`, `Calle Falsa ${k % 200}`, 'Madrid', '28001', 'ES', 'ES', `SKU-${k % 50}`, 'Widget', '1', 'EUR', '48.40', '8.40', '40.00', '0.21', '0', '0', '0', '0', sid, 'SHIPMENT', 'FALSE', 'InvoicePending', 'TRUE', 'ESB11111119', 'ESB12345674', `Synthetic Buyer ${k} S.L.`, 'VAT', ''].join('\t'));
  }
  let text = out.join('\n');
  if (padTo > text.length) text += '\n' + padChar.repeat(padTo - text.length - 1);
  return text;
}
