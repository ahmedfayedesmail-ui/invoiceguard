// Synthetic fixtures for the problem loop. Everything here is invented: order ids, numbers and amounts are not from any real seller.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'loop'); mkdirSync(out, { recursive: true });
export const MKT = 'A1RKKUPIHCS9HS';
const H = ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'invoice-number', 'invoice-status', 'invoice-status-description', 'is-amazon-invoiced', 'order-date', 'shipment-date', 'is-business-order', 'buyer-vat-number', 'currency', 'item-vat-incl-amount'];
export const O = (n) => `405-${String(1000000 + n)}-${String(2000000 + n)}`;
export const vrow = ({ n, status, num = '', desc = '' }) => [MKT, O(n), String(100 + n), `S${9000 + n}`, `S${9000 + n}`, 'SHIPMENT', num, status, desc, 'FALSE', '17/11/2026', '2026-11-18T09:00:00Z', 'TRUE', 'DE811128135', 'EUR', '121.00'].join('\t');
export const vidr = (rows) => [H.join('\t'), ...rows.map(vrow)].join('\n') + '\n';
export const LH = 'Nº factura;Tipo;Fecha factura;Fecha operación;Divisa;Total;Base imponible;IVA;Pedido Amazon;Canal';
const lrow = (num, date, op, order, chan = 'Amazon.es', total = '121,00') => [num, 'Factura', date, op, 'EUR', total, '100,00', '21,00', order, chan].join(';');
export const ledger = (rows) => [LH, ...rows].join('\n') + '\n';
export const L = { row: lrow };
// Round 1 (taken 2026-11-20)
export const V1 = vidr([
  { n: 1, status: 'InvoiceUploaded', num: 'A-1001' },
  { n: 2, status: 'InvoiceUploaded', num: 'A-1002' },
  { n: 3, status: 'InvoicePending' },
  { n: 4, status: 'InvoicePending' },
  { n: 5, status: 'InvoiceRejected', num: 'A-1005', desc: 'Buyer VAT number is missing' },
  { n: 6, status: 'InvoiceProcessing', num: 'A-1006' },
]);
export const L1 = ledger([
  lrow('A-1001', '2026-11-18', '17/11/2026'.split('/').reverse().join('-'), O(1)),
  lrow('A-1005', '2026-11-18', '2026-11-17', O(5)),
  lrow('A-1006', '2026-11-18', '2026-11-17', O(6)),
  lrow('B-3', '2026-11-19', '2026-11-17', O(3)),
  lrow('A-9999', '2026-11-19', '2026-11-12', O(99)),
  lrow('W-1', '2026-11-19', '2026-11-12', '', 'Tienda web'),
]);
// Round 2 (taken 2026-11-27): the seller acted
export const V2 = vidr([
  { n: 1, status: 'InvoiceUploaded', num: 'A-1001' },
  { n: 2, status: 'InvoiceUploaded', num: 'A-1002' },
  { n: 3, status: 'InvoiceUploaded', num: 'B-3' },
  { n: 4, status: 'InvoiceUploaded', num: 'A-1004' },
  { n: 5, status: 'InvoiceUploaded', num: 'A-1005b' },
  { n: 6, status: 'InvoiceUploaded', num: 'A-1006' },
]);
export const L2 = ledger([
  lrow('A-1001', '2026-11-18', '2026-11-17', O(1)), lrow('A-1002', '2026-11-26', '2026-11-17', O(2)), lrow('A-1004', '2026-11-26', '2026-11-17', O(4)),
  lrow('A-1005b', '2026-11-26', '2026-11-17', O(5)), lrow('A-1006', '2026-11-18', '2026-11-17', O(6)), lrow('B-3', '2026-11-19', '2026-11-17', O(3)),
  lrow('A-9999', '2026-11-19', '2026-11-12', O(99)), lrow('W-1', '2026-11-19', '2026-11-12', '', 'Tienda web'),
]);
export const VDECL = (createdAt, from = '2026-11-01', to = '2026-11-30') => ({ reportType: 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', options: 'ALL', marketplace: MKT, rangeFrom: from, rangeTo: to, createdAt, createdAfterUploadConfirmed: true, downloadedAt: createdAt, obtainedHow: 'downloaded by the seller from Seller Central', dateOrderConfirmed: 'DD/MM/YYYY' });
export const LDECL = (extra = {}) => ({ exportedAt: '2026-11-20T11:00:00Z', sourceSystem: 'acme-books', marketplace: MKT, periodFrom: '2026-11-01', periodTo: '2026-11-30', documentKinds: ['invoice'], complete: true, amazonScope: { mode: 'CHANNEL', channelValues: ['Amazon.es'] }, ...extra });
export const PROFILE = { delimiter: ';', columns: { number: 'Nº factura', kind: 'Tipo', issueDate: 'Fecha factura', operationDate: 'Fecha operación', currency: 'Divisa', gross: 'Total', net: 'Base imponible', vat: 'IVA', orderRef: 'Pedido Amazon', channel: 'Canal' }, constantKind: null, dateOrder: 'ISO', decimal: ',', thousands: '', unknownColumnsAcknowledged: true, confirmed: true };
if (process.argv[1] === fileURLToPath(import.meta.url)) { writeFileSync(join(out, 'vidr-1.tsv'), V1); writeFileSync(join(out, 'vidr-2.tsv'), V2); writeFileSync(join(out, 'ledger-1.csv'), L1); writeFileSync(join(out, 'ledger-2.csv'), L2); console.log('fixtures written'); }
