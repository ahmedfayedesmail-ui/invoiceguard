// Public no-signup sample: runs the real pipeline on made-up orders in a throwaway in-memory DB.
// Nothing is stored, nothing is sent anywhere. The data comes from the same fixtures as the in-app demo.
import { openDb, migrateAuth } from './db.js';
import { migrateSecurity, migrateSecLog } from './security.js';
import { MockApi } from './mockamazon.js';
import { processReport } from './pipeline.js';
import { renderPdfCached as renderPdf } from './pdf.js';

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
  const run = await sampleRun(validate); // deterministic: same fixture, same numbering, same day
  const r = run.db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(SAMPLE_SELLER.id, number);
  return r ? renderPdf(JSON.parse(r.json)) : null;
}
