import { resolveLangs } from './lang.js';
import { nextNumber } from './db.js';
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (a) => r2(a.reduce((x, y) => x + y, 0));

export const EXTRA_LABEL = { shipping: 'Gastos de envío', 'gift-wrap': 'Envoltorio de regalo', 'item-promo': 'Promoción', 'shipping-promo': 'Promoción de envío', 'gift-promo': 'Promoción de regalo' };

// Country on the printed address: full name in the country's own language (postal convention), not a bare code.
const COUNTRY_AUTONYM = { ES: 'España', DE: 'Deutschland', FR: 'France', IT: 'Italia', NL: 'Nederland', BE: 'Belgique / België', PL: 'Polska', SE: 'Sverige', IE: 'Ireland', AT: 'Österreich', PT: 'Portugal', GB: 'United Kingdom' };
const countryLine = (code) => COUNTRY_AUTONYM[code] ?? code;
// Reverse of countryLine, for reading a buyer country back from a stored address line (older invoices).
const countryCodeOf = (line) => { if (!line) return line; if (COUNTRY_AUTONYM[line]) return line; const hit = Object.entries(COUNTRY_AUTONYM).find(([, n]) => n === line); return hit ? hit[0] : line; };

/** Build invoice lines from a parsed shipment. Amounts come from Amazon's own tax data (VIDR). */
export function linesFromShipment(s) {
  const lines = [];
  for (const it of s.items) {
    lines.push({ description: it.name || it.sku, sku: it.sku, qty: it.qty, unitExcl: it.unitExcl, rate: it.vatRate, excl: it.exclTotal, vat: it.vatTotal });
    for (const x of it.extras) lines.push({ description: EXTRA_LABEL[x.part], qty: 1, unitExcl: x.excl, rate: x.rate, excl: x.excl, vat: x.vat });
  }
  return lines;
}

export const totalsOf = (lines) => {
  const excl = sum(lines.map(l => l.excl)), vat = sum(lines.map(l => l.vat));
  return { excl, vat, incl: r2(excl + vat) };
};

/** Legal wording for 0% VAT. Prefer Amazon's own citation text from the report. */
// Intra-EU supply of GOODS: the supplier's sale is EXEMPT (art. 138 Directive 2006/112/EC, art. 25 LIVA in Spain). The buyer accounts for the VAT in their own state,
// but that is not "reverse charge" in the sense of a recipient-liable supply (art. 194), so the wording must not say so. Same legal basis in the buyer's language.
const INTRA_EU_NOTE = {
  DE: 'Innergemeinschaftliche steuerfreie Lieferung (Art. 138 MwStSystRL).',
  FR: 'Livraison intracommunautaire exon\u00e9r\u00e9e de TVA (art. 138 de la directive 2006/112/CE).',
  IT: 'Cessione intracomunitaria non imponibile IVA (art. 138 Direttiva 2006/112/CE).',
  NL: 'Intracommunautaire levering, vrijgesteld van btw (art. 138 Richtlijn 2006/112/EG).',
  PL: 'Wewn\u0105trzwsp\u00f3lnotowa dostawa towar\u00f3w zwolniona z VAT (art. 138 dyrektywy 2006/112/WE).',
  SE: 'Gemenskapsintern f\u00f6rs\u00e4ljning av varor, momsfri (art. 138 direktiv 2006/112/EG).',
  IE: 'Intra-Community supply of goods, exempt from VAT (art. 138 Directive 2006/112/EC).',
  BE: 'Intracommunautaire levering, vrijgesteld van btw (art. 138 Richtlijn 2006/112/EG).',
  PT: 'Entrega intracomunit\u00e1ria isenta de IVA (art. 138 da Diretiva 2006/112/CE).',
};
export const ES_INTRA_EU_FALLBACK = 'Entrega intracomunitaria exenta de IVA, art. 25 LIVA (art. 138 Directiva 2006/112/CE).';

// EU27 member states (ISO 3166 alpha-2). GB, CH, NO, XI etc. are NOT in it.
export const EU27 = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
// Prefix a VAT number carries when it differs from the ISO country code.
const VAT_PREFIX = { GR: 'EL' };
// Territories that sit outside the EU VAT area although the country code is an EU one. The ship postal code (s.shipPostal) decides; the billing postal is only a fallback when the file has no ship postal: [country, postal regex].
const SPECIAL_TERRITORY = [['ES', /^(35|38|51|52)\d{3}$/], ['DE', /^(78266|27498)$/], ['IT', /^(23030|22060)$/], ['FI', /^22\d{3}$/], ['FR', /^(97|98)\d{3}$/], ['GR', /^63086$/]];
const inSpecialTerritory = (country, postal) => { const p = String(postal ?? '').replace(/\s/g, ''); return SPECIAL_TERRITORY.some(([c, re]) => c === country && re.test(p)); };

/** The SHAPE of an intra-EU exempt supply of goods, without looking at the buyer: zero VAT on a positive amount, shipped between two different EU27 states, destination not a special territory. */
export function intraEUShape(s) {
  if (!(s && s.vat === 0 && s.excl > 0)) return false;
  const to = s.shipCountry, from = s.shipFromCountry;
  if (!EU27.has(to) || !EU27.has(from) || to === from) return false;
  // N4: key the exclusion on the SHIP destination. Ship postal (ship-postal-code) is authoritative; rows that disagree on it are refused.
  // Only when the file has no ship postal at all do we fall back to the billing postal, and only when billing country == ship country (best effort).
  if (s.shipPostalConflict) return false;
  const postal = s.shipPostal ? s.shipPostal : (s.billing?.country === to ? s.billing?.postal : null);
  if (inSpecialTerritory(to, postal)) return false;
  return true;
}
/** Intra-EU exempt supply to a buyer who can be treated as such: the shape, a buyer VAT number whose prefix is the destination state, and a VIES result that is not negative (valid is preferred; invalid or unavailable is not enough). */
export function isIntraEUExempt(s) {
  if (!intraEUShape(s) || !s.buyerVat) return false;
  const vat = String(s.buyerVat).replace(/\s/g, '').toUpperCase();
  if (!vat.startsWith(VAT_PREFIX[s.shipCountry] ?? s.shipCountry)) return false;
  if (s.__vies && s.__vies.status !== 'valid') return false;
  return true;
}

export function vatNote(s, country = 'ES') {
  const intraEU = isIntraEUExempt(s);
  const local = intraEU ? INTRA_EU_NOTE[s.shipCountry] : null;
  if (s.citation) return { text: local && !s.citation.includes(local.slice(0, 12)) ? s.citation + ' ' + local : s.citation, source: 'amazon' };
  if (country === 'ES' && intraEU) return { text: ES_INTRA_EU_FALLBACK + (local ? ' ' + local : ''), source: 'fallback_verify_with_accountant' };
  if (local) return { text: local, source: 'fallback_verify_with_accountant' };
  return null;
}

const hasPayment = (pf) => pf.paymentTermsDays != null || pf.discountTerms || pf.latePenaltyRate || pf.recoveryIndemnity;
function paymentOf(pf, date) {
  const p = {};
  if (pf.paymentTermsDays != null) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + pf.paymentTermsDays); p.termsDays = pf.paymentTermsDays; p.dueDate = d.toISOString().slice(0, 10); }
  if (pf.discountTerms) p.discountTerms = pf.discountTerms;
  if (pf.latePenaltyRate) p.latePenaltyRate = pf.latePenaltyRate;
  if (pf.recoveryIndemnity) p.recoveryIndemnity = pf.recoveryIndemnity;
  return p;
}
export function buildInvoice(db, seller, s, { date = new Date(), number } = {}) {
  let pf = {}; try { pf = JSON.parse(seller.profile || '{}') || {}; } catch { pf = {}; }
  const lines = linesFromShipment(s);
  const totals = totalsOf(lines);
  return {
    type: 'invoice', langs: resolveLangs(seller.invoice_lang ?? 'auto', seller.country ?? 'ES', s.billing.country), buyerCountry: s.billing.country, series: 'A', number: number ?? nextNumber(db, seller.id, 'A', date), issueDate: date.toISOString().slice(0, 10),
    operationDate: s.shipmentDate ? s.shipmentDate.slice(0, 10) : null, orderId: s.orderId, shippingId: s.shippingId, currency: s.currency, poNumber: s.poNumber,
    seller: { name: seller.name, nif: seller.nif, address: seller.address, ...(pf.registrationNo ? { registrationNo: pf.registrationNo } : {}) },
    ...(hasPayment(pf) ? { payment: paymentOf(pf, date) } : {}),
    buyer: { name: s.billing.name || s.buyerCompany, company: s.buyerCompany, vat: s.buyerVat, address: [...s.billing.lines, `${s.billing.postal} ${s.billing.city}`.trim(), countryLine(s.billing.country)].filter(Boolean) },
    lines, totals, vatNote: vatNote(s, seller.country ?? 'ES'),
  };
}

/**
 * Rectificativa (Spanish corrective invoice). The original is never edited.
 * mode 'substitution': full replacement invoice, new number in series R, references the original.
 * mode 'differences': only the deltas (negative = reduction), same reference.
 * changes: { buyer?: {...}, lines?: [...] (full corrected lines) }
 */
export function buildRectificativa(db, seller, original, { mode, reason, changes = {}, date = new Date(), number }) {
  if (!['substitution', 'differences'].includes(mode)) throw new Error('mode must be substitution or differences');
  if (!reason) throw new Error('A reason is required on a rectificativa');
  const corrected = { buyer: { ...original.buyer, ...(changes.buyer ?? {}) }, lines: changes.lines ?? original.lines };
  let lines = corrected.lines;
  if (mode === 'differences') {
    const delta = [];
    const n = Math.max(original.lines.length, corrected.lines.length);
    for (let i = 0; i < n; i++) {
      const a = original.lines[i], b = corrected.lines[i];
      const d = { excl: r2((b?.excl ?? 0) - (a?.excl ?? 0)), vat: r2((b?.vat ?? 0) - (a?.vat ?? 0)) };
      if (d.excl || d.vat) delta.push({ description: (b ?? a).description, qty: 1, unitExcl: d.excl, rate: (b ?? a).rate, ...d });
    }
    lines = delta;
  }
  const totals = totalsOf(lines);
  const buyerChanged = JSON.stringify(corrected.buyer) !== JSON.stringify(original.buyer);
  return {
    type: 'rectificativa', langs: resolveLangs(seller.invoice_lang ?? 'auto', seller.country ?? 'ES', original.buyerCountry ?? countryCodeOf(original.buyer.address?.at?.(-1))), buyerCountry: original.buyerCountry ?? countryCodeOf(original.buyer.address?.at?.(-1)), mode, series: 'R', number: number ?? nextNumber(db, seller.id, 'R', date), issueDate: date.toISOString().slice(0, 10),
    operationDate: original.operationDate, orderId: original.orderId, shippingId: original.shippingId, currency: original.currency, poNumber: original.poNumber,
    seller: { ...original.seller, ...(changes.seller ?? {}) }, buyer: corrected.buyer, lines, totals, vatNote: original.vatNote,
    rectifies: { number: original.number, issueDate: original.issueDate, reason, buyerChanged, previousBuyer: buyerChanged ? original.buyer : null, sellerChanged: !!changes.seller && JSON.stringify({ ...original.seller, ...changes.seller }) !== JSON.stringify(original.seller), previousSeller: changes.seller ? original.seller : null },
    // A differences invoice with zero amounts and changed buyer data only is not valid to describe the change; use substitution.
    warnings: mode === 'differences' && !lines.length ? ['Differences with no amount change: use substitution for data-only corrections'] : [],
  };
}

/**
 * Turn user edits into `changes` for buildRectificativa. Unchanged lines and fields stay byte-identical to the original.
 * edits: { buyerName?, buyerVat?, buyerAddress? (string, one line per row), lines?: [{index, qty?, unitExcl?, remove?}], newLines?: [{description, qty, unitExcl, rate}] }
 */
export function applyEdits(original, edits = {}) {
  const buyer = {}; let changed = false;
  const nm = String(edits.buyerName ?? '').trim(), vt = String(edits.buyerVat ?? '').replace(/\s/g, '').toUpperCase();
  if (nm && nm !== original.buyer.name) { buyer.name = nm; changed = true; }
  if (vt && vt !== original.buyer.vat) { buyer.vat = vt; changed = true; }
  if (edits.buyerAddress != null) {
    const addr = String(edits.buyerAddress).split(/\n/).map(x => x.trim()).filter(Boolean);
    const cur = (Array.isArray(original.buyer.address) ? original.buyer.address : [original.buyer.address]).filter(Boolean);
    if (addr.length && JSON.stringify(addr) !== JSON.stringify(cur)) { buyer.address = addr; changed = true; }
  }
  const seller = {}; const sn = String(edits.sellerName ?? '').trim(), sf = String(edits.sellerNif ?? '').trim().toUpperCase(), sa = String(edits.sellerAddress ?? '').trim();
  if (sn && sn !== original.seller.name) { seller.name = sn; changed = true; }
  if (sf && sf !== original.seller.nif) { seller.nif = sf; changed = true; }
  if (sa && sa !== original.seller.address) { seller.address = sa; changed = true; }
  const num = (v, what) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number of zero or more`); return n; };
  let lines = original.lines.map(l => ({ ...l }));
  const keep = lines.map(() => true);
  for (const e of edits.lines ?? []) {
    const l = lines[e.index]; if (!l) throw new Error('Unknown line ' + e.index);
    if (e.remove) { keep[e.index] = false; changed = true; continue; }
    const has = v => v !== undefined && v !== null && v !== '';
    const qty = has(e.qty) ? num(e.qty, 'Quantity') : l.qty, unit = has(e.unitExcl) ? num(e.unitExcl, 'Unit price') : l.unitExcl, rate = has(e.rate) ? num(e.rate, 'VAT rate') : l.rate;
    if (rate > 0.3) throw new Error('VAT rate is given as a fraction, for example 0.21');
    if (qty !== l.qty || unit !== l.unitExcl || rate !== l.rate) { const excl = r2(qty * unit); lines[e.index] = { ...l, qty, unitExcl: unit, rate, excl, vat: r2(excl * rate) }; changed = true; }
  }
  lines = lines.filter((_, i) => keep[i]);
  for (const n of edits.newLines ?? []) {
    const d = String(n.description ?? '').trim(); if (!d) throw new Error('A new line needs a description');
    const qty = num(n.qty, 'Quantity'), unit = num(n.unitExcl, 'Unit price'), rate = num(n.rate, 'VAT rate'); if (rate > 0.3) throw new Error('VAT rate is given as a fraction, for example 0.21');
    const excl = r2(qty * unit); lines.push({ description: d, qty, unitExcl: unit, rate, excl, vat: r2(excl * rate) }); changed = true;
  }
  if (!lines.length) throw new Error('A corrected invoice needs at least one line. To cancel the whole invoice, correct every amount to zero or ask your gestor.');
  const amountChanged = JSON.stringify(lines) !== JSON.stringify(original.lines);
  return { buyer, seller: Object.keys(seller).length ? seller : undefined, lines: amountChanged ? lines : undefined, changed, amountChanged };
}
