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
    if (existing && ['submitted', 'processing', 'uploaded', 'ready', 'sending'].includes(existing.status)) { out.skipped++; continue; }
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
    // Round-6: an 'unknown' document reaches this upload path only because the fresh report still
    // lists the shipment as due. Pending alone is NOT conclusive proof that Amazon holds nothing
    // (the doc gives no freshness guarantee for the report against feed acceptance), so cross-check
    // Amazon's own feed list for an orphan feed from the interruption window before any resend.
    const docState = db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number)?.upload_status;
    if (docState === 'unknown') {
      const block = await unknownSettleCheck(db, seller, api, inv.number);
      if (block) { upsertShipment(db, seller.id, s, 'unknown', block); logEvent(db, seller.id, 'unknown_resend_blocked', { number: inv.number, reason: block }); out.held.push({ key: s.key, orderId: s.orderId, reason: block }); continue; }
    }
    // Mark BEFORE the call: 'sending' records that the upload may have reached Amazon. A crash in
    // this window is recovered at boot by recoverUncertainUploads (marked 'unknown' + human hold),
    // never blindly resent.
    db.prepare("UPDATE invoices SET upload_status='sending' WHERE seller_id=? AND number=?").run(seller.id, inv.number);
    upsertShipment(db, seller.id, s, 'sending');
    try {
      const feedId = await api.uploadInvoice({ marketplaceId: mp, pdf, orderId: s.orderId, shippingId: s.shippingId, number: inv.number, total: inv.totals.incl, vat: inv.totals.vat });
      db.prepare("UPDATE invoices SET feed_id=?, upload_status='submitted' WHERE seller_id=? AND number=?").run(feedId, seller.id, inv.number);
      upsertShipment(db, seller.id, s, 'submitted'); logEvent(db, seller.id, 'submitted', { number: inv.number, feedId }); out.uploaded++;
    } catch (e) {
      if (e.unknownOutcome) {
        // The feed may or may not have reached Amazon (network drop / 5xx after submission).
        // Blindly resending could double-submit the document, so it is NOT resent here: the next
        // VAT report is the reconciliation. If that report still shows the shipment pending, that
        // is strong evidence Amazon holds nothing - and the resend path above cross-checks it
        // against Amazon's own feed list (unknownSettleCheck) before resubmitting. If the report
        // shows a verdict, reconcileInvoice closes this out. What we cannot guarantee: a feed
        // Amazon received that neither the report nor the feed list reflects - that residue is
        // surfaced to a human, never auto-resent and never claimed impossible.
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
    // Correction documents retry through issueRectificativa's record-key path (retryAction retry_rect,
    // event key = the correction event key); plain invoices re-upload the same document directly.
    // The classifier decides hold vs retry on Amazon's OWN reason string in every path.
    if (rect) proposeRejectedRetry(db, seller, { eventKey: s.key, kind: 'rejected_correction_invoice', number: inv.number, originalNumber: inv.rectifies, shipmentKey: s.key, rectNumber: inv.number, retryAction: 'retry_rect', rawReason: s.invoiceStatusDesc,
      reason: `Amazon rejected the replacement document ${inv.number}: ${reason}. Amazon expects the document for this transaction to be uploaded again - check the reason, then approve to re-upload the same document.` });
    else proposeRejectedRetry(db, seller, { eventKey: `REJECTED:${docKey}`, kind: 'rejected_invoice', number: inv.number, originalNumber: inv.number, shipmentKey: docKey, rawReason: s.invoiceStatusDesc,
      reason: `Amazon rejected invoice ${inv.number}: ${reason}. Amazon expects the invoice for this shipment to be uploaded again - check the reason, then approve to re-upload the same document.` });
  } else if (s.invoiceStatus === 'InvoiceProcessing' && ['submitted', 'unknown'].includes(inv.upload_status)) {
    // Amazon processing a document we were unsure about settles the unknown: it provably has it.
    if (inv.upload_status === 'unknown') closeRepairsFor(db, seller.id, [`UNKNOWN:${docKey}`], 'issued');
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
    if (hasRepairs) db.prepare("UPDATE repairs SET state='uploaded' WHERE seller_id=? AND rect_number=? AND state IN ('issued','exported','proposed','issuing','rejected','held')").run(seller.id, rect.number);
    closeRepairsFor(db, seller.id, [`UNKNOWN:${s.key}`, s.key], 'uploaded');
    logEvent(db, seller.id, 'confirmed_uploaded', { number: rect.number });
  } else if (s.invoiceStatus === 'CreditNoteProcessing' && !['processing', 'uploaded'].includes(rect.upload_status)) {
    // Amazon's own statement that it HOLDS the credit note and is processing it (the doc: no seller
    // action is needed then). This settles a local 'unknown': the document provably arrived, so any
    // resend is forbidden - processCorrections' done() now counts it complete and skips it.
    if (rect.upload_status === 'unknown') closeRepairsFor(db, seller.id, [`UNKNOWN:${s.key}`], 'issued');
    db.prepare("UPDATE invoices SET upload_status='processing' WHERE seller_id=? AND number=?").run(seller.id, rect.number);
    logEvent(db, seller.id, 'credit_note_processing', { number: rect.number });
  } else if (s.invoiceStatus === 'CreditNoteRejected' && rect.upload_status !== 'rejected') {
    db.prepare("UPDATE invoices SET upload_status='rejected' WHERE seller_id=? AND number=?").run(seller.id, rect.number);
    logEvent(db, seller.id, 'confirmed_rejected', { number: rect.number, reason: s.invoiceStatusDesc || null });
    closeRepairsFor(db, seller.id, [`UNKNOWN:${s.key}`], 'rejected');
    // Every rejected credit note gets a reviewed retry - including Amazon billing-correction credit
    // notes, which have no repair row of their own yet. Repeat rejections re-open the review. The
    // classifier decides hold vs retry on Amazon's own reason string, here as everywhere.
    proposeRejectedRetry(db, seller, { eventKey: s.key, kind: 'rejected_credit_note', number: rect.number, originalNumber: rect.rectifies, shipmentKey: s.key, rectNumber: rect.number, retryAction: 'retry_rect', rawReason: s.invoiceStatusDesc,
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
  for (const r of db.prepare("SELECT number, feed_id, shipment_key, kind, rectifies FROM invoices WHERE seller_id=? AND upload_status IN ('submitted','processing')").all(seller.id)) {
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
      // FATAL/CANCELLED means the feed NEVER ran: Amazon provably does not hold the document, so a
      // same-document retry is safe without classification. Correction documents retry through the
      // record-key path - their shipment key is the correction event, which has no shipments row, so
      // the plain retry path could never resolve them.
      if (r.kind === 'rectificativa') proposeRejectedRetry(db, seller, { eventKey: r.shipment_key, kind: 'rejected_correction_document', number: r.number, originalNumber: r.rectifies, shipmentKey: r.shipment_key, rectNumber: r.number, action: 'retry_rect',
        reason: `Amazon never processed correction document ${r.number} (feed ${f.status}). The same document can be uploaded again - approve to retry.` });
      else proposeRejectedRetry(db, seller, { eventKey: `REJECTED:${r.shipment_key}`, kind: 'rejected_invoice', number: r.number, shipmentKey: r.shipment_key, action: 'retry_upload',
        reason: `Amazon never processed invoice ${r.number} (feed ${f.status}). The same document can be uploaded again - approve to retry.` });
      res.rejected++; }
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
    // 'pending' and 'rejected' retry the same document. 'unknown' (Amazon may hold it) is retried
    // ONLY with allowUnknownRetry - the fresh-report settling paths (processCorrections /
    // settleUnknownDocuments), where the report in hand is Amazon's own statement that the document
    // is still due. A bare human re-approval carries no such proof, so it is refused.
    if (prev && prev.upload_status === 'unknown' && !opts.allowUnknownRetry)
      throw new Error(`The upload outcome of ${prev.number} is unknown - Amazon may already hold it. It is NOT resent on approval alone; the next Amazon report settles it (still due there = the same document is resent automatically). Nothing was re-uploaded.`);
    if (prev && ['pending', 'rejected', 'unknown'].includes(prev.upload_status)) {
      const rect = JSON.parse(prev.json);
      const s0 = JSON.parse(db.prepare('SELECT raw FROM shipments WHERE seller_id=? AND key=?').get(seller.id, row.shipment_key).raw);
      const mp0 = marketplaceFor(s0.marketplace);
      if (!mp0) throw new Error(`The original shipment's store code "${s0.marketplace || 'none'}" cannot be mapped to an Amazon marketplace, so the pending correction ${prev.number} could not be retried.`);
      const pdf0 = await renderPdf(rect);
      const documentType0 = rect.totals.incl < 0 ? 'CreditNote' : 'Invoice';
      // Same discipline as a first upload: mark 'sending' BEFORE the call, so a crash between Amazon
      // accepting the retry and the local write is recovered at boot (recoverUncertainUploads ->
      // 'unknown' + human hold), never invisible. And an unknown outcome of the retry itself is
      // recorded as 'unknown' + hold - previously this branch saved nothing and a later retry would
      // have resent blindly.
      db.prepare("UPDATE invoices SET upload_status='sending' WHERE seller_id=? AND number=?").run(seller.id, prev.number);
      let feedId0;
      try {
        feedId0 = await api.uploadInvoice({ marketplaceId: mp0, pdf: pdf0, orderId: s0.orderId, shippingId: s0.shippingId, number: rect.number, total: Math.abs(rect.totals.incl), vat: Math.abs(rect.totals.vat), documentType: documentType0, transactionId: prev.tx_id ?? s0.transactionId });
      } catch (e) {
        if (e.unknownOutcome) {
          db.prepare("UPDATE invoices SET upload_status='unknown' WHERE seller_id=? AND number=?").run(seller.id, prev.number);
          logEvent(db, seller.id, 'upload_unknown_outcome', { number: prev.number, error: e.message });
          proposeRejectedRetry(db, seller, { eventKey: `UNKNOWN:${opts.recordKey}`, kind: 'unknown_outcome', number: prev.number, originalNumber, shipmentKey: opts.recordKey, rectNumber: prev.number, action: 'hold',
            reason: `The retry upload of correction document ${prev.number} was interrupted after Amazon may already have received it. It was NOT resent automatically, to avoid a double submission. The next Amazon report settles it: still due there, cross-checked against Amazon's own feed list, means the same document is resent; a verdict closes it.` });
        } else {
          // A DEFINITE refusal (Amazon never accepted): restore the prior state so the reviewed
          // retry stays available. Only an unknown outcome holds.
          db.prepare("UPDATE invoices SET upload_status=? WHERE seller_id=? AND number=?").run(prev.upload_status, seller.id, prev.number);
        }
        throw e;
      }
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
    // Mark BEFORE the call: 'sending' records that the upload may have reached Amazon. A crash in
    // this window is recovered at boot by recoverUncertainUploads, never blindly resent.
    db.prepare("UPDATE invoices SET upload_status='sending' WHERE seller_id=? AND number=?").run(seller.id, rect.number);
    try {
      feedId = await api.uploadInvoice({ marketplaceId: mp, pdf, orderId: s.orderId, shippingId: s.shippingId, number: rect.number, total: Math.abs(rect.totals.incl), vat: Math.abs(rect.totals.vat), documentType, transactionId: opts.transactionId ?? s.transactionId });
      db.prepare("UPDATE invoices SET feed_id=?, upload_status='submitted' WHERE seller_id=? AND number=?").run(feedId, seller.id, rect.number);
    } catch (e) {
      // Unknown outcome: Amazon may hold the document. Mark it honestly AND put a visible hold in the
      // Repairs queue - no blind resend; a fresh report that still asks for the document is the only
      // retry trigger (processCorrections / settleUnknownDocuments with allowUnknownRetry).
      if (e.unknownOutcome) {
        db.prepare("UPDATE invoices SET upload_status='unknown' WHERE seller_id=? AND number=?").run(seller.id, rect.number);
        logEvent(db, seller.id, 'upload_unknown_outcome', { number: rect.number, error: e.message });
        const docKey = opts.recordKey ?? row.shipment_key;
        proposeRejectedRetry(db, seller, { eventKey: `UNKNOWN:${docKey}`, kind: 'unknown_outcome', number: rect.number, originalNumber: originalNumber, shipmentKey: docKey, rectNumber: rect.number, action: 'hold',
          reason: `The upload of correction document ${rect.number} was interrupted after Amazon may already have received it. It was NOT resent automatically, to avoid a double submission. The next Amazon report settles it: still due there means the same document is resent automatically, a verdict closes it.` });
      }
      else { db.prepare("UPDATE invoices SET upload_status='pending' WHERE seller_id=? AND number=?").run(seller.id, rect.number); logEvent(db, seller.id, 'upload_error', { number: rect.number, error: explain(e.message) }); }
      throw e;
    }
  }
  return { rect, feedId, documentType, pdf };
}

/** Round-6 cross-check before ANY resend of an unknown-outcome document. A fresh report still
 * listing the document as due is strong evidence Amazon holds nothing - but NOT conclusive proof:
 * the create-and-upload-invoices doc defines the statuses without guaranteeing the report reflects
 * a feed that just entered processing. So the report is cross-checked against Amazon's OWN feed
 * list: a feed created in the interruption window whose id we never recorded (no feed_id in the
 * ledger) is something Amazon holds that we cannot account for - the resend is BLOCKED for a human.
 * Returns null when the resend is clear (report due + no orphan feed), else the hold reason. */
export async function unknownSettleCheck(db, seller, api, number) {
  const ev = db.prepare("SELECT ts FROM events WHERE seller_id=? AND type='upload_unknown_outcome' AND detail LIKE ? ORDER BY ts DESC LIMIT 1").get(seller.id, `%"number":"${number}"%`);
  if (!ev) return `No interruption record exists for ${number}, so the upload outcome cannot be reconstructed. It is NOT resent automatically - check it in Seller Central.`;
  const evTs = new Date(ev.ts).getTime();
  const since = new Date(evTs - 15 * 60e3).toISOString(), until = evTs + 15 * 60e3;
  if (typeof api.listFeeds !== 'function') return `Amazon's feed list is not available to cross-check the interrupted upload of ${number}, so it is NOT resent automatically. Check it in Seller Central.`;
  let feeds;
  try { feeds = await api.listFeeds({ createdSince: since }); }
  catch (e) { return `The cross-check against Amazon's feed list failed (${explain(e.message)}), so ${number} is NOT resent automatically. Try the next sync, or check it in Seller Central.`; }
  const known = new Set(db.prepare('SELECT feed_id FROM invoices WHERE seller_id=? AND feed_id IS NOT NULL').all(seller.id).map(r => r.feed_id));
  const orphans = (feeds ?? []).filter(f => !known.has(f.feedId) && !['FATAL', 'CANCELLED'].includes(f.status) && new Date(f.createdTime).getTime() <= until);
  if (orphans.length) return `Amazon's feed list shows feed ${orphans[0].feedId} (created ${orphans[0].createdTime}) from the interruption window of ${number} that we never recorded - Amazon may hold the document, so it is NOT resent automatically. Check that feed in Seller Central.`;
  return null;
}

/** Fresh-report settling for correction documents whose upload outcome is unknown. An event still
 * listed as CreditNotePending is strong evidence that Amazon holds nothing - cross-checked against
 * Amazon's own feed list (unknownSettleCheck) before the SAME document is resubmitted, because the
 * report alone can lag a feed that just entered processing. Anything not freshly due, or blocked by
 * the cross-check, keeps waiting (a verdict row settles through reconcileCreditNote/reconcileInvoice).
 * Plain invoices settle through processReport's normal path, under the same cross-check. */
export async function settleUnknownDocuments(db, seller, reportText, { api, validate }) {
  const out = { resubmitted: [], waiting: [] };
  const due = new Set(parseVidr(reportText).filter(s => s.invoiceStatus === 'CreditNotePending').map(s => s.key));
  for (const inv of db.prepare("SELECT number, shipment_key, rectifies FROM invoices WHERE seller_id=? AND kind='rectificativa' AND upload_status='unknown'").all(seller.id)) {
    if (!due.has(inv.shipment_key)) { out.waiting.push(inv.number); continue; }
    const block = await unknownSettleCheck(db, seller, api, inv.number);
    if (block) { logEvent(db, seller.id, 'unknown_resend_blocked', { number: inv.number, reason: block }); out.waiting.push(inv.number); continue; }
    await issueRectificativa(db, seller, inv.rectifies, { recordKey: inv.shipment_key, allowUnknownRetry: true }, { api, validate });
    closeRepairsFor(db, seller.id, [`UNKNOWN:${inv.shipment_key}`], 'issued');
    logEvent(db, seller.id, 'unknown_settled_resubmitted', { number: inv.number });
    out.resubmitted.push(inv.number);
  }
  return out;
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
  // 'unknown' is NOT done: the fresh report in hand still lists the event as needing the document -
  // strong evidence Amazon holds nothing, cross-checked against its own feed list (unknownSettleCheck)
  // before issueRectificativa (allowUnknownRetry) resubmits the SAME document. Any settled state
  // (submitted/processing/uploaded/rejected) is done here.
  const done = (key) => { const r = db.prepare("SELECT upload_status FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa'").get(seller.id, key); return r && !['pending', 'unknown'].includes(r.upload_status); };
  // An 'unknown' document may only be resent after the feed-list cross-check clears it.
  const unknownBlock = async (key) => {
    const r = db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND shipment_key=? AND kind='rectificativa'").get(seller.id, key);
    if (!r || r.upload_status !== 'unknown') return null;
    return unknownSettleCheck(db, seller, api, r.number);
  };
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
    const block1 = await unknownBlock(s.key);
    if (block1) { logEvent(db, seller.id, 'unknown_resend_blocked', { key: s.key, reason: block1 }); out.skipped.push({ key: s.key, reason: block1 }); continue; }
    try {
      const o = JSON.parse(orig.json), zero = o.lines.map(l => ({ ...l, excl: 0, vat: 0 }));
      await issueRectificativa(db, seller, orig.number, { mode: 'differences', reason: reasonOf(s), changes: { lines: zero }, documentType: 'CreditNote', transactionId: s.transactionId, recordKey: s.key, allowUnknownRetry: true }, { api, validate }); out.creditNotes++;
    } catch (e) { out.errors.push({ key: s.key, error: explain(e.message) }); }
  }
  for (const s of list.filter(s => s.isCorrectedTx)) {
    if (done(s.key)) continue;
    const orig = original(s); if (!orig) { out.skipped.push({ key: s.key, reason: 'original invoice not issued by us' }); continue; }
    const block2 = await unknownBlock(s.key);
    if (block2) { logEvent(db, seller.id, 'unknown_resend_blocked', { key: s.key, reason: block2 }); out.skipped.push({ key: s.key, reason: block2 }); continue; }
    // Round-6: "landed" means Amazon CONFIRMED the credit note (VIDR CreditNoteUploaded), not merely
    // that a feed exists. 'submitted' is only a created feed id and 'processing' a running feed -
    // both can still end FATAL/CANCELLED or rejected, and the replacement would then be stranded as
    // a half pair at Amazon. The pair waits for acceptance; the next sync picks it up.
    const cn = db.prepare("SELECT 1 FROM invoices WHERE seller_id=? AND rectifies=? AND kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%' AND upload_status='uploaded'").get(seller.id, orig.number);
    if (!zeroTotal(orig) && !cn) { out.skipped.push({ key: s.key, reason: 'credit-note reversal not yet confirmed accepted by Amazon - the pair is kept together and the replacement waits for the next report' }); continue; }
    try {
      await issueRectificativa(db, seller, orig.number, { mode: 'substitution', reason: reasonOf(s), changes: { buyer: { name: s.billing.name || s.buyerCompany, vat: s.buyerVat ?? undefined, address: [...s.billing.lines, `${s.billing.postal} ${s.billing.city}`.trim(), s.billing.country].filter(Boolean) } }, documentType: 'Invoice', transactionId: s.transactionId, recordKey: s.key, allowUnknownRetry: true }, { api, validate }); out.invoices++;
    } catch (e) { out.errors.push({ key: s.key, error: explain(e.message) }); }
  }
  return out;
}
