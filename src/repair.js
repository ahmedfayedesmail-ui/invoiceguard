// Repair Engine, stage 1: detect correction events in a VIDR and queue
// review-first repair proposals. Nothing is issued or uploaded here; a human
// reviews each proposal first (pilot rule). Amazon billing-data corrections
// (CorrectionReversal / Correction:: pairs) stay in pipeline.processCorrections.
import { parseVidr } from './vidr.js';

export function ensureRepairTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS repairs (
    seller_id TEXT, event_key TEXT, kind TEXT, original_number TEXT, shipment_key TEXT,
    reason TEXT, suggestion TEXT, state TEXT DEFAULT 'proposed', created_at TEXT,
    PRIMARY KEY (seller_id, event_key))`);
}

/**
 * Plain returns/refunds (transaction-type REFUND rows that are not Amazon
 * billing-data corrections) referencing an invoice we issued become proposals.
 * Idempotent: one proposal per (seller, event key).
 */
export function detectRepairs(db, seller, reportText, { now = new Date() } = {}) {
  ensureRepairTables(db);
  const out = { proposed: 0, skipped: [], proposals: [] };
  const refunds = parseVidr(reportText).filter(s => s.transactionType === 'REFUND' && !s.isCorrectionReversal);
  const ins = db.prepare(`INSERT OR IGNORE INTO repairs
    (seller_id, event_key, kind, original_number, shipment_key, reason, suggestion, state, created_at)
    VALUES (?,?,?,?,?,?,?, 'proposed', ?)`);
  for (const s of refunds) {
    const orig = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice' ORDER BY issued_at DESC LIMIT 1")
      .get(seller.id, `SHIPMENT:${s.shippingId}`);
    if (!orig) { out.skipped.push({ key: s.key, reason: 'original invoice not issued by us' }); continue; }
    const reason = `Return or refund received for order ${s.orderId} after invoice ${orig.number} was issued`;
    const suggestion = JSON.stringify({ action: 'credit_note', rectifies: orig.number, total: Math.abs(s.incl), vat: Math.abs(s.vat), transactionId: s.transactionId });
    const r = ins.run(seller.id, s.key, 'return', orig.number, s.key, reason, suggestion, now.toISOString());
    if (r.changes) { out.proposed++; out.proposals.push({ key: s.key, original: orig.number, reason }); }
  }
  return out;
}

/** The review queue: proposals waiting for a human decision, oldest first. */
export const listRepairs = (db, sellerId, state = 'proposed') => {
  ensureRepairTables(db);
  return db.prepare('SELECT * FROM repairs WHERE seller_id=? AND state=? ORDER BY created_at').all(sellerId, state)
    .map(r => ({ ...r, suggestion: JSON.parse(r.suggestion) }));
};

/** Record a human decision on a proposal (approved | dismissed). */
export function decideRepair(db, sellerId, eventKey, decision) {
  ensureRepairTables(db);
  if (!['approved', 'dismissed'].includes(decision)) throw new Error(`Unknown decision "${decision}"`);
  const r = db.prepare("UPDATE repairs SET state=? WHERE seller_id=? AND event_key=? AND state='proposed'").run(decision, sellerId, eventKey);
  if (!r.changes) throw new Error(`No proposed repair ${eventKey}`);
}
