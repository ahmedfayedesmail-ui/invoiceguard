// Repair Engine, stage 1: detect correction events in a VIDR and queue
// review-first repair proposals. Nothing is issued or uploaded here; a human
// reviews each proposal first (pilot rule). Amazon billing-data corrections
// (CorrectionReversal / Correction:: pairs) stay in pipeline.processCorrections.
import { parseVidr } from './vidr.js';
import { issueRectificativa } from './pipeline.js';
import { renderPdf } from './pdf.js';
import { marketplaceFor } from './spapi.js';
import { EXTRA_LABEL, totalsOf } from './invoice.js';
import { logEvent, tx } from './db.js';

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
    // Amazon's invoice-status column says what this refund needs: only CreditNotePending means the
    // seller must upload a credit note. CreditNoteUploaded / CreditNoteCreatedByAmazon /
    // CreditNoteProcessing are already covered - proposing there would double-credit. CreditNoteRejected
    // has its own correction-and-retry path (Amazon: upload the same credit note again).
    const st = s.invoiceStatus || '';
    if (st !== 'CreditNotePending') { out.skipped.push({ key: s.key, reason: st === 'CreditNoteRejected' ? 'credit note rejected - the retry path re-uploads it, no new proposal is made' : `no credit note due from the seller (Amazon status: ${st || 'none'})` }); continue; }
    const orig = db.prepare("SELECT number, total, vat FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice' ORDER BY issued_at DESC LIMIT 1")
      .get(seller.id, `SHIPMENT:${s.shippingId}`);
    if (!orig) { out.skipped.push({ key: s.key, reason: 'original invoice not issued by us' }); continue; }
    if (Math.abs(orig.total) < 0.005 || Math.abs(s.incl) < 0.005) { out.skipped.push({ key: s.key, reason: 'zero amount, nothing to credit' }); continue; } // a zero-total invoice has nothing to refund; proposing one would fail the differences rule
    const reason = `Return or refund received for order ${s.orderId} after invoice ${orig.number} was issued`;
    // Exact returned amounts per item (the refund row carries the same item columns as the shipment),
    // so approving a PARTIAL return credits only what came back, never the whole invoice.
    // "Full" means Amazon's refund matches the invoice to the cent on BOTH gross and tax. A one-cent
    // tax mismatch is not a plain cancellation: it goes the exact-lines path, which holds the credit
    // note instead of zeroing blindly (Amazon rejects TotalVATAmount mismatches at 2 decimals).
    const full = Math.abs(Math.abs(s.incl) - Math.abs(orig.total)) < 0.005 && Math.abs(Math.abs(s.vat) - Math.abs(orig.vat)) < 0.005;
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
  const r = db.prepare("SELECT * FROM repairs WHERE seller_id=? AND event_key=? AND state IN ('proposed','approved','rejected')").get(seller.id, eventKey);
  if (!r) throw new Error(`No open repair ${eventKey}`);
  // Atomic claim: exactly one concurrent approval moves the repair to 'issuing'. A second approval
  // changes zero rows and stops, so one Amazon event can never mint two financial documents.
  const claimed = db.prepare("UPDATE repairs SET state='issuing' WHERE seller_id=? AND event_key=? AND state IN ('proposed','approved','rejected')").run(seller.id, eventKey);
  if (!claimed.changes) throw new Error(`Repair ${eventKey} is already being issued`);
  try {
    return await approveClaimed(db, seller, r, { api, validate });
  } catch (e) {
    // An interrupted upload (unknown outcome) already marked the document 'unknown' and created its
    // own UNKNOWN hold. Returning THIS repair to 'proposed' would show a doomed action next to that
    // hold (approving it can only fail on the unknown-outcome guard), so it is held visibly instead -
    // Amazon's verdict or the settling resend closes both (closeRepairsFor includes 'held').
    const next = e.unknownOutcome ? 'held' : (r.state === 'rejected' ? 'rejected' : 'proposed');
    db.prepare("UPDATE repairs SET state=? WHERE seller_id=? AND event_key=? AND state='issuing'").run(next, seller.id, eventKey);
    throw e;
  }
}

/** Re-upload a rejected document: Amazon's prescribed retry is the SAME document, never a new number. */
async function retryRejectedUpload(db, seller, number, { api }) {
  const row = db.prepare('SELECT json, shipment_key, upload_status, kind FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number);
  if (!row) throw new Error(`Document ${number} not found`);
  if (row.kind !== 'invoice') throw new Error(`Document ${number} is a correction document - those retry through their own record-key path, not this one. Nothing was re-uploaded.`);
  if (row.upload_status === 'unknown') throw new Error(`The upload outcome of ${number} is unknown - Amazon may already hold it. It is NOT resent on approval alone; the next Amazon report settles it. Nothing was re-uploaded.`);
  if (row.upload_status !== 'rejected') throw new Error(`Document ${number} is ${row.upload_status}, not rejected - there is nothing to retry`);
  const ship = db.prepare('SELECT raw FROM shipments WHERE seller_id=? AND key=?').get(seller.id, row.shipment_key);
  if (!ship) throw new Error(`Shipment ${row.shipment_key} of document ${number} is not on record, so the retry target cannot be proven. Nothing was re-uploaded.`);
  const doc = JSON.parse(row.json);
  const s = JSON.parse(ship.raw);
  const mp = marketplaceFor(s.marketplace);
  if (!mp) throw new Error(`The shipment's store code "${s.marketplace || 'none'}" cannot be mapped to an Amazon marketplace, so the upload target was not guessed. Nothing was re-uploaded.`);
  const pdf = await renderPdf(doc);
  // Same discipline as the first upload: mark 'sending' BEFORE the call, so a crash in the window
  // between Amazon accepting the retry and the local write is recovered at boot by
  // recoverUncertainUploads ('unknown' + human hold) - never invisible, never blindly resent.
  // Round-8: this write is the ATOMIC CLAIM - a concurrent settle path or a double-submitted
  // approval must never upload the same document twice. The loser changes 0 rows and stops.
  const claim = db.prepare("UPDATE invoices SET upload_status='sending', sending_at=? WHERE seller_id=? AND number=? AND upload_status='rejected'").run(new Date().toISOString(), seller.id, number);
  if (!claim.changes) throw new Error(`Document ${number} is already being retried by another run. Nothing was re-uploaded.`);
  db.prepare("UPDATE shipments SET status='sending' WHERE seller_id=? AND key=?").run(seller.id, row.shipment_key);
  let feedId;
  try {
    feedId = await api.uploadInvoice({ marketplaceId: mp, pdf, orderId: s.orderId, shippingId: s.shippingId, number: doc.number, total: Math.abs(doc.totals.incl), vat: Math.abs(doc.totals.vat) });
  } catch (e) {
    // Same discipline as the first upload: an unknown outcome is never resent blindly. The document
    // goes to 'unknown' with a human-visible hold; the next Amazon report settles it.
    if (e.unknownOutcome) {
      // Status write + hold proposal in ONE transaction (round-8): no crash can lose the hold.
      tx(db, () => {
        db.prepare("UPDATE invoices SET upload_status='unknown' WHERE seller_id=? AND number=?").run(seller.id, number);
        db.prepare("UPDATE shipments SET status='unknown', reason='the upload outcome is unknown - Amazon may have received the document' WHERE seller_id=? AND key=?").run(seller.id, row.shipment_key);
        logEvent(db, seller.id, 'upload_unknown_outcome', { number, error: e.message });
        proposeRejectedRetry(db, seller, { eventKey: `UNKNOWN:${row.shipment_key}`, kind: 'unknown_outcome', number, shipmentKey: row.shipment_key, action: 'hold',
          reason: `The retry upload of invoice ${number} was interrupted after Amazon may already have received it. It was NOT resent automatically, to avoid a double submission. The next Amazon report settles it: still pending there, cross-checked against Amazon's own feed list, lets the next sync resubmit it; a verdict closes it. If you have checked in Seller Central that Amazon does not hold the document, dismiss this hold and the next sync resends it.` });
      });
    } else {
      // A DEFINITE refusal (Amazon never accepted the retry): restore 'rejected' so the reviewed
      // retry stays available. Only an unknown outcome holds.
      db.prepare("UPDATE invoices SET upload_status='rejected' WHERE seller_id=? AND number=?").run(seller.id, number);
      db.prepare("UPDATE shipments SET status='rejected' WHERE seller_id=? AND key=?").run(seller.id, row.shipment_key);
    }
    throw e;
  }
  db.prepare("UPDATE invoices SET feed_id=?, upload_status='submitted' WHERE seller_id=? AND number=?").run(feedId, seller.id, number);
  db.prepare("UPDATE shipments SET status='submitted' WHERE seller_id=? AND key=?").run(seller.id, row.shipment_key);
  logEvent(db, seller.id, 'rejected_upload_retried', { number });
  return feedId;
}

/** Boot recovery for the crash window BETWEEN Amazon accepting an upload and the local write of its
 * feed id: such documents sit in 'sending'. Local data alone cannot prove whether Amazon holds them,
 * so they become 'unknown' with a human-visible hold - and the next Amazon report settles them
 * (still due there = safe automatic resend of the same document; a verdict = closed). */
export function recoverUncertainUploads(db) {
  ensureRepairTables(db);
  const stuck = db.prepare("SELECT seller_id, number, shipment_key, kind, rectifies, sending_at, feed_id FROM invoices WHERE upload_status='sending'").all();
  for (const inv of stuck) {
    // Round-9 (N4): status write + hold proposal in ONE transaction - a crash between them used to
    // leave the document 'unknown' with no visible hold (settle checks still prevented a resend,
    // but the hold was lost). Synchronous writes only; no awaits inside.
    tx(db, () => {
      db.prepare("UPDATE invoices SET upload_status='unknown', blocked_feed_id=? WHERE seller_id=? AND number=?").run(inv.feed_id ?? null, inv.seller_id, inv.number);
      db.prepare("UPDATE shipments SET status='unknown', reason='the upload outcome is unknown - Amazon may have received the document' WHERE seller_id=? AND key=? AND status='sending'").run(inv.seller_id, inv.shipment_key);
      // attemptedAt = when the attempt STARTED (written before the Amazon call); the settle window
      // anchors on it (unknownSettleCheck), not on this recovery event's time, so a long downtime
      // cannot push the original feed outside the cross-check window.
      logEvent(db, inv.seller_id, 'upload_unknown_outcome', { number: inv.number, attemptedAt: inv.sending_at || null, error: 'the app stopped between Amazon accepting the upload and saving the result' });
      proposeRejectedRetry(db, { id: inv.seller_id }, { eventKey: `UNKNOWN:${inv.shipment_key}`, kind: 'unknown_outcome', number: inv.number, originalNumber: inv.rectifies ?? inv.number, shipmentKey: inv.shipment_key, rectNumber: inv.kind === 'rectificativa' ? inv.number : null, action: 'hold',
        reason: `The app stopped while uploading ${inv.number}; Amazon may already have received the document. It was NOT resent automatically, to avoid a double submission. The next Amazon report settles it: still due there means the next sync resubmits the same document safely, a verdict closes it. If you have checked in Seller Central that Amazon does not hold the document, dismiss this hold and the next sync resends it.` });
    });
  }
  return stuck.length;
}

/** Three-way classification of an Amazon rejection reason.
 * 'content': about the document's data (totals, mandatory fields) - resending the same bytes repeats
 *   the same verdict, so the document HOLDS for a real correction.
 * 'technical': a processing failure - Amazon's prescribed retry of the SAME document is safe.
 * 'unknown': anything else, including an empty reason. Also HOLDS: guessing here sends money
 *   documents, so an unclear reason goes to a human, never to an automatic retry. */
export const classifyRejection = (reason) => {
  const r = String(reason ?? '');
  if (/totalamount|totalvatamount|mismatch|does not match|missing|mandatory|invalid/i.test(r)) return 'content';
  if (/internal|timeout|timed out|throttl|temporarily|unavailable|try again|rate limit|processing error|502|503|504/i.test(r)) return 'technical';
  return 'unknown';
};

/** Queue (or re-open) a human-reviewed retry when Amazon rejects an uploaded document.
 * Repeat rejections of the same document re-open the review: the document lifecycle
 * reject -> retry -> reject again must surface a fresh proposal every time. */
export function proposeRejectedRetry(db, seller, { eventKey, kind, number, originalNumber, shipmentKey, rectNumber = null, action, retryAction = 'retry_upload', reason, rawReason, now = new Date() }) {
  ensureRepairTables(db);
  // EVERY rejection path goes through the classifier unless the caller proved the document never
  // reached Amazon (feed FATAL/CANCELLED) and passes an explicit action. retryAction picks the retry
  // mechanics for the document type; the classifier alone decides hold vs retry.
  const cls = classifyRejection(rawReason ?? reason);
  const act = action ?? (cls === 'technical' ? retryAction : 'hold');
  const text = act === 'hold'
    ? reason + (cls === 'content'
      ? ' Amazon rejected the CONTENT of this document, so re-uploading it unchanged would likely repeat the rejection - the data needs a real correction first. Nothing was re-uploaded.'
      : " Amazon's rejection reason is unclear, so this is held for a human to read in Seller Central instead of guessing. Nothing was re-uploaded.")
    : reason;
  const sug = JSON.stringify({ action: act, number });
  const prev = db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, eventKey);
  if (prev && ['proposed', 'issuing'].includes(prev.state)) return false; // already awaiting review or in flight
  if (prev) {
    db.prepare("UPDATE repairs SET state='proposed', reason=?, suggestion=?, created_at=? WHERE seller_id=? AND event_key=?").run(text, sug, now.toISOString(), seller.id, eventKey);
  } else {
    db.prepare(`INSERT INTO repairs (seller_id, event_key, kind, original_number, shipment_key, reason, suggestion, state, created_at, rect_number)
      VALUES (?,?,?,?,?,?,?, 'proposed', ?, ?)`).run(seller.id, eventKey, kind, originalNumber ?? number, shipmentKey, text, sug, now.toISOString(), rectNumber);
  }
  logEvent(db, seller.id, 'repair_proposed', { key: eventKey, original: number, reason: text });
  return true;
}

/** Close open retry/unknown repairs for a document once Amazon's verdict is in. */
export function closeRepairsFor(db, sellerId, eventKeys, state = 'uploaded') {
  ensureRepairTables(db);
  for (const k of eventKeys)
    db.prepare("UPDATE repairs SET state=? WHERE seller_id=? AND event_key=? AND state IN ('proposed','issued','issuing','exported','rejected','held')").run(state, sellerId, k);
}

/** Boot recovery for repairs stranded in 'issuing' by a crash. Reads the DOCUMENT's actual state
 * instead of blindly reverting: a document that already left pending means the work landed, so the
 * repair is closed as issued; missing/pending/rejected means it is safe to review again. */
export function recoverStuckRepairs(db) {
  ensureRepairTables(db);
  const stuck = db.prepare("SELECT * FROM repairs WHERE state='issuing'").all();
  for (const r of stuck) {
    const sug = JSON.parse(r.suggestion);
    let docStatus = null, next;
    // Only a document that provably went out closes the repair. 'rejected', 'unknown' and missing
    // all come BACK to the review queue: a hold repair closed on an 'unknown' document would vanish
    // from review, and a 'rejected' document still needs its retry decision.
    const GONE_OUT = ['submitted', 'processing', 'uploaded', 'ready'];
    // A retry repair recovered on an 'unknown' document is HELD, not re-proposed: approving it could
    // only fail on the unknown-outcome guard (the UNKNOWN hold carries the review). The UNKNOWN hold
    // repair itself (action 'hold') does come back to 'proposed' - it IS the visible review item.
    if (['retry_upload', 'retry_rect', 'hold'].includes(sug.action)) {
      docStatus = db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(r.seller_id, sug.number)?.upload_status ?? null;
      next = GONE_OUT.includes(docStatus) ? 'issued' : (docStatus === 'unknown' && sug.action !== 'hold' ? 'held' : 'proposed');
    } else {
      docStatus = db.prepare("SELECT upload_status FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa'").get(r.seller_id, r.event_key)?.upload_status ?? null;
      next = GONE_OUT.includes(docStatus) ? 'issued' : (docStatus === 'unknown' ? 'held' : 'proposed');
    }
    db.prepare("UPDATE repairs SET state=? WHERE seller_id=? AND event_key=? AND state='issuing'").run(next, r.seller_id, r.event_key);
    logEvent(db, r.seller_id, 'repair_recovered', { key: r.event_key, to: next, document: docStatus });
  }
  return stuck.length;
}

async function approveClaimed(db, seller, r, { api, validate } = {}) {
  const eventKey = r.event_key;
  const sug = JSON.parse(r.suggestion);
  // Amazon rejected the upload; its docs say to upload the same document again.
  if (sug.action === 'retry_upload') {
    const feedId = await retryRejectedUpload(db, seller, sug.number, { api });
    db.prepare("UPDATE repairs SET state='issued', rect_number=? WHERE seller_id=? AND event_key=?").run(sug.number, seller.id, eventKey);
    return { retried: sug.number, feedId };
  }
  // A content rejection is held for a real data correction; re-uploading is refused explicitly.
  if (sug.action === 'hold') throw new Error(`Nothing was re-uploaded. ${r.reason}`);
  // A rejected (or retry_rect) correction document is retried through issueRectificativa, which
  // re-uploads the SAME document (same number, same Amazon TransactionId).
  if (sug.action === 'retry_rect' || r.state === 'rejected') {
    if (!r.rect_number && !sug.number) throw new Error('This rejected repair has no issued document to retry.');
    const { rect } = await issueRectificativa(db, seller, r.original_number, { recordKey: r.event_key }, { api, validate });
    db.prepare("UPDATE repairs SET state='issued', rect_number=? WHERE seller_id=? AND event_key=?").run(rect.number, seller.id, eventKey);
    return { rectNumber: rect.number, original: r.original_number, retried: true };
  }
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
    // Zeroing the whole invoice is only valid when the refund matches it to the cent on BOTH gross
    // and tax; otherwise the credit note would carry amounts Amazon did not report. Hold, never guess.
    if (cents(sug.total) !== cents(orig.totals.incl) || cents(sug.vat) !== cents(orig.totals.vat))
      throw new Error('This is recorded as a full cancellation but the refund does not match the invoice to the cent on tax, so zeroing the invoice would issue wrong amounts. ' + MANUAL_FIX);
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
  const prev = db.prepare('SELECT kind, suggestion FROM repairs WHERE seller_id=? AND event_key=?').get(sellerId, eventKey);
  const r = db.prepare("UPDATE repairs SET state=? WHERE seller_id=? AND event_key=? AND state='proposed'").run(decision, sellerId, eventKey);
  if (!r.changes) throw new Error(`No proposed repair ${eventKey}`);
  if (decision === 'dismissed' && prev?.kind === 'unknown_outcome') {
    // Human resolution of the feed-list orphan hold: the human checked Amazon, and unknownSettleCheck
    // treats a dismissal newer than the attempt time as clearing the cross-check, so the next sync
    // resends the same document if a fresh report still lists it as due.
    let number = null;
    try { number = JSON.parse(prev.suggestion).number ?? null; } catch { /* keep null */ }
    logEvent(db, sellerId, 'unknown_hold_dismissed', { key: eventKey, number });
  }
}
