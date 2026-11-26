// Repair Engine, stage 1: detect correction events in a VIDR and queue
// review-first repair proposals. Nothing is issued or uploaded here; a human
// reviews each proposal first (pilot rule). Amazon billing-data corrections
// (CorrectionReversal / Correction:: pairs) stay in pipeline.processCorrections.
import { parseVidr } from './vidr.js';
import { issueRectificativa } from './pipeline.js';
import { EXTRA_LABEL, totalsOf } from './invoice.js';
import { logEvent } from './db.js';

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const MANUAL_FIX = 'Correct the invoice yourself in Documents > Invoices - nothing was issued.';

export function ensureRepairTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS repairs (
    seller_id TEXT, event_key TEXT, kind TEXT, original_number TEXT, shipment_key TEXT,
    reason TEXT, suggestion TEXT, state TEXT DEFAULT 'proposed', created_at TEXT,
    PRIMARY KEY (seller_id, event_key))`);
  try { db.exec('ALTER TABLE repairs ADD COLUMN rect_number TEXT'); } catch { /* exists */ }
}

/**
 * Plain returns/refunds (transaction-type RETURN or REFUND rows that are not Amazon
 * billing-data corrections) referencing an invoice we issued become proposals.
 * Idempotent: one proposal per (seller, event key).
 */
export function detectRepairs(db, seller, reportText, { now = new Date() } = {}) {
  ensureRepairTables(db);
  const out = { proposed: 0, skipped: [], proposals: [] };
  const all = parseVidr(reportText);
  // W12: never drop an unknown Amazon transaction type silently - surface it in the event log.
  const unknown = [...new Set(all.map(s => s.transactionType).filter(t => !['SHIPMENT', 'REFUND', 'RETURN'].includes(t)))];
  if (unknown.length) logEvent(db, seller.id, 'vidr_unknown_transaction_types', { types: unknown });
  // Amazon's transaction-type vocabulary is SHIPMENT / RETURN / REFUND (create-and-upload-invoices doc):
  // both RETURNs and REFUNDs can put a credit note due (CreditNotePending). Missing either loses money.
  const refunds = all.filter(s => ['REFUND', 'RETURN'].includes(s.transactionType) && !s.isCorrectionReversal);
  const ins = db.prepare(`INSERT OR IGNORE INTO repairs
    (seller_id, event_key, kind, original_number, shipment_key, reason, suggestion, state, created_at)
    VALUES (?,?,?,?,?,?,?, 'proposed', ?)`);
  for (const s of refunds) {
    const orig = db.prepare("SELECT number, total FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice' ORDER BY issued_at DESC LIMIT 1")
      .get(seller.id, `SHIPMENT:${s.shippingId}`);
    if (!orig) { out.skipped.push({ key: s.key, reason: 'original invoice not issued by us' }); continue; }
    if (Math.abs(orig.total) < 0.005 || Math.abs(s.incl) < 0.005) { out.skipped.push({ key: s.key, reason: 'zero amount, nothing to credit' }); continue; } // a zero-total invoice has nothing to refund; proposing one would fail the differences rule
    const reason = `Return or refund received for order ${s.orderId} after invoice ${orig.number} was issued`;
    // Exact returned amounts per item (the refund row carries the same item columns as the shipment),
    // so approving a PARTIAL return credits only what came back, never the whole invoice.
    const full = Math.abs(Math.abs(s.incl) - Math.abs(orig.total)) < 0.005;
    const suggestion = JSON.stringify({ action: 'credit_note', rectifies: orig.number, total: Math.abs(s.incl), vat: Math.abs(s.vat), transactionId: s.transactionId, full,
      lines: s.items.map(it => ({ sku: it.sku ?? null, excl: Math.abs(it.exclTotal), vat: Math.abs(it.vatTotal), extras: (it.extras ?? []).map(x => ({ part: x.part, excl: Math.abs(x.excl), vat: Math.abs(x.vat) })) })) });
    const r = ins.run(seller.id, s.key, 'return', orig.number, s.key, reason, suggestion, now.toISOString());
    // Proposals made before exact amounts were recorded get upgraded in place on the next sync.
    if (!r.changes) db.prepare("UPDATE repairs SET suggestion=? WHERE seller_id=? AND event_key=? AND state='proposed'").run(suggestion, seller.id, s.key);
    if (r.changes) { out.proposed++; out.proposals.push({ key: s.key, original: orig.number, reason }); logEvent(db, seller.id, 'repair_proposed', { key: s.key, original: orig.number, reason }); }
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
 * Approve a return proposal and act on it: issue the credit note (rectificativa by differences)
 * chained to the original, with the refund's Amazon TransactionId, and mark the repair issued.
 * FULL return: all lines zeroed - the credit note cancels the invoice. PARTIAL return: only the
 * returned amounts are credited - each returned item is subtracted from its own invoice line by
 * SKU, shipping and other extras by their line label. Anything we cannot match exactly stops the
 * issue with an explanation; we never guess an amount onto a financial document.
 * Accepts a proposal in state 'proposed' or 'approved' (human reviewed).
 */
export async function approveRepair(db, seller, eventKey, { api, validate } = {}) {
  ensureRepairTables(db);
  const r = db.prepare("SELECT * FROM repairs WHERE seller_id=? AND event_key=? AND state IN ('proposed','approved')").get(seller.id, eventKey);
  if (!r) throw new Error(`No open repair ${eventKey}`);
  const sug = JSON.parse(r.suggestion);
  if (sug.action !== 'credit_note') throw new Error(`Unsupported repair action ${sug.action}`);
  if (sug.full === undefined) throw new Error('This proposal was recorded before exact refund amounts were kept. Press Sync now so it is rebuilt, then review it again.');
  const orig = JSON.parse(db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, r.original_number).json);
  const cents = (n) => Math.round(n * 100);
  // Cumulative guard: prior credit notes against this invoice count toward what may still be
  // credited. Each new refund is checked against what REMAINS, never against the original alone,
  // so a stream of partial refunds can never credit more than the invoice was worth.
  // This event's own pending row (an earlier upload that failed) is not "already credited":
  // it is the document we are about to retry, so it is excluded from the cumulative count.
  const prior = db.prepare("SELECT json FROM invoices WHERE seller_id=? AND rectifies=? AND kind='rectificativa' AND upload_status NOT IN ('rejected') AND shipment_key != ?").all(seller.id, r.original_number, r.event_key)
    .map(p => JSON.parse(p.json));
  if (prior.some(j => j.mode === 'substitution')) throw new Error(`Invoice ${r.original_number} was replaced by a substitution correction, so refund lines cannot be matched against the original safely. ` + MANUAL_FIX);
  // remaining[i]: what is left of each original line after prior difference credits (deltas are negative).
  const remaining = orig.lines.map(l => ({ ...l }));
  let creditedCents = 0, creditedVatCents = 0;
  for (const j of prior) {
    if (j.mode !== 'differences') continue;
    creditedCents += cents(Math.abs(j.totals.incl)); creditedVatCents += cents(Math.abs(j.totals.vat));
    for (const d of j.lines ?? []) { const m = remaining.find(l => l.description === d.description); if (m) { m.excl = r2(m.excl + d.excl); m.vat = r2(m.vat + d.vat); } }
  }
  if (creditedCents + cents(sug.total) > cents(orig.totals.incl) + 0 || creditedVatCents + cents(sug.vat) > cents(orig.totals.vat) + 0)
    throw new Error('The refunds for this invoice add up to more than the invoice itself. ' + MANUAL_FIX);
  let corrected;
  if (sug.full || !Array.isArray(sug.lines)) {
    corrected = orig.lines.map(l => ({ ...l, excl: 0, vat: 0 }));
  } else {
    corrected = orig.lines.map(l => ({ ...l }));
    const take = (line, amount, rem) => {
      line.excl = r2(line.excl - amount.excl); line.vat = r2(line.vat - amount.vat);
      if (rem) { rem.excl = r2(rem.excl - amount.excl); rem.vat = r2(rem.vat - amount.vat); }
      if (line.excl < -0.005 || line.vat < -0.005) throw new Error(`The returned amount for "${line.description}" is larger than that line on the original invoice. ` + MANUAL_FIX);
      if (rem && (rem.excl < -0.005 || rem.vat < -0.005)) throw new Error(`The refunds for "${line.description}" add up to more than that line was worth. ` + MANUAL_FIX);
    };
    for (const it of sug.lines) {
      if (Math.abs(it.excl) > 0.005 || Math.abs(it.vat) > 0.005) {
        // Duplicate SKUs: match the one line this refund can belong to; ambiguity stops the issue.
        const cand = it.sku ? corrected.map((l, i) => ({ l, i })).filter(x => x.l.sku === it.sku) : [];
        let pick = null;
        if (cand.length === 1) pick = cand[0];
        else if (cand.length > 1) {
          const fits = cand.filter(x => cents(remaining[x.i].excl) >= cents(it.excl) && cents(remaining[x.i].vat) >= cents(it.vat));
          if (fits.length === 1) pick = fits[0];
          else throw new Error(`The refund names "${it.sku}", which is on ${cand.length} invoice lines, and the exact line cannot be determined. ` + MANUAL_FIX);
        }
        if (!pick) throw new Error('The returned items cannot be matched to the original invoice lines, so the exact credit cannot be computed. ' + MANUAL_FIX);
        take(pick.l, it, remaining[pick.i]);
      }
      for (const x of it.extras ?? []) {
        if (Math.abs(x.excl) > 0.005 || Math.abs(x.vat) > 0.005) {
          const i = corrected.findIndex(l => l.description === EXTRA_LABEL[x.part]);
          if (i < 0) throw new Error(`The refund includes "${EXTRA_LABEL[x.part] ?? x.part}", which is not on the original invoice. ` + MANUAL_FIX);
          take(corrected[i], x, remaining[i]);
        }
      }
    }
    // Cross-check against the refund total Amazon reported, in integer cents: the corrected invoice
    // must equal original minus refund to the exact cent, otherwise stop - we never issue wrong money.
    const t = totalsOf(corrected);
    if (cents(orig.totals.incl) - cents(sug.total) !== cents(t.incl) || cents(orig.totals.vat) - cents(sug.vat) !== cents(t.vat))
      throw new Error('The returned amounts do not add up against the original invoice to the cent, so the exact credit cannot be computed. ' + MANUAL_FIX);
  }
  const { rect } = await issueRectificativa(db, seller, r.original_number,
    { mode: 'differences', reason: r.reason, changes: { lines: corrected }, documentType: 'CreditNote', transactionId: sug.transactionId, recordKey: r.event_key },
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
