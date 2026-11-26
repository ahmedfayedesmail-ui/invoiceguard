// Public no-signup sample: runs the real pipeline on made-up orders in a throwaway in-memory DB.
// Nothing is stored, nothing is sent anywhere. The data comes from the same fixtures as the in-app demo.
import { openDb, migrateAuth } from './db.js';
import { migrateSecurity, migrateSecLog } from './security.js';
import { MockApi } from './mockamazon.js';
import { processReport, pollFeeds } from './pipeline.js';
import { detectRepairs, listRepairs, approveRepair } from './repair.js';
import { renderPdfCached as renderPdf } from './pdf.js';
import { readFileSync } from 'node:fs';

const SAMPLE_SELLER = {
  id: 'sample-seller', name: 'Sierra Componentes S.L.', nif: 'B11111119',
  address: 'Calle Prueba 1, 28001 Madrid', email: null,
  marketplace_ids: '["ES"]', region: 'EU', country: 'ES',
};

export async function sampleRun(validate) {
  const db = openDb();
  migrateAuth(db); migrateSecurity(db); migrateSecLog(db);
  db.prepare('INSERT INTO sellers (id,name,nif,address,email,marketplace_ids,region,created_at,country) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(SAMPLE_SELLER.id, SAMPLE_SELLER.name, SAMPLE_SELLER.nif, SAMPLE_SELLER.address, SAMPLE_SELLER.email, SAMPLE_SELLER.marketplace_ids, SAMPLE_SELLER.region, new Date().toISOString(), SAMPLE_SELLER.country);
  const api = new MockApi();
  const text = await api.downloadReport();
  const out = await processReport(db, SAMPLE_SELLER, text, { api, validate });
  const shipments = db.prepare('SELECT order_id, buyer, buyer_vat, country, total, status, reason FROM shipments WHERE seller_id=? ORDER BY shipment_date DESC, key').all(SAMPLE_SELLER.id);
  const invoices = db.prepare('SELECT number, total, upload_status FROM invoices WHERE seller_id=? ORDER BY number').all(SAMPLE_SELLER.id);
  return { db, seller: SAMPLE_SELLER, out, shipments, invoices };
}

export async function samplePdf(validate, number) {
  if (/^R-/.test(number)) { // the credit note exists only in the repair run
    const run = await sampleRepair(validate);
    if (!run.ok) return null;
    const r = run.db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(SAMPLE_SELLER.id, number);
    return r ? renderPdf(JSON.parse(r.json)) : null;
  }
  const run = await sampleRun(validate); // deterministic: same fixture, same numbering, same day
  const r = run.db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(SAMPLE_SELLER.id, number);
  return r ? renderPdf(JSON.parse(r.json)) : null;
}

const FIXTURE = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');

/** The wow card: a return arrives after issuance and the repair loop closes, live, on made-up data.
 *  Review-first stays visible: the demo approves the proposal for the visitor and says so, and the
 *  Amazon acceptance step is labeled simulated (the pilot uploads nothing to Amazon). */
export async function sampleRepair(validate) {
  const run = await sampleRun(validate);
  const { db } = run;
  const inv = run.invoices[0];
  if (!inv) return { ok: false };
  const key = db.prepare('SELECT shipment_key FROM invoices WHERE seller_id=? AND number=?').get(SAMPLE_SELLER.id, inv.number).shipment_key;
  const orderId = db.prepare('SELECT order_id FROM shipments WHERE seller_id=? AND key=?').get(SAMPLE_SELLER.id, key).order_id;
  const [head, ...rows] = FIXTURE.trim().split('\n');
  const cols = head.split('\t'), oi = cols.indexOf('order-id'), ti = cols.indexOf('transaction-type'), ii = cols.indexOf('transaction-id');
  const line = rows.find(r => r.split('\t')[oi] === orderId);
  if (!line) return { ok: false };
  const c = line.split('\t'); c[ti] = 'REFUND'; c[ii] = 'RF-SAMPLE-1'; c[cols.indexOf('invoice-status')] = 'CreditNotePending';
  const t = () => new Date().toISOString().slice(11, 19);
  const steps = [{ t: t(), label: `Invoice ${inv.number} issued for order ${orderId}` }];
  detectRepairs(db, SAMPLE_SELLER, head + '\n' + c.join('\t') + '\n');
  const prop = listRepairs(db, SAMPLE_SELLER.id, 'proposed')[0];
  if (!prop) return { ok: false };
  steps.push({ t: t(), label: `Return detected for order ${orderId}` });
  steps.push({ t: t(), label: `Repair proposed: a credit note that cancels ${inv.number}` });
  const api = new MockApi();
  const ap = await approveRepair(db, SAMPLE_SELLER, prop.event_key, { api, validate });
  steps.push({ t: t(), label: `Credit note ${ap.rectNumber} issued, legally chained to ${inv.number}` });
  await pollFeeds(db, SAMPLE_SELLER, api);
  steps.push({ t: t(), label: 'Upload accepted (simulated in this demo - in your account you upload the pack to Amazon yourself)' });
  return { ok: true, order: orderId, invoice: inv.number, credit: ap.rectNumber, steps, db };
}
