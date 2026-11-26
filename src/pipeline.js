import { parseVidr, needsInvoice } from './vidr.js';
import { validateVat } from './vies.js';
import { buildInvoice, buildRectificativa } from './invoice.js';
import { verifyBuyer, hasOverride } from './verify.js';
import { buyerCountryCheck } from './features.js';
import { gate, gateReason, missingFields, correctionWindowOk, readiness } from './rules.js';
import { renderPdf } from './pdf.js';
import { logEvent, appendAudit } from './db.js';
import { MARKETPLACE } from './spapi.js';

const DUE_HOURS = 24; // Amazon's documented VCS report SLA; configurable until confirmed for non-VCS sellers.

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
    if (!needsInvoice(s)) { out.skipped++; continue; }
    out.detected++;
    const existing = db.prepare('SELECT status FROM shipments WHERE seller_id=? AND key=?').get(seller.id, s.key);
    if (existing && ['submitted', 'uploaded', 'ready'].includes(existing.status)) { out.skipped++; continue; }
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
      const feedId = await api.uploadInvoice({ marketplaceId: MARKETPLACE[s.marketplace] ?? MARKETPLACE[s.billing.country], pdf, orderId: s.orderId, shippingId: s.shippingId, number: inv.number, total: inv.totals.incl, vat: inv.totals.vat });
      db.prepare("UPDATE invoices SET feed_id=?, upload_status='submitted' WHERE seller_id=? AND number=?").run(feedId, seller.id, inv.number);
      upsertShipment(db, seller.id, s, 'submitted'); logEvent(db, seller.id, 'submitted', { number: inv.number, feedId }); out.uploaded++;
    } catch (e) { db.prepare("UPDATE invoices SET upload_status='pending' WHERE seller_id=? AND number=?").run(seller.id, inv.number); upsertShipment(db, seller.id, s, 'error', explain(e.message)); out.errors.push({ key: s.key, error: e.message }); }
  }
  return out;
}

/** Poll processing feeds and move them to uploaded / rejected. */
export async function pollFeeds(db, seller, api) {
  const res = { uploaded: 0, rejected: 0, pending: 0 };
  for (const r of db.prepare("SELECT number, feed_id, shipment_key FROM invoices WHERE seller_id=? AND upload_status='submitted'").all(seller.id)) {
    const f = await api.feedStatus(r.feed_id);
    if (f.status === 'DONE') { db.prepare("UPDATE invoices SET upload_status='uploaded', uploaded_at=? WHERE seller_id=? AND number=?").run(new Date().toISOString(), seller.id, r.number); db.prepare("UPDATE shipments SET status='uploaded' WHERE seller_id=? AND key=?").run(seller.id, r.shipment_key); res.uploaded++; }
    else if (['FATAL', 'CANCELLED'].includes(f.status)) { db.prepare("UPDATE invoices SET upload_status='rejected' WHERE seller_id=? AND number=?").run(seller.id, r.number); db.prepare("UPDATE shipments SET status='rejected' WHERE seller_id=? AND key=?").run(seller.id, r.shipment_key); res.rejected++; }
    else res.pending++;
  }
  return res;
}

/** Issue a rectificativa for an existing invoice and upload it. */
export async function issueRectificativa(db, seller, originalNumber, opts, { api, validate = validateVat } = {}) {
  const row = db.prepare('SELECT json, shipment_key FROM invoices WHERE seller_id=? AND number=?').get(seller.id, originalNumber);
  if (!row) throw new Error(`Invoice ${originalNumber} not found`);
  const original = JSON.parse(row.json);
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
  const feedId = manual ? null : await api.uploadInvoice({ marketplaceId: MARKETPLACE[s.marketplace], pdf, orderId: s.orderId, shippingId: s.shippingId, number: rect.number, total: Math.abs(rect.totals.incl), vat: Math.abs(rect.totals.vat), documentType, transactionId: opts.transactionId ?? s.transactionId });
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, rect.number, opts.recordKey ?? row.shipment_key, 'rectificativa', originalNumber, new Date().toISOString(), rect.totals.incl, rect.totals.vat, JSON.stringify(rect), feedId, manual ? 'ready' : 'submitted');
  appendAudit(db, seller.id, 'rectificativa', rect.number, rect);
  logEvent(db, seller.id, 'rectificativa', { number: rect.number, rectifies: originalNumber });
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
  const done = (key) => db.prepare('SELECT 1 FROM invoices WHERE seller_id=? AND shipment_key=?').get(seller.id, key);
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
