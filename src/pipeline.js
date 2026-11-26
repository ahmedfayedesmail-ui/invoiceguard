import { parseVidr, needsInvoice } from './vidr.js';
import { validateVat } from './vies.js';
import { buildInvoice, buildRectificativa } from './invoice.js';
import { verifyBuyer, hasOverride } from './verify.js';
import { buyerCountryCheck } from './features.js';
import { gate, gateReason, missingFields, correctionWindowOk, readiness } from './rules.js';
import { renderPdf } from './pdf.js';
import { logEvent, appendAudit } from './db.js';
import { marketplaceFor } from './spapi.js';
import { proposeRejectedRetry, closeRepairsFor } from './repair.js';

// Amazon's own VCS upload SLA is stated in hours ("To meet the SLA of 24 hours ..."),
// https://developer-docs.amazon.com/sp-api/docs/create-and-upload-invoices - while Seller Central's
// defect-rate help phrases it as one business day. 24h is the stricter reading in both directions
// (it never tells you you're on time when Amazon would call you late), so the countdown uses it.
const DUE_HOURS = 24;

export const explain = (m) => /FeatureNotAvailable|79509|closed beta/i.test(m) ? 'Amazon has not enabled invoice upload for this account. In Seller Central set VAT Calculation Service to "I will upload my own VAT invoices".' : /Tax Invoicing|Unauthorized|403/i.test(m) ? 'The app lacks the Tax Invoicing role. Amazon must approve it for this seller.' : m;

export function upsertShipment(db, sellerId, s, status, reason = null) {
  const due = s.shipmentDate ? new Date(new Date(s.shipmentDate).getTime() + DUE_HOURS * 3600e3).toISOString() : null;
  db.prepare(`INSERT INTO shipments (seller_id,key,order_id,shipping_id,buyer_vat,buyer,country,total,vat,shipment_date,due_at,status,reason,raw,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(seller_id,key) DO UPDATE SET status=excluded.status, reason=excluded.reason, raw=excluded.raw, updated_at=excluded.updated_at`)
    .run(sellerId, s.key, s.orderId, s.shippingId, s.buyerVat, s.buyerCompany, s.shipCountry, s.incl, s.vat, s.shipmentDate, due, status, reason, JSON.stringify(s), new Date().toISOString());
}

/** One pass over a VIDR report text. Pure with respect to Amazon: upload goes through the `api` object. */
export async function processReport(db, seller, reportText, { api, validate = validateVat, now = new Date(), dryRun = false, census = null, shipments = null } = {}) {
  const out = { detected: 0, uploaded: 0, held: [], deferred: [], skipped: 0, errors: [] };
  const list = shipments ?? parseVidr(reportText);
  // Friction fix: without this, N shipments meant N SEQUENTIAL VIES round-trips (the loop awaits each
  // check), so a big report could outlive the request timeout. Pre-warm the unique buyer VATs in
  // parallel; the cached validator caps real parallelism and serves the loop below instantly.
  const vats = [...new Set(list.filter(needsInvoice).map(s => s.buyerVat).filter(Boolean))];
  await Promise.allSettled(vats.map(v => validate(v)));
  for (const s of list) {
    // Terminal invoice statuses in an all-status VIDR are Amazon's verdict on documents we sent:
    // reconcile them BEFORE the needsInvoice filter (InvoiceUploaded rows do not need an invoice).
    if (['InvoiceUploaded', 'InvoiceRejected', 'InvoiceProcessing'].includes(s.invoiceStatus || '')) { reconcileInvoice(db, seller, s); out.skipped++; continue; }
    if (/^CreditNote(Uploaded|Rejected|Processing)$/.test(s.invoiceStatus || '')) { reconcileCreditNote(db, seller, s); out.skipped++; continue; }
    if (!needsInvoice(s)) { out.skipped++; continue; }
    out.detected++;
    const existing = db.prepare('SELECT status FROM shipments WHERE seller_id=? AND key=?').get(seller.id, s.key);
    if (existing && ['submitted', 'processing', 'uploaded', 'ready'].includes(existing.status)) { out.skipped++; continue; }
    if (!existing) logEvent(db, seller.id, 'detected', { key: s.key, orderId: s.orderId }); // evidence trail starts here
    if (s.buyerVat && hasOverride(db, seller.id, s.key, 'b2c')) { s.buyerVat = null; s.buyerCompany = s.billing?.name || ''; }
    if (s.buyerVat) {
      const v = await validate(s.buyerVat); s.__vies = v;
      db.prepare('INSERT INTO vat_checks VALUES (?,?,?,?,?)').run(seller.id, v.vat, v.status, v.name ?? null, new Date().toISOString());
      if (v.status === 'invalid') { upsertShipment(db, seller.id, s, 'held', `buyer VAT invalid (${v.reason})`); logEvent(db, seller.id, 'held', { key: s.key, reason: v.reason }); out.held.push({ key: s.key, orderId: s.orderId, reason: v.reason }); continue; }
      if (v.status === 'unavailable') { upsertShipment(db, seller.id, s, 'detected', 'VIES unavailable, will retry'); out.deferred.push({ key: s.key, reason: v.reason }); continue; }
      const chk = await verifyBuyer(db, seller, s, v, { census });
      if (chk.hold) { const reason = chk.hold.reason + (chk.hold.overridable ? '. Release it if you have checked the data yourself.' : ''); upsertShipment(db, seller.id, s, 'held', reason); logEvent(db, seller.id, 'held', { key: s.key, reason, check: chk.hold.id }); out.held.push({ key: s.key, orderId: s.orderId, reason }); continue; }
      if (chk.defer) { upsertShipment(db, seller.id, s, 'detected', chk.defer); out.deferred.push({ key: s.key, reason: chk.defer }); continue; }
      logEvent(db, seller.id, 'buyer_verified', { key: s.key, checks: chk.notes });
    }
    // Country rule pack: gate rules hold new documents when they are unverified, overdue or drifted; required fields are checked on a preview so no number is burned.
    if (!db.prepare("SELECT 1 FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice'").get(seller.id, s.key)) {
      const country = seller.country ?? 'ES', rd = readiness(country, 'issue'), g = rd.ok ? gate(db, country, 'issue', now) : { ok: false, holds: [] };
      if (!rd.ok) { upsertShipment(db, seller.id, s, 'held', rd.reason); logEvent(db, seller.id, 'held', { key: s.key, reason: rd.reason }); out.held.push({ key: s.key, orderId: s.orderId, reason: rd.reason }); continue; }
      if (!g.ok) { const reason = gateReason(g); upsertShipment(db, seller.id, s, 'held', reason); logEvent(db, seller.id, 'held', { key: s.key, reason, rules: g.holds.map(h => h.id) }); out.held.push({ key: s.key, orderId: s.orderId, reason }); continue; }
      const miss = missingFields(buildInvoice(db, seller, s, { date: now, number: 'PREVIEW' }), country);
      if (miss.length) { const reason = `Invoice would miss required fields: ${miss.join(', ')}`; upsertShipment(db, seller.id, s, 'held', reason); logEvent(db, seller.id, 'held', { key: s.key, reason }); out.held.push({ key: s.key, orderId: s.orderId, reason }); continue; }
    }
    // The upload target is the store the order was placed on (the report's marketplace column).
    // Unknown code: hold BEFORE issuing. Never fall back to the buyer's address country - that is a different store.
    // (Manual accounts upload their pack themselves, so no target is needed.)
    let mp = null;
    if (!api.manual) {
      mp = marketplaceFor(s.marketplace);
      if (!mp) { const reason = `The report's store code "${s.marketplace || 'none'}" is not one we can map to an Amazon marketplace, so the upload target was not guessed.`; upsertShipment(db, seller.id, s, 'held', reason); logEvent(db, seller.id, 'held', { key: s.key, reason }); out.held.push({ key: s.key, orderId: s.orderId, reason }); continue; }
    }
    // Issue once, upload separately: a failed upload must never burn an invoice number or create a second invoice for the same shipment.
    let row = db.prepare("SELECT number, json FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice' ORDER BY issued_at DESC LIMIT 1").get(seller.id, s.key), inv;
    if (row) inv = JSON.parse(row.json);
    else {
      inv = buildInvoice(db, seller, s, { date: now });
      db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(seller.id, inv.number, s.key, 'invoice', now.toISOString(), inv.totals.incl, inv.totals.vat, JSON.stringify(inv), null, 'pending'); appendAudit(db, seller.id, 'invoice', inv.number, inv);
    }
    const bc = buyerCountryCheck(inv, seller.country ?? 'ES').filter(w => w.level !== 'info'); if (bc.length) logEvent(db, seller.id, 'buyer_country_warning', { number: inv.number, warnings: bc });
    const pdf = await renderPdf(inv);
    if (dryRun) { out.uploaded++; continue; }
    if (api.manual) { // manual path: the seller uploads the PDF to Amazon themselves
      db.prepare("UPDATE invoices SET upload_status='ready' WHERE seller_id=? AND number=?").run(seller.id, inv.number); upsertShipment(db, seller.id, s, 'ready'); logEvent(db, seller.id, 'issued_manual', { number: inv.number }); out.uploaded++; continue;
    }
    try {
      const feedId = await api.uploadInvoice({ marketplaceId: mp, pdf, orderId: s.orderId, shippingId: s.shippingId, number: inv.number, total: inv.totals.incl, vat: inv.totals.vat });
      db.prepare("UPDATE invoices SET feed_id=?, upload_status='submitted' WHERE seller_id=? AND number=?").run(feedId, seller.id, inv.number);
      upsertShipment(db, seller.id, s, 'submitted'); logEvent(db, seller.id, 'submitted', { number: inv.number, feedId }); out.uploaded++;
    } catch (e) {
      if (e.unknownOutcome) {
        // The feed may or may not have reached Amazon (network drop / 5xx after submission).
        // Blindly resending could double-submit the document, so it is NOT resent here: the next
        // VAT report is the reconciliation. If that report still shows the shipment pending, Amazon
        // provably has nothing and the normal upload path below resubmits; if it shows a verdict,
        // reconcileInvoice closes this out. What we cannot guarantee: a feed Amazon received but
        // never reflects in the report - that residue is surfaced to a human, never auto-resent.
        db.prepare("UPDATE invoices SET upload_status='unknown' WHERE seller_id=? AND number=?").run(seller.id, inv.number);
        upsertShipment(db, seller.id, s, 'unknown', 'the upload outcome is unknown - Amazon may have received the document');
        logEvent(db, seller.id, 'upload_unknown_outcome', { number: inv.number, error: e.message });
        proposeRejectedRetry(db, seller, { eventKey: `UNKNOWN:${s.key}`, kind: 'unknown_outcome', number: inv.number, shipmentKey: s.key, action: 'hold',
          reason: `The upload of invoice ${inv.number} was interrupted after Amazon may already have received it. It was NOT resent automatically, to avoid a double submission. The next Amazon report will confirm whether Amazon has it; if the shipment stays pending there, the next sync resubmits it safely.` });
      } else {
        db.prepare("UPDATE invoices SET upload_status='pending' WHERE seller_id=? AND number=?").run(seller.id, inv.number); upsertShipment(db, seller.id, s, 'error', explain(e.message));
      }
      out.errors.push({ key: s.key, error: e.message });
    }
  }
  return out;
}

/** Reconcile Amazon's verdict on an uploaded invoice (from the VIDR invoice-status column). */
function reconcileInvoice(db, seller, s) {
  const key = `SHIPMENT:${s.shippingId}`;
  // A Correction:: transaction's verdict belongs to the REPLACEMENT document (a rectificativa keyed
  // by the correction event), not to the original invoice. Billing-correction documents are under
  // the same reject/retry umbrella as every other document.
  const rect = s.isCorrectedTx ? db.prepare("SELECT number, upload_status, rectifies FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa' ORDER BY issued_at DESC LIMIT 1").get(seller.id, s.key) : null;
  const inv = rect ?? db.prepare("SELECT number, upload_status, rectifies FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice' ORDER BY issued_at DESC LIMIT 1").get(seller.id, key);
  if (!inv) return;
  const docKey = rect ? s.key : key;
  if (s.invoiceStatus === 'InvoiceUploaded' && inv.upload_status !== 'uploaded') {
    db.prepare("UPDATE invoices SET upload_status='uploaded', uploaded_at=? WHERE seller_id=? AND number=?").run(new Date().toISOString(), seller.id, inv.number);
    db.prepare("UPDATE shipments SET status='uploaded' WHERE seller_id=? AND key=?").run(seller.id, key);
    logEvent(db, seller.id, 'confirmed_uploaded', { number: inv.number });
    // Acceptance closes the document's retry/unknown repairs - the lifecycle ends visibly.
    closeRepairsFor(db, seller.id, [`REJECTED:${docKey}`, `UNKNOWN:${docKey}`, docKey], 'uploaded');
  } else if (s.invoiceStatus === 'InvoiceRejected' && inv.upload_status !== 'rejected') {
    const reason = s.invoiceStatusDesc || 'Amazon rejected the invoice while processing it';
    db.prepare("UPDATE invoices SET upload_status='rejected' WHERE seller_id=? AND number=?").run(seller.id, inv.number);
    db.prepare("UPDATE shipments SET status='rejected', reason=? WHERE seller_id=? AND key=?").run(reason, seller.id, key);
    logEvent(db, seller.id, 'confirmed_rejected', { number: inv.number, reason });
    closeRepairsFor(db, seller.id, [`UNKNOWN:${docKey}`], 'rejected');
    // Amazon's doc: "Seller must upload the invoice for this shipment again." Surface a reviewed
    // retry in the Repairs queue - the SAME document goes up again, never a new number. Repeat
    // rejections re-open the review (a fixed key with INSERT OR IGNORE would swallow them).
    // Correction documents retry through issueRectificativa's record-key path (action retry_rect,
    // event key = the correction event key); plain invoices re-upload the same document directly.
    if (rect) proposeRejectedRetry(db, seller, { eventKey: s.key, kind: 'rejected_correction_invoice', number: inv.number, originalNumber: inv.rectifies, shipmentKey: s.key, rectNumber: inv.number, action: 'retry_rect',
      reason: `Amazon rejected the replacement document ${inv.number}: ${reason}. Amazon expects the document for this transaction to be uploaded again - check the reason, then approve to re-upload the same document.` });
    else proposeRejectedRetry(db, seller, { eventKey: `REJECTED:${docKey}`, kind: 'rejected_invoice', number: inv.number, originalNumber: inv.number, shipmentKey: docKey,
      reason: `Amazon rejected invoice ${inv.number}: ${reason}. Amazon expects the invoice for this shipment to be uploaded again - check the reason, then approve to re-upload the same document.` });
  } else if (s.invoiceStatus === 'InvoiceProcessing' && inv.upload_status === 'submitted') {
    db.prepare("UPDATE invoices SET upload_status='processing' WHERE seller_id=? AND number=?").run(seller.id, inv.number);
    db.prepare("UPDATE shipments SET status='processing' WHERE seller_id=? AND key=? AND status='submitted'").run(seller.id, key);
  }
}

/** Reconcile Amazon's verdict on an uploaded credit note (CreditNote* statuses on the refund row). */
function reconcileCreditNote(db, seller, s) {
  const rect = db.prepare("SELECT number, upload_status, rectifies FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa' ORDER BY issued_at DESC LIMIT 1").get(seller.id, s.key);
  if (!rect) return;
  const hasRepairs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='repairs'").get();
  if (s.invoiceStatus === 'CreditNoteUploaded' && rect.upload_status !== 'uploaded') {
    db.prepare("UPDATE invoices SET upload_status='uploaded', uploaded_at=? WHERE seller_id=? AND number=?").run(new Date().toISOString(), seller.id, rect.number);
    if (hasRepairs) db.prepare("UPDATE repairs SET state='uploaded' WHERE seller_id=? AND rect_number=? AND state IN ('issued','exported','proposed','issuing','rejected')").run(seller.id, rect.number);
    logEvent(db, seller.id, 'confirmed_uploaded', { number: rect.number });
  } else if (s.invoiceStatus === 'CreditNoteRejected' && rect.upload_status !== 'rejected') {
    db.prepare("UPDATE invoices SET upload_status='rejected' WHERE seller_id=? AND number=?").run(seller.id, rect.number);
    logEvent(db, seller.id, 'confirmed_rejected', { number: rect.number, reason: s.invoiceStatusDesc || null });
    // Every rejected credit note gets a reviewed retry - including Amazon billing-correction credit
    // notes, which have no repair row of their own yet. Repeat rejections re-open the review.
    proposeRejectedRetry(db, seller, { eventKey: s.key, kind: 'rejected_credit_note', number: rect.number, originalNumber: rect.rectifies, shipmentKey: s.key, rectNumber: rect.number, action: 'retry_rect',
      reason: `Amazon rejected credit note ${rect.number}: ${s.invoiceStatusDesc || 'no reason given'}. Amazon expects the same credit note to be uploaded again - check the reason, then approve to retry.` });
  }
}

/**
 * Poll processing feeds. A feed reaching DONE is NOT proof Amazon accepted the document - the
 * verdict per shipment is the invoice-status column of the next VAT invoice data report
 * (InvoiceUploaded vs InvoiceRejected, per the create-and-upload-invoices doc). DONE moves a feed
 * to 'processing' and stores Amazon's processing report as evidence; reconciliation happens in
 * processReport. Only FATAL/CANCELLED (the feed never ran) mark a rejection directly.
 */
export async function pollFeeds(db, seller, api) {
  const res = { processing: 0, rejected: 0, pending: 0 };
  for (const r of db.prepare("SELECT number, feed_id, shipment_key FROM invoices WHERE seller_id=? AND upload_status IN ('submitted','processing')").all(seller.id)) {
    const f = await api.feedStatus(r.feed_id);
    if (f.status === 'DONE') {
      if (f.resultDocumentId && api.downloadFeedResult) {
        try { const rep = await api.downloadFeedResult(f.resultDocumentId); logEvent(db, seller.id, 'feed_result', { number: r.number, feedId: r.feed_id, report: String(rep).slice(0, 4000) }); }
        catch (e) { logEvent(db, seller.id, 'feed_result_error', { number: r.number, feedId: r.feed_id, error: e.message }); }
      }
      db.prepare("UPDATE invoices SET upload_status='processing' WHERE seller_id=? AND number=?").run(seller.id, r.number);
      db.prepare("UPDATE shipments SET status='processing' WHERE seller_id=? AND key=? AND status='submitted'").run(seller.id, r.shipment_key);
      res.processing++;
    }
    else if (['FATAL', 'CANCELLED'].includes(f.status)) { db.prepare("UPDATE invoices SET upload_status='rejected' WHERE seller_id=? AND number=?").run(seller.id, r.number); db.prepare("UPDATE shipments SET status='rejected' WHERE seller_id=? AND key=?").run(seller.id, r.shipment_key); logEvent(db, seller.id, 'confirmed_rejected', { number: r.number, reason: 'feed ' + f.status });
      proposeRejectedRetry(db, seller, { eventKey: `REJECTED:${r.shipment_key}`, kind: 'rejected_invoice', number: r.number, shipmentKey: r.shipment_key,
        reason: `Amazon never processed invoice ${r.number} (feed ${f.status}). The same document can be uploaded again - approve to retry.` }); res.rejected++; }
    else res.pending++;
  }
  return res;
}

/** Issue a rectificativa for an existing invoice and upload it. */
export async function issueRectificativa(db, seller, originalNumber, opts, { api, validate = validateVat } = {}) {
  const row = db.prepare('SELECT json, shipment_key FROM invoices WHERE seller_id=? AND number=?').get(seller.id, originalNumber);
  if (!row) throw new Error(`Invoice ${originalNumber} not found`);
  const original = JSON.parse(row.json);
  // Idempotency on the event key: one Amazon correction event yields exactly one correction document.
  // A pending row means the upload failed after issuance - retry the SAME document's upload, never mint
  // a second number. Any other state means the event is already handled - issuing again would duplicate
  // a financial document.
  if (opts.recordKey) {
    const prev = db.prepare("SELECT number, upload_status, json, tx_id FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa' ORDER BY issued_at DESC LIMIT 1").get(seller.id, opts.recordKey);
    // 'rejected' joins 'pending' here: Amazon's prescribed retry for a rejected credit note is the
    // SAME document uploaded again ("Seller must upload the Credit Note for this transaction again").
    // 'pending' and 'rejected' retry the same document; 'unknown' (Amazon may hold it) only retries
    // when a FRESH report still lists the event as needing the document - Amazon's own statement of
    // absence - which is exactly the situation processCorrections/detectRepairs are driven by.
    if (prev && ['pending', 'rejected', 'unknown'].includes(prev.upload_status)) {
      const rect = JSON.parse(prev.json);
      const s0 = JSON.parse(db.prepare('SELECT raw FROM shipments WHERE seller_id=? AND key=?').get(seller.id, row.shipment_key).raw);
      const mp0 = marketplaceFor(s0.marketplace);
      if (!mp0) throw new Error(`The original shipment's store code "${s0.marketplace || 'none'}" cannot be mapped to an Amazon marketplace, so the pending correction ${prev.number} could not be retried.`);
      const pdf0 = await renderPdf(rect);
      const documentType0 = rect.totals.incl < 0 ? 'CreditNote' : 'Invoice';
      const feedId0 = await api.uploadInvoice({ marketplaceId: mp0, pdf: pdf0, orderId: s0.orderId, shippingId: s0.shippingId, number: rect.number, total: Math.abs(rect.totals.incl), vat: Math.abs(rect.totals.vat), documentType: documentType0, transactionId: prev.tx_id ?? s0.transactionId });
      db.prepare("UPDATE invoices SET feed_id=?, upload_status='submitted' WHERE seller_id=? AND number=?").run(feedId0, seller.id, prev.number);
      logEvent(db, seller.id, 'rectificativa_upload_retried', { number: prev.number });
      return { rect, feedId: feedId0, documentType: documentType0, pdf: pdf0, retried: true };
    }
    if (prev) throw new Error(`A correction (${prev.number}, ${prev.upload_status}) already exists for this event. No second document was issued.`);
  }
  const country = seller.country ?? 'ES', rd = readiness(country, 'correct'); if (!rd.ok) throw new Error(rd.reason);
  if (!rd.methods.includes(opts.mode)) throw new Error(`The ${country} pack does not support the "${opts.mode}" method (${rd.rule}). Ask your adviser.`);
  if (opts.changes?.lines && !rd.amountChanges) throw new Error(`The ${country} pack (${rd.rule}) does not cover amount or tax changes. Ask your adviser; nothing was issued.`);
  const g = gate(db, country, 'correct', opts.now ?? new Date()); if (!g.ok) throw new Error(gateReason(g));
  const win = correctionWindowOk(original.operationDate ?? original.issueDate, country, opts.now ?? new Date()); if (!win.ok) throw new Error(`The ${country} rule pack (${win.rule}) allows corrections only until ${win.limit}. This invoice is outside that window.`);
  if (opts.changes?.buyer?.vat && opts.changes.buyer.vat !== original.buyer.vat) {
    const v = await validate(opts.changes.buyer.vat);
    if (v.status !== 'valid') throw new Error(`Corrected buyer VAT is not valid in VIES (${v.status}: ${v.reason})`);
  }
  const rect = buildRectificativa(db, seller, original, opts);
  if (rect.warnings.length) throw new Error(rect.warnings[0]);
  const pdf = await renderPdf(rect);
  // Data-only corrections replace the invoice (latest invoice for the shipment is the valid one). Amount reductions go as a credit note.
  const documentType = opts.documentType ?? (rect.totals.incl < 0 ? 'CreditNote' : 'Invoice');
  const s = JSON.parse(db.prepare('SELECT raw FROM shipments WHERE seller_id=? AND key=?').get(seller.id, row.shipment_key).raw);
  // Manual product: nothing leaves the system - the correction waits in Ready to upload and travels in the pack.
  // Before this, manual corrections were inserted as 'submitted' and fell into limbo (never in the pack, never markable).
  const manual = !!api.manual;
  const mp = marketplaceFor(s.marketplace);
  if (!manual && !mp) throw new Error(`The original shipment's store code "${s.marketplace || 'none'}" cannot be mapped to an Amazon marketplace, so the upload target was not guessed. The correction was not issued.`);
  // Local record FIRST, upload second: Amazon must never hold a document we have no record of, and the
  // R series stays gapless even when the upload fails (the issued correction waits as 'pending').
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status,tx_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, rect.number, opts.recordKey ?? row.shipment_key, 'rectificativa', originalNumber, new Date().toISOString(), rect.totals.incl, rect.totals.vat, JSON.stringify(rect), null, manual ? 'ready' : 'pending', opts.transactionId ?? null);
  appendAudit(db, seller.id, 'rectificativa', rect.number, rect);
  logEvent(db, seller.id, 'rectificativa', { number: rect.number, rectifies: originalNumber });
  let feedId = null;
  if (!manual) {
    try {
      feedId = await api.uploadInvoice({ marketplaceId: mp, pdf, orderId: s.orderId, shippingId: s.shippingId, number: rect.number, total: Math.abs(rect.totals.incl), vat: Math.abs(rect.totals.vat), documentType, transactionId: opts.transactionId ?? s.transactionId });
      db.prepare("UPDATE invoices SET feed_id=?, upload_status='submitted' WHERE seller_id=? AND number=?").run(feedId, seller.id, rect.number);
    } catch (e) {
      // Unknown outcome: Amazon may hold the document. Mark it honestly; no blind resend - a fresh
      // report that still asks for the document is the only retry trigger (see the record-key branch).
      if (e.unknownOutcome) { db.prepare("UPDATE invoices SET upload_status='unknown' WHERE seller_id=? AND number=?").run(seller.id, rect.number); logEvent(db, seller.id, 'upload_unknown_outcome', { number: rect.number, error: e.message }); }
      else logEvent(db, seller.id, 'upload_error', { number: rect.number, error: explain(e.message) });
      throw e;
    }
  }
  return { rect, feedId, documentType, pdf };
}

/**
 * Amazon billing-data corrections (customer asked Amazon to change billing name/address). Amazon docs: the VIDR then lists
 * a REFUND "CorrectionReversal:..." (seller must upload a credit note) and a SHIPMENT "Correction::..." (seller must upload a new invoice),
 * both with their transaction IDs. Amounts are unchanged. We issue both as rectificativas, automatically.
 */
export async function processCorrections(db, seller, reportText, { api, validate }) {
  const out = { creditNotes: 0, invoices: 0, skipped: [], errors: [] };
  const list = parseVidr(reportText).filter(s => s.isCorrectionReversal || s.isCorrectedTx);
  // Only a row whose upload actually left the pending state counts as done: a pending row is an issued
  // correction whose upload failed, and issueRectificativa retries that same document (never a second one).
  const done = (key) => { const r = db.prepare("SELECT upload_status FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa'").get(seller.id, key); return r && r.upload_status !== 'pending'; };
  const original = (s) => db.prepare("SELECT number, json FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='invoice' ORDER BY issued_at DESC LIMIT 1").get(seller.id, `SHIPMENT:${s.shippingId}`);
  const reasonOf = (s) => s.correctionDetails || 'Billing name or address corrected at the buyer\'s request via Amazon';
  const zeroTotal = (orig) => Math.abs(JSON.parse(orig.json).totals?.incl ?? 0) < 0.005;
  // Pass 1: reversals (credit notes) first. Pass 2: replacements, only when their reversal
  // landed (or the original was zero-amount, where there is nothing to reverse) - a half pair
  // would leave Amazon's books inconsistent.
  for (const s of list.filter(s => s.isCorrectionReversal)) {
    if (done(s.key)) continue;
    const orig = original(s); if (!orig) { out.skipped.push({ key: s.key, reason: 'original invoice not issued by us' }); continue; }
    if (zeroTotal(orig)) { out.skipped.push({ key: s.key, reason: 'zero-amount original: nothing to reverse' }); continue; }
    try {
      const o = JSON.parse(orig.json), zero = o.lines.map(l => ({ ...l, excl: 0, vat: 0 }));
      await issueRectificativa(db, seller, orig.number, { mode: 'differences', reason: reasonOf(s), changes: { lines: zero }, documentType: 'CreditNote', transactionId: s.transactionId, recordKey: s.key }, { api, validate }); out.creditNotes++;
    } catch (e) { out.errors.push({ key: s.key, error: explain(e.message) }); }
  }
  for (const s of list.filter(s => s.isCorrectedTx)) {
    if (done(s.key)) continue;
    const orig = original(s); if (!orig) { out.skipped.push({ key: s.key, reason: 'original invoice not issued by us' }); continue; }
    const cn = db.prepare("SELECT 1 FROM invoices WHERE seller_id=? AND rectifies=? AND kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%'").get(seller.id, orig.number);
    if (!zeroTotal(orig) && !cn) { out.skipped.push({ key: s.key, reason: 'credit-note reversal not completed - pair kept together' }); continue; }
    try {
      await issueRectificativa(db, seller, orig.number, { mode: 'substitution', reason: reasonOf(s), changes: { buyer: { name: s.billing.name || s.buyerCompany, vat: s.buyerVat ?? undefined, address: [...s.billing.lines, `${s.billing.postal} ${s.billing.city}`.trim(), s.billing.country].filter(Boolean) } }, documentType: 'Invoice', transactionId: s.transactionId, recordKey: s.key }, { api, validate }); out.invoices++;
    } catch (e) { out.errors.push({ key: s.key, error: explain(e.message) }); }
  }
  return out;
}
