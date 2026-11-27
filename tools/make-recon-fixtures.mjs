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
// Special cases: Amazon-created documents, NoTaxCalculated (seller must upload), correction id shapes (current, legacy, near-misses).
const SP = (o) => ({ order: o.order, item: o.item ?? '1', ship: o.ship, status: o.status, inv: o.inv, tx: o.tx, type: o.type });
const pair = (n, ship, order, fmt, rs, cs) => [SP({ order, ship, tx: `CorrectionReversal:X:${n}`, type: 'REFUND', status: rs, inv: rs.endsWith('Uploaded') ? `R-2026-${n}` : '' }), SP({ order, ship, tx: fmt === 'current' ? `Correction::X:${n}` : `Correction:X:${n}`, type: 'SHIPMENT', status: cs, inv: cs.endsWith('Uploaded') ? `A-2026-${n}` : '' })];
const special = (later) => [
  SP({ order: '405-9000001-0000001', ship: 'S9701', tx: 'amzn1:crow:SYNTHETIC0002', type: 'REFUND', status: 'CreditNoteCreatedByAmazon' }),
  SP({ order: '405-9000002-0000002', ship: 'S9801', status: 'InvoiceCreatedByAmazon' }),
  SP({ order: '405-9000003-0000003', ship: 'S9802', status: 'NoTaxCalculated' }),
  SP({ order: '405-9000004-0000004', ship: 'S9803', status: later ? 'InvoiceUploaded' : 'NoTaxCalculated', inv: later ? 'A-2026-000900' : '' }),
  ...pair('200000001', 'S9810', '405-9100001-0000001', 'current', 'CreditNoteUploaded', 'InvoiceUploaded'),
  ...pair('200000002', 'S9820', '405-9100002-0000002', 'legacy', 'CreditNoteUploaded', 'InvoiceUploaded'),
  // near-misses: begin with "Correction" but are not an allowed shape, or have the wrong transaction type
  SP({ order: '405-9200001-0000001', ship: 'S9830', tx: 'CorrectionX:1', type: 'SHIPMENT', status: 'InvoiceUploaded', inv: 'A-2026-000931' }),
  SP({ order: '405-9200002-0000002', ship: 'S9831', tx: 'Correction:X:', type: 'SHIPMENT', status: 'InvoiceUploaded', inv: 'A-2026-000932' }),
  SP({ order: '405-9200003-0000003', ship: 'S9832', tx: 'Correction:::X:1', type: 'SHIPMENT', status: 'InvoiceUploaded', inv: 'A-2026-000933' }),
  SP({ order: '405-9200004-0000004', ship: 'S9833', tx: 'CorrectionReversal:X:1', type: 'SHIPMENT', status: 'InvoiceUploaded', inv: 'A-2026-000934' }),
  SP({ order: '405-9200005-0000005', ship: 'S9834', tx: 'Correction::X:1', type: 'REFUND', status: 'CreditNoteUploaded', inv: 'R-2026-000935' }),
  SP({ order: '405-9200006-0000006', ship: 'S9835', tx: 'Corrections:X:1', type: 'SHIPMENT', status: 'InvoiceUploaded', inv: 'A-2026-000936' }),
  SP({ order: '405-9200007-0000007', ship: 'S9836', tx: 'CorrectionReversal::X:1', type: 'REFUND', status: 'CreditNoteUploaded', inv: 'R-2026-000937' }),
  // lower-case "correction" does not start with the word as Amazon writes it: an ordinary transaction, not a correction
  SP({ order: '405-9200008-0000008', ship: 'S9837', tx: 'correction:X:1', type: 'SHIPMENT', status: 'InvoiceUploaded', inv: 'A-2026-000938' }),
];
files['special-r1.tsv'] = special(false); files['special-r2.tsv'] = special(true);
mkdirSync('fixtures/recon', { recursive: true });
for (const [n, rows] of Object.entries(files)) writeFileSync(`fixtures/recon/${n}`, tsv(rows.map(R)));
const dec = (extra) => ({ reportType: 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', options: 'ALL', rangeFrom: '2026-11-01', rangeTo: '2026-11-30', marketplace: MP, createdAfterUploadConfirmed: true, obtainedHow: 'Seller downloaded it from Seller Central (declared by the seller)', ...extra });
writeFileSync('fixtures/recon/declared.json', JSON.stringify({
  'all-r1-pending.tsv': dec({ createdAt: '2026-11-10T08:00:00Z', downloadedAt: '2026-11-10T08:05:00Z' }),
  'all-r2-processing.tsv': dec({ createdAt: '2026-11-12T08:00:00Z', downloadedAt: '2026-11-12T08:05:00Z' }),
  'all-r3-uploaded.tsv': dec({ createdAt: '2026-11-14T08:00:00Z', downloadedAt: '2026-11-14T08:05:00Z' }),
  'special-r1.tsv': dec({ createdAt: '2026-11-16T08:00:00Z', downloadedAt: '2026-11-16T08:05:00Z' }),
  'special-r2.tsv': dec({ createdAt: '2026-11-18T08:00:00Z', downloadedAt: '2026-11-18T08:05:00Z' }),
  'pending-only.tsv': { reportType: 'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', options: 'PENDING_ONLY', marketplace: MP, downloadedAt: '2026-11-15T09:00:00Z', createdAt: '2026-11-15T08:55:00Z', createdAfterUploadConfirmed: true, obtainedHow: 'Seller downloaded the default report (declared by the seller)' },
}, null, 2) + '\n');
console.log('written', Object.keys(files).length, 'fixtures');
