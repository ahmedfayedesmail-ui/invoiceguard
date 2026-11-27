// Generates fixtures/recon/*.tsv: SYNTHETIC VIDR files (made-up orders, no real data) for the reconciliation tests.
// Columns and status strings follow Amazon's VCS guide. Run: node tools/make-recon-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
const MP = 'A1RKKUPIHCS9HS';
const COLS = ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'invoice-number', 'invoice-status', 'invoice-status-description', 'is-amazon-invoiced', 'order-date', 'shipment-date', 'is-business-order', 'buyer-vat-number', 'currency', 'item-vat-incl-amount'];
const R = (o) => ({ 'marketplace-id': MP, 'order-id': o.order, 'order-item-id': o.item, 'shipping-id': o.ship, 'transaction-id': o.tx ?? o.ship, 'transaction-type': o.type ?? 'SHIPMENT', 'invoice-number': o.inv ?? '', 'invoice-status': o.status, 'invoice-status-description': o.desc ?? '', 'is-amazon-invoiced': o.status === 'InvoiceCreatedByAmazon' ? 'TRUE' : 'FALSE', 'order-date': o.od ?? '2026-11-05T10:00:00Z', 'shipment-date': '2026-11-06T09:00:00Z', 'is-business-order': 'TRUE', 'buyer-vat-number': 'DE811128135', currency: 'EUR', 'item-vat-incl-amount': '121.00' });
const tsv = (rows) => [COLS.join('\t'), ...rows.map(r => COLS.map(c => r[c]).join('\t'))].join('\n') + '\n';
const A = { order: '405-1111111-0000001', item: '111', ship: 'S9001' };
const M1 = (s, inv) => [{ order: '405-2222222-0000002', item: '211', ship: 'S9101', status: s, inv }, { order: '405-2222222-0000002', item: '212', ship: 'S9101', status: s, inv }];
const M2 = (s, inv) => [{ order: '405-2222222-0000002', item: '213', ship: 'S9102', status: s, inv }];
const RET = (s, inv) => [{ order: '405-4444444-0000004', item: '411', ship: 'S9301', tx: 'amzn1:crow:SYNTHETIC0001', type: 'REFUND', status: s, inv }];
const REV = (s, inv) => [{ order: '405-6666666-0000006', item: '611', ship: 'S9401', tx: 'CorrectionReversal:X:100000001', type: 'REFUND', status: s, inv }];
const COR = (s, inv) => [{ order: '405-6666666-0000006', item: '611', ship: 'S9401', tx: 'Correction:X:100000001', type: 'SHIPMENT', status: s, inv }];
const REV2 = (s, inv) => [{ order: '405-7777777-0000007', item: '711', ship: 'S9501', tx: 'CorrectionReversal:X:100000002', type: 'REFUND', status: s, inv }];
const NODUE = [{ order: '405-8888888-0000008', item: '811', ship: 'S9601', status: 'NoTaxCalculated' }];
const files = {
  'all-r1-pending.tsv': [...[{ ...A, status: 'InvoicePending' }], ...M1('InvoicePending'), ...M1('InvoicePending').slice(0, 1) /* duplicate row */, ...M2('InvoicePending'), ...RET('CreditNotePending'), ...REV('CreditNotePending'), ...COR('InvoicePending'), ...REV2('CreditNotePending'), ...NODUE],
  'all-r2-processing.tsv': [{ ...A, status: 'InvoiceProcessing', inv: 'A-2026-000123' }, ...M1('InvoiceUploaded', 'A-2026-000124'), ...M2('InvoicePending'), ...RET('CreditNoteUploaded', 'R-2026-000001'), ...REV('CreditNoteUploaded', 'R-2026-000002'), ...COR('InvoiceProcessing', 'A-2026-000125'), ...REV2('CreditNoteUploaded', 'R-2026-000003'), ...NODUE],
  'all-r3-uploaded.tsv': [{ ...A, status: 'InvoiceUploaded', inv: 'A-2026-000123' }, ...M1('InvoiceUploaded', 'A-2026-000124'), ...M2('InvoiceRejected', 'A-2026-000126'), ...RET('CreditNoteUploaded', 'R-2026-000001'), ...REV('CreditNoteUploaded', 'R-2026-000002'), ...COR('InvoiceUploaded', 'A-2026-000125'), ...REV2('CreditNoteUploaded', 'R-2026-000003'), ...NODUE],
  // Pending-only default report: accepted orders are simply absent, the rest is pending or rejected.
  'pending-only.tsv': [...M2('InvoiceRejected'), { order: '405-5555555-0000005', item: '511', ship: 'S9701', status: 'InvoicePending' }],
};
mkdirSync('fixtures/recon', { recursive: true });
for (const [n, rows] of Object.entries(files)) writeFileSync(`fixtures/recon/${n}`, tsv(rows.map(R)));
const dec = (extra) => ({ reportType: 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', options: 'ALL', rangeFrom: '2026-11-01', rangeTo: '2026-11-30', marketplace: MP, createdAfterUploadConfirmed: true, obtainedHow: 'Seller downloaded it from Seller Central (declared by the seller)', ...extra });
writeFileSync('fixtures/recon/declared.json', JSON.stringify({
  'all-r1-pending.tsv': dec({ createdAt: '2026-11-10T08:00:00Z', downloadedAt: '2026-11-10T08:05:00Z' }),
  'all-r2-processing.tsv': dec({ createdAt: '2026-11-12T08:00:00Z', downloadedAt: '2026-11-12T08:05:00Z' }),
  'all-r3-uploaded.tsv': dec({ createdAt: '2026-11-14T08:00:00Z', downloadedAt: '2026-11-14T08:05:00Z' }),
  'pending-only.tsv': { reportType: 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', options: 'PENDING_ONLY', marketplace: MP, downloadedAt: '2026-11-15T09:00:00Z', createdAt: '2026-11-15T08:55:00Z', createdAfterUploadConfirmed: true, obtainedHow: 'Seller downloaded the default report (declared by the seller)' },
}, null, 2) + '\n');
console.log('written', Object.keys(files).length, 'fixtures');
