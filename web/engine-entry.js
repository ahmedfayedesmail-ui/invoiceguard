// Local engine: the same parsing, checks and PDF rendering as the server app, run entirely in the browser.
// Nothing here touches the network. VIES (the EU VAT register lookup) is NOT run: the EU service does not allow browser calls.
import { planUpload } from '../src/manual.js';
import { verifyBuyer } from '../src/verify.js';
import { readiness, missingFields } from '../src/rules.js';
import { buildInvoice } from '../src/invoice.js';
import { renderPdf } from '../src/pdf.js';

const stmt = { get: () => undefined, all: () => [], run: () => ({}) };
const stubDb = { prepare: () => stmt, exec: () => {} };
const sellerFor = (s, country) => ({ id: 'local', name: 'SAMPLE SELLER (not a real invoice)', nif: s.sellerVat || '', address: 'Sample address', country, invoice_lang: 'auto', profile: '{}' });

/** @returns plain, JSON-safe summary: what would be invoiced, what is held (with the reason) and what is skipped. */
export async function analyze(text, { country = 'ES', useDeliveryAddress = false } = {}) {
  const plan = planUpload(String(text ?? ''), { useDeliveryAddress });
  if (!plan.ok) return { ok: false, error: plan.error, format: plan.format ?? null };
  const rd = readiness(country, 'issue');
  const ready = [], held = plan.held.map(h => ({ orderId: h.orderId, reason: h.reason }));
  for (const s of plan.shipments) {
    const reasons = [];
    if (s.buyerVat) { const chk = await verifyBuyer(stubDb, sellerFor(s, country), s, null, {}); if (chk.hold) reasons.push(chk.hold.reason); }
    if (!rd.ok) reasons.push(rd.reason);
    else {
      const doc = buildInvoice(stubDb, sellerFor(s, country), s, { date: new Date(), number: 'PREVIEW' });
      const miss = missingFields(doc, country).filter(k => !/^seller\./.test(k));
      if (miss.length) reasons.push(`Invoice would miss required fields: ${miss.join(', ')}`);
    }
    (reasons.length ? held.push({ orderId: s.orderId, reason: reasons.join('; ') }) : ready.push({ orderId: s.orderId, buyer: s.buyerCompany || s.billing?.name || '', buyerVat: s.buyerVat || '', country: s.shipCountry || s.billing?.country || '', currency: s.currency, total: s.incl, vat: s.vat }));
    s.__ok = !reasons.length;
  }
  analyze.last = plan.shipments; analyze.country = country;
  // one number for the size band only (EUR orders held by a check); the page never shows or sends it
  const heldValueEur = plan.shipments.filter(s => !s.__ok && s.currency === 'EUR' && Number.isFinite(s.incl)).reduce((a, s) => a + s.incl, 0);
  return { ok: true, heldValueEur, format: plan.format, formatName: plan.formatName, rows: plan.rows, truncated: !!plan.truncated, ready, held, skipped: plan.skipped ?? [], viesRun: false };
}

/** Renders a clearly marked SAMPLE invoice PDF for the n-th ready shipment of the last analysis. */
export async function samplePdf(orderId) {
  const s = (analyze.last ?? []).find(x => x.orderId === orderId && x.__ok);
  if (!s) throw new Error('No such ready shipment');
  const doc = buildInvoice(stubDb, sellerFor(s, analyze.country), s, { date: new Date(), number: 'SAMPLE-0001' });
  const buf = await renderPdf(doc);
  return new Uint8Array(buf);
}
