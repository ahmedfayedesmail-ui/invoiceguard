// Repair Engine, stage 1: detect correction events in a VIDR and queue
// review-first repair proposals. Nothing is issued or uploaded here; a human
// reviews each proposal first (pilot rule). Amazon billing-data corrections
// (CorrectionReversal / Correction:: pairs) stay in pipeline.processCorrections.
import { parseVidr } from './vidr.js';
import { issueRectificativa } from './pipeline.js';
import { logEvent } from './db.js';

export function ensureRepairTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS repairs (
    seller_id TEXT, event_key TEXT, kind TEXT, original_number TEXT, shipment_key TEXT,
    reason TEXT, suggestion TEXT, state TEXT DEFAULT 'proposed', created_at TEXT,
    PRIMARY KEY (seller_id, event_key))`);
  try { db.exec('ALTER TABLE repairs ADD COLUMN rect_number TEXT'); } catch { /* exists */ }
}

/**
 * Plain returns/refunds (transaction-type REFUND rows that are not Amazon
 * billing-data corrections) referencing an invoice we issued become proposals.
 * Idempotent: one proposal per (seller, event key).
 */
export function detectRepairs(db, seller, reportText, { now = new Date() } = {}) {
  ensureRepairTables(db);
  const out = { proposed: 0, skipped: [], proposals: [] };
  const all = parseVidr(reportText);
  // W12: never drop an unknown Amazon transaction type silently - surface it in the event log.
  const unknown = [...new Set(all.map(s => s.transactionType).filter(t => !['SHIPMENT', 'REFUND'].includes(t)))];
  if (unknown.length) logEvent(db, seller.id, 'vidr_unknown_transaction_types', { types: unknown });
  const refunds = all.filter(s => s.transactionType === 'REFUND' && !s.isCorrectionReversal);
  const ins = db.prepare(`INSERT OR IGNORE INTO repairs
    (seller_id, event_key, kind, original_number, shipment_key, reason, suggestion, state, created_at)
    VALUES (?,?,?,?,?,?,?, 'proposed', ?)`);
  for (const s of refunds) {
    const orig = db.prepare("SELECT number, total FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice' ORDER BY issued_at DESC LIMIT 1")
      .get(seller.id, `SHIPMENT:${s.shippingId}`);
    if (!orig) { out.skipped.push({ key: s.key, reason: 'original invoice not issued by us' }); continue; }
    if (Math.abs(orig.total) < 0.005 || Math.abs(s.incl) < 0.005) { out.skipped.push({ key: s.key, reason: 'zero amount, nothing to credit' }); continue; } // a zero-total invoice has nothing to refund; proposing one would fail the differences rule
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

/**
 * Approve a return proposal and act on it: issue the full credit note
 * (rectificativa by differences with zeroed lines) chained to the original,
 * with the refund's Amazon TransactionId, and mark the repair issued.
 * Accepts a proposal in state 'proposed' or 'approved' (human reviewed).
 */
export async function approveRepair(db, seller, eventKey, { api, validate } = {}) {
  ensureRepairTables(db);
  const r = db.prepare("SELECT * FROM repairs WHERE seller_id=? AND event_key=? AND state IN ('proposed','approved')").get(seller.id, eventKey);
  if (!r) throw new Error(`No open repair ${eventKey}`);
  const sug = JSON.parse(r.suggestion);
  if (sug.action !== 'credit_note') throw new Error(`Unsupported repair action ${sug.action}`);
  const orig = JSON.parse(db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, r.original_number).json);
  const zero = orig.lines.map(l => ({ ...l, excl: 0, vat: 0 }));
  const { rect } = await issueRectificativa(db, seller, r.original_number,
    { mode: 'differences', reason: r.reason, changes: { lines: zero }, documentType: 'CreditNote', transactionId: sug.transactionId, recordKey: r.event_key },
    { api, validate });
  db.prepare("UPDATE repairs SET state='issued', rect_number=? WHERE seller_id=? AND event_key=?").run(rect.number, seller.id, eventKey);
  return { rectNumber: rect.number, original: r.original_number };
}

/** Record a human decision on a proposal (approved | dismissed). */
export function decideRepair(db, sellerId, eventKey, decision) {
  ensureRepairTables(db);
  if (!['approved', 'dismissed'].includes(decision)) throw new Error(`Unknown decision "${decision}"`);
  const r = db.prepare("UPDATE repairs SET state=? WHERE seller_id=? AND event_key=? AND state='proposed'").run(decision, sellerId, eventKey);
  if (!r.changes) throw new Error(`No proposed repair ${eventKey}`);
}
