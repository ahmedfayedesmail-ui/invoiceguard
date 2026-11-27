// Issuance Integrity Gate, pure part (Phase B, stage 1). No node: imports, so the browser bundle can use it. The ledger lives in integrity.js. Design: docs/PHASE-B-DESIGN.md.
// assessShipment is PURE: it reads only what parseVidr recorded (physical line and RAW tokens of each row) and returns findings. It uses the file's own arithmetic and consistency, never a tax rule, and never repairs or guesses.
// Severity: BLOCK = the file contradicts itself (nothing can release it). HOLD = not issued until the cause is removed; resolution NEW_EVIDENCE (only a corrected file) or HUMAN_DECISION (a recorded decision tied to the exact evidence).
import { sha256 } from './loop/sha256.js';

const sha = (x) => sha256(typeof x === 'string' ? x : JSON.stringify(x));
const PARTS = ['item', 'shipping', 'gift-wrap', 'item-promo', 'shipping-promo', 'gift-promo'];

/** Exact reading of one amount token: MISSING (blank), INVALID (never zero), VALID (exact integer cents, a real 0.00 is VALID). Ambiguous separators and more than two decimals are INVALID. */
export function parseAmount(token) {
  const t = String(token ?? '').trim();
  if (!t) return { state: 'MISSING' };
  if (t.length > 40) return { state: 'INVALID', why: 'too long' };
  const m = /^([+-]?)(\d[\d.,]*)$/.exec(t); if (!m) return { state: 'INVALID', why: 'not a plain decimal number' };
  const neg = m[1] === '-', body = m[2];
  if (/[.,]$/.test(body) || /[.,]{2}/.test(body)) return { state: 'INVALID', why: 'misplaced separator' };
  const seps = [...body].filter(c => c === '.' || c === ',');
  const toCents = (int, frac) => { const v = BigInt(int) * 100n + BigInt((frac || '').padEnd(2, '0')); return { state: 'VALID', cents: neg ? -v : v }; };
  if (!seps.length) return toCents(body, '');
  const kinds = new Set(seps), last = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
  const grouped = (s, g) => { const p = s.split(g); return p.length > 1 && p[0].length >= 1 && p[0].length <= 3 && p.slice(1).every(x => x.length === 3); };
  if (kinds.size === 2) {
    const dec = body[last], grp = dec === '.' ? ',' : '.', ip = body.slice(0, last), fp = body.slice(last + 1);
    if (ip.includes(dec) || !/^\d{1,2}$/.test(fp) || !grouped(ip, grp)) return { state: 'INVALID', why: 'inconsistent separators' };
    return toCents(ip.split(grp).join(''), fp);
  }
  const sep = [...kinds][0];
  if (seps.length > 1) return grouped(body, sep) ? toCents(body.split(sep).join(''), '') : { state: 'INVALID', why: 'inconsistent separators' };
  const [ip, fp] = body.split(sep);
  if (fp.length === 3) return { state: 'INVALID', why: 'ambiguous: thousands or decimals' };
  if (fp.length > 3 || fp.length === 0) return { state: 'INVALID', why: 'more than two decimals' };
  return fp.length > 2 ? { state: 'INVALID', why: 'more than two decimals' } : toCents(ip, fp);
}
const fmt = (c) => `${c < 0n ? '-' : ''}${(c < 0n ? -c : c) / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, '0')}`;
/** A rate as an exact decimal fraction: {num, den} or null. Both '.' and ',' accepted as the decimal mark. */
const parseRate = (token) => { const t = String(token ?? '').trim(); const m = /^(\d{1,3})(?:[.,](\d{1,6}))?$/.exec(t); if (!m) return null; const d = m[2] ?? ''; return { num: BigInt(m[1] + d), den: 10n ** BigInt(d.length) }; };
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/; // YYYY-MM-DD, or an ISO date-time with an explicit time zone. Nothing else (no DMY, no MDY, no zone-less time) until a source-specific format is documented and tested.
export const SUPPORTED_CURRENCIES = Object.freeze(['EUR', 'GBP', 'PLN', 'SEK']); // two minor units each (ISO 4217). A fixed list, not a rule: any other currency is held until its minor units are verified and this list is widened on purpose.
const isoMs = (v) => { const m = ISO.exec(String(v ?? '').trim()); if (!m) return null; const [y, mo, d] = [+m[1], +m[2], +m[3]], t = Date.UTC(y, mo - 1, d); const dt = new Date(t); if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; const p = Date.parse(String(v).trim()); return Number.isNaN(p) ? null : p; };
const QTY = /^[1-9]\d{0,8}$/;
const PLAIN = new Set(['currency', 'shipment-date', 'ship-country', 'ship-from-country', 'bill-country', 'marketplace-id', 'invoice-status', 'buyer-tax-registration-type', 'order-id']); // everything else is buyer or seller data and is shown only as "value 1, value 2"
const clean = (v) => String(v).replace(/[^\w:.+\- ]/g, '').slice(0, 40);
const upper = new Set(['currency', 'ship-country', 'ship-from-country', 'bill-country']);

export function assessShipment(s) {
  const findings = [], notChecked = [], rows = s.src ?? [];
  const add = (code, severity, resolution, field, lines, evidence, explanation, action, raw) => {
    const key = code + '|' + field; let f = findings.find(x => x.k === key);
    if (f) { for (const l of lines) if (!f.evidence.lines.includes(l)) f.evidence.lines.push(l); f.evidence.lines.sort((a, b) => a - b); f.raw.push(...raw); return; }
    findings.push({ k: key, code, severity, resolution, evidence: { field, lines: [...new Set(lines)].sort((a, b) => a - b), ...evidence }, explanation, action, raw: [...raw] });
  };
  const ln = (r) => r.line ?? 0;
  const NEW = 'Download the report again, or correct the value in your own copy, and upload it. Nothing can be approved for this by hand.';
  const txType = String(s.transactionType ?? 'SHIPMENT').trim().toUpperCase();
  if (txType !== 'SHIPMENT') add('TRANSACTION_TYPE_UNSUPPORTED', 'HOLD', 'UNSUPPORTED_PATH', 'transaction-type', rows.map(ln), { transactionType: clean(txType) || '(blank)' }, `This row is a ${clean(txType) || 'blank'} transaction. Only shipment invoices are built here, so nothing was issued. The amounts are not treated as wrong: refunds and returns legitimately carry negative amounts, and the credit note path is not built yet.`, 'No action on the amounts. This type needs a path that is not built yet.', [txType]);
  const curs = [...new Set(rows.map(r => String(r.attrs.currency ?? '').trim().toUpperCase()))];
  for (const c of curs) if (!SUPPORTED_CURRENCIES.includes(c)) add('CURRENCY_UNSUPPORTED', 'HOLD', 'NEW_EVIDENCE', 'currency', rows.filter(r => String(r.attrs.currency ?? '').trim().toUpperCase() === c).map(ln), { currency: c ? clean(c) : '(blank)', supported: SUPPORTED_CURRENCIES }, `The currency ${c ? clean(c) : '(blank)'} is outside the supported list (${SUPPORTED_CURRENCIES.join(', ')}), so nothing was issued. Its decimal places are not assumed.`, 'Only a version that has verified this currency can issue it. Nothing can be approved by hand.', [c]);
  let totalCents = 0n, totalKnown = rows.length > 0;
  const rateSeen = new Set();
  for (const r of rows) {
    const q = String(r.qty ?? '').trim();
    if (!QTY.test(q)) add('QUANTITY_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', 'quantity-purchased', [ln(r)], {}, `The quantity-purchased cell on line ${ln(r)} is not a whole number of one or more, so nothing was issued. The quantity is never assumed to be 1.`, NEW, [q]);
    const qty = QTY.test(q) ? Number(q) : 1;
    for (const p of PARTS) {
      const t = r.parts[p], A = { incl: parseAmount(t.incl), vat: parseAmount(t.vat), excl: parseAmount(t.excl) };
      const names = { incl: `${p}-vat-incl-amount`, vat: `${p}-vat-amount`, excl: `${p}-vat-excl-amount` };
      const present = Object.values(A).some(x => x.state !== 'MISSING');
      if (!present && p !== 'item') continue;
      let ok = true;
      for (const k of ['incl', 'vat', 'excl']) {
        if (A[k].state === 'INVALID') { ok = false; add('AMOUNT_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', names[k], [ln(r)], { reason: A[k].why }, `The ${names[k]} cell on line ${ln(r)} could not be read as an amount (${A[k].why}), so nothing was issued. It is never read as zero.`, NEW, [String(t[k])]); }
        else if (A[k].state === 'MISSING') { ok = false; add('AMOUNT_INCOMPLETE', 'HOLD', 'NEW_EVIDENCE', names[k], [ln(r)], {}, `The ${names[k]} cell on line ${ln(r)} is empty while other amounts of the ${p} part are filled in, so nothing was issued. The missing amount is never worked out or assumed.`, NEW, ['']); }
      }
      const rt = String(t.rate ?? '').trim(), rate = rt ? parseRate(rt) : null;
      if (rt && !rate) add('AMOUNT_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', `${p}-vat-rate`, [ln(r)], { reason: 'not a plain decimal number' }, `The ${p}-vat-rate cell on line ${ln(r)} could not be read as a rate, so nothing was issued. It is never read as 0%.`, NEW, [rt]);
      if (!ok) { totalKnown = false; continue; }
      const incl = A.incl.cents, vat = A.vat.cents, excl = A.excl.cents; totalCents += incl;
      const tol = p === 'item' && qty > 1 ? 2n : 1n, diff = incl - (excl + vat);
      if ((diff < 0n ? -diff : diff) > tol) add('AMOUNT_INCONSISTENT', 'HOLD', 'NEW_EVIDENCE', p, [ln(r)], { values: { incl: fmt(incl), vat: fmt(vat), excl: fmt(excl) }, toleranceCents: Number(tol) }, `On line ${ln(r)} the ${p} amounts do not add up: the gross amount differs from net plus VAT by more than ${tol} cent. Nothing was issued, and we do not decide which number is right.`, NEW, [t.incl, t.vat, t.excl]);
      if (diff !== 0n && (diff < 0n ? -diff : diff) <= tol && findings.some(x => x.k === 'RND' + p)) { const f0 = findings.find(x => x.k === 'RND' + p); f0.evidence.lines.push(ln(r)); f0.raw.push(t.incl, t.vat, t.excl); }
      else if (diff !== 0n && (diff < 0n ? -diff : diff) <= tol) findings.push({ k: 'RND' + p, code: 'ROUNDING_DIFFERENCE', severity: 'INFO', resolution: null, evidence: { field: p, lines: [ln(r)], values: { incl: fmt(incl), vat: fmt(vat), excl: fmt(excl) }, differenceCents: Number(diff), toleranceCents: Number(tol) }, explanation: `On line ${ln(r)} the ${p} gross differs from net plus VAT by ${fmt(diff)}, inside the tolerance of ${tol} cent. This is shown, not hidden. The tolerance is an unproven assumption: how Amazon rounds has not been verified.`, action: 'Nothing is held for this. Compare with Seller Central if you want to be sure.', raw: [t.incl, t.vat, t.excl] });
      if (rate && rate.num <= rate.den) { const d = vat * rate.den - excl * rate.num, ad = d < 0n ? -d : d; if (ad > tol * rate.den) add('AMOUNT_RATE_MISMATCH', 'HOLD', 'NEW_EVIDENCE', p, [ln(r)], { values: { vat: fmt(vat), excl: fmt(excl), rate: rt } }, `On line ${ln(r)} the ${p} VAT does not match the stated rate ${rt} applied to the net amount (difference above ${tol} cent). Nothing was issued, and no rate is assumed.`, NEW, [t.vat, t.excl, rt]); }
      else if (rate) rateSeen.add(`the ${p} rate ${rt} is above 1, so its unit (fraction or percent) is not provable`);
      else if (!rt && vat !== 0n) rateSeen.add(`the ${p} rate is blank`);
    }
    // dates
    const sd = String(r.attrs['shipment-date'] ?? '').trim();
    if (!sd) add('DATE_MISSING', 'HOLD', 'NEW_EVIDENCE', 'shipment-date', [ln(r)], {}, `The shipment-date cell on line ${ln(r)} is empty. The shipment date is required: the due time and the invoice date come from it, so nothing was issued and no date is assumed.`, NEW, ['']);
    if (sd && isoMs(sd) === null) add('DATE_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', 'shipment-date', [ln(r)], {}, `The shipment-date cell on line ${ln(r)} is not a complete ISO date (year-month-day), so nothing was issued. Day and month order is never guessed.`, NEW, [sd]);
    const od = String(r.orderDate ?? '').trim();
    if (od && sd && isoMs(od) !== null && isoMs(sd) !== null && isoMs(od) > isoMs(sd)) add('DATE_ORDER', 'HOLD', 'HUMAN_DECISION', 'order-date', [ln(r)], {}, `The order-date on line ${ln(r)} is later than the shipment-date. That can be a time zone difference or a wrong value, and the file cannot tell which.`, 'Check the order in Seller Central. If the dates are right, record a decision with your reason. If not, upload a corrected report.', [od, sd]);
    else if (od && isoMs(od) === null) notChecked.push({ check: 'order-date', reason: 'the order-date is not a complete ISO date, so its order against the shipment date was not compared' });
  }
  for (const why of rateSeen) notChecked.push({ check: 'vat-vs-rate', reason: why });
  if (txType === 'SHIPMENT' && rows.length && totalKnown && totalCents <= 0n) add('NONPOSITIVE_TOTAL', 'HOLD', 'NEW_EVIDENCE', 'total', rows.map(ln), { values: { incl: fmt(totalCents) } }, `The total of this shipment (all amounts added) is ${fmt(totalCents)}, which is not an amount to invoice, so nothing was issued. A refund is a credit note, not a shipment invoice.`, NEW, [String(totalCents)]);
  // rows of one shipment that disagree: the first row used to win silently
  const fields = Object.keys(rows[0]?.attrs ?? {}), shown = [];
  for (const f of fields) {
    const norm = (v) => { const x = String(v ?? '').trim(); return upper.has(f) ? x.toUpperCase() : x; };
    const vals = rows.map(r => norm(r.attrs[f])), distinct = [...new Set(vals)];
    if (distinct.length > 1) add('SHIPMENT_FIELD_CONFLICT', 'BLOCK', null, f, rows.map(ln), { values: distinct.map((v, i) => v === '' ? '(blank)' : PLAIN.has(f) ? clean(v) : `value ${i + 1}`) }, `The rows of this shipment disagree on ${f}. The file contradicts itself, so nothing was issued, and the first row is not taken as the right one.`, 'Only a corrected report can resolve this. Download the report again and check these lines.', [JSON.stringify(distinct)]);
    void shown;
  }
  // duplicates: the SKU is never a signal
  const byId = new Map(), bySig = new Map();
  for (const r of rows) { const id = String(r.itemId ?? '').trim(); if (id) { byId.set(id, [...(byId.get(id) ?? []), r]); } else { bySig.set(r.sig, [...(bySig.get(r.sig) ?? []), r]); } }
  for (const [id, g] of byId) if (g.length > 1) add('DUPLICATE_ITEM_ROW', 'HOLD', 'NEW_EVIDENCE', 'order-item-id', g.map(ln), {}, `The same order-item-id appears on ${g.length} rows of this shipment (lines ${g.map(ln).join(', ')}), so the same item may be counted twice. Nothing was issued.`, NEW, [id]);
  for (const g of bySig.values()) if (g.length > 1) add('DUPLICATE_ITEM_ROW', 'HOLD', 'HUMAN_DECISION', 'row', g.map(ln), {}, `Lines ${g.map(ln).join(', ')} are identical in every cell and have no order-item-id. Two identical units can be legitimate, a repeated row is not, and the file cannot tell which.`, 'Check the order in Seller Central. If the order really has these identical units, record a decision with your reason. If not, upload a corrected report.', [g[0].sig, String(g.length)]);
  if ((s.orderShipments ?? 1) > 1) findings.push({ k: 'SPLIT', code: 'SPLIT_SHIPMENT', severity: 'INFO', resolution: null, evidence: { field: 'order-id', lines: rows.map(ln), shipments: s.orderShipments }, explanation: `This order has ${s.orderShipments} shipments in the file. They are kept separate and never merged.`, action: 'No action needed.', raw: [] });
  const out = findings.map(({ k, raw, ...f }) => ({ ...f, fingerprint: sha([f.code, f.evidence.field, f.evidence.lines, raw]) }));
  const verdict = out.some(f => f.severity === 'BLOCK') ? 'BLOCK' : out.some(f => f.severity === 'HOLD') ? 'HOLD' : 'CLEAR';
  return { verdict, findings: out, notChecked };
}

