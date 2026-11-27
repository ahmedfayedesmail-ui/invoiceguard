// RESEARCH LAB. Not connected to issuance, the app, the database or the browser bundle. Pure, deterministic, synthetic input only.
// Design: docs/night-shift/RECONCILIATION-ARCHITECTURE.md. Nothing here is approved for integration.
// Input contracts (every amount is a raw string, parsed with the Stage 1 parser, so UNKNOWN stays UNKNOWN and is never zero):
//   vidr:     [{ doc, line, shipmentKey, orderId, itemId, currency, gross }]          what Amazon says is owed
//   orders:   [{ doc, line, orderId, itemId, currency, gross }]                      order-level intent (Order / All Orders report)
//   invoices: [{ number, shipmentKey, kind: 'invoice'|'credit', currency, gross, transactionId }]   what WE issued
//   statuses: [{ doc, line, number, transactionId, status }]                         what a LATER Amazon report says
import { parseAmount } from '../../src/integrity-core.js';
import { sha256 as sha256Hex } from '../../src/loop/sha256.js';

export const UNKNOWN = 'UNKNOWN';
const ACCEPT = new Set(['InvoiceUploaded', 'CreditNoteUploaded']), REJECT = new Set(['InvoiceRejected', 'CreditNoteRejected']);
const money = (c) => `${c < 0n ? '-' : ''}${(c < 0n ? -c : c) / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, '0')}`;
const cents = (raw) => { const p = parseAmount(raw); return p.state === 'VALID' ? p.cents : null; };
const prov = (o) => ({ doc: o.doc ?? 'ours', line: o.line ?? null });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Returns { shipments: [...sorted by key], orderLinks, digest }. The digest covers the whole output, so reproducibility is checkable. */
export function reconcile({ vidr = [], orders = [], invoices = [], statuses = [] } = {}) {
  const ships = new Map(); const get = (k) => { if (!ships.has(k)) ships.set(k, { shipmentKey: k, lines: [], invoices: [], statuses: [], links: [], findings: [] }); return ships.get(k); };
  for (const r of vidr) { const s = get(r.shipmentKey); s.lines.push(r); s.links.push({ a: prov(r), b: { shipment: r.shipmentKey }, relation: 'VIDR_LINE_IN_SHIPMENT', strength: 'PROVABLE', rule: 'L1 same shipment key' }); }
  for (const i of invoices) { const s = get(i.shipmentKey); s.invoices.push(i); s.links.push({ a: { invoice: i.number }, b: { shipment: i.shipmentKey }, relation: 'INVOICE_FOR_SHIPMENT', strength: 'PROVABLE', rule: 'L2 invoice stores its shipment key' }); }
  const byNumber = new Map(invoices.map(i => [i.number, i]));
  for (const st of statuses) {
    const inv = byNumber.get(st.number); if (!inv) { get('(unmatched status)').findings.push({ code: 'STATUS_FOR_UNKNOWN_DOCUMENT', severity: 'INFO', detail: prov(st) }); continue; }
    const s = get(inv.shipmentKey), exact = st.transactionId && inv.transactionId && st.transactionId === inv.transactionId;
    s.statuses.push({ ...st, strength: exact ? 'PROVABLE' : 'CANDIDATE' });
    s.links.push({ a: prov(st), b: { invoice: inv.number }, relation: 'STATUS_FOR_INVOICE', strength: exact ? 'PROVABLE' : 'CANDIDATE', rule: exact ? 'L3 number and TransactionId verbatim' : 'L3b number only, TransactionId missing or different: not accepted as evidence' });
  }
  // order items to shipments
  const itemShips = new Map(); for (const r of vidr) { const k = r.orderId + '|' + (r.itemId ?? ''); itemShips.set(k, new Set([...(itemShips.get(k) ?? []), r.shipmentKey])); }
  const orderLinks = [];
  for (const o of orders) {
    const hit = itemShips.get(o.orderId + '|' + (o.itemId ?? '')), anyOrder = vidr.some(r => r.orderId === o.orderId);
    if (!anyOrder) { orderLinks.push({ a: prov(o), b: null, relation: 'ORDER_NOT_IN_VIDR', strength: 'NONE', rule: 'no VIDR row for this order-id' }); continue; }
    if (!o.itemId || !hit) { orderLinks.push({ a: prov(o), b: { orderId: o.orderId }, relation: 'ORDER_IN_VIDR_ITEM_UNMATCHED', strength: 'CANDIDATE', rule: 'order-id equal, item not provable' }); continue; }
    const keys = [...hit].sort(); const strength = keys.length === 1 ? 'PROVABLE' : 'CANDIDATE';
    orderLinks.push({ a: prov(o), b: { shipments: keys }, relation: 'ORDER_ITEM_IN_SHIPMENT', strength, rule: strength === 'PROVABLE' ? 'order-id and item-id equal, one shipment' : 'item appears in several shipments' });
    if (strength === 'PROVABLE') {
      const s = get(keys[0]), line = s.lines.find(l => l.orderId === o.orderId && (l.itemId ?? '') === (o.itemId ?? ''));
      if (line && String(line.currency ?? '').trim().toUpperCase() !== String(o.currency ?? '').trim().toUpperCase()) s.findings.push({ code: 'CURRENCY_CONTRADICTION', severity: 'HOLD', detail: { vidr: prov(line), order: prov(o) }, needsHuman: 'The two reports state different currencies for the same item.' });
      else if (line && cents(line.gross) !== null && cents(o.gross) !== null && cents(line.gross) !== cents(o.gross)) s.findings.push({ code: 'ITEM_AMOUNT_CONTRADICTION', severity: 'HOLD', detail: { vidr: money(cents(line.gross)), order: money(cents(o.gross)), vidrAt: prov(line), orderAt: prov(o) }, needsHuman: 'The order report and the VIDR give different amounts for the same item. Neither is chosen.' });
    }
  }
  const out = [];
  for (const k of [...ships.keys()].sort(cmp)) {
    const s = ships.get(k); if (k === '(unmatched status)') { out.push(s); continue; }
    // expected: exact cents, UNKNOWN as soon as one line is unreadable or currencies differ
    const curs = new Set(s.lines.map(l => String(l.currency ?? '').trim().toUpperCase())), vals = s.lines.map(l => cents(l.gross));
    const expected = !s.lines.length ? UNKNOWN : curs.size !== 1 || vals.includes(null) ? UNKNOWN : vals.reduce((a, b) => a + b, 0n);
    if (s.lines.length && curs.size > 1) s.findings.push({ code: 'CURRENCY_CONTRADICTION', severity: 'HOLD', detail: { currencies: [...curs].sort() }, needsHuman: 'The lines of one shipment state different currencies.' });
    const ords = s.invoices.filter(i => i.kind === 'invoice'), crs = s.invoices.filter(i => i.kind === 'credit');
    if (ords.length > 1) s.findings.push({ code: 'DOUBLE_INVOICE', severity: 'BLOCK', detail: { numbers: ords.map(i => i.number).sort() }, needsHuman: 'More than one ordinary invoice exists for one shipment.' });
    const iv = (arr) => { const v = arr.map(i => cents(i.gross)); return v.includes(null) ? UNKNOWN : v.reduce((a, b) => a + b, 0n); };
    const invoiced = iv(ords), credited = iv(crs);
    const net = invoiced === UNKNOWN || credited === UNKNOWN ? UNKNOWN : invoiced - credited;
    const accepted = (() => { const ex = s.statuses.filter(x => x.strength === 'PROVABLE'); if (ex.some(x => REJECT.has(x.status))) return 'REJECTED'; if (ords.length && ex.some(x => ACCEPT.has(x.status))) return 'ACCEPTED'; return 'NOT_CONFIRMED'; })();
    if (accepted === 'REJECTED') s.findings.push({ code: 'REJECTED_BY_AMAZON', severity: 'HOLD', detail: { numbers: s.statuses.filter(x => REJECT.has(x.status)).map(x => x.number).sort() }, needsHuman: 'Amazon reports the upload as rejected. A corrected upload is a human step.' });
    const unexplained = !ords.length ? 'NOT_INVOICED' : expected === UNKNOWN || net === UNKNOWN ? UNKNOWN : expected - net;
    if (typeof unexplained === 'bigint' && unexplained !== 0n && !crs.length) s.findings.push({ code: 'UNEXPLAINED_AMOUNT', severity: 'HOLD', detail: { cents: money(unexplained) }, needsHuman: 'Expected and invoiced differ and nothing explains it.' });
    out.push({ shipmentKey: k, expected: expected === UNKNOWN ? UNKNOWN : money(expected), invoiced: invoiced === UNKNOWN ? UNKNOWN : money(invoiced), credited: credited === UNKNOWN ? UNKNOWN : money(credited), accepted, unexplained: typeof unexplained === 'bigint' ? money(unexplained) : unexplained, evidence: { lines: s.lines.map(prov), invoices: s.invoices.map(i => i.number).sort(), statuses: s.statuses.map(x => ({ ...prov(x), strength: x.strength })) }, links: s.links, findings: s.findings, needsHuman: s.findings.filter(f => f.needsHuman).map(f => f.needsHuman) });
  }
  const result = { shipments: out, orderLinks };
  return { ...result, digest: sha256Hex(JSON.stringify(result)) };
}
