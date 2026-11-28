// Ruling 5: a verdict row on an ORIGINAL invoice is applied only when the report proves it is our document. Tests that feed an Invoice* verdict must therefore carry what a real
// authenticated All-view report carries: the document number of the stored invoice (invoice-number column) and the attempt sequence of the download. This helper adds exactly that; it never edits status or amounts.
import { currentAttemptSeq } from '../../src/db.js';
export function proved(db, sellerId, text) {
  const lines = String(text).replace(/\r/g, '').split('\n'); const head = lines[0].split('\t'); let ni = head.indexOf('invoice-number'); const si = head.indexOf('shipping-id'); const ti = head.indexOf('transaction-type');
  const num = (ship) => db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key=? ORDER BY issued_at DESC LIMIT 1").get(`SHIPMENT:${ship}`)?.number ?? '';
  const addCol = ni < 0; if (addCol) { ni = head.length; head.push('invoice-number'); }
  const out = [head.join('\t')];
  for (const l of lines.slice(1)) { if (!l.trim()) { out.push(l); continue; } const c = l.split('\t'); while (c.length < head.length - (addCol ? 1 : 0)) c.push(''); if (addCol) c.push(''); if (!c[ni]) c[ni] = (ti < 0 || c[ti] === 'SHIPMENT') ? num(c[si]) : ''; out.push(c.join('\t')); }
  return out.join('\n');
}
export const seqOpt = (db, sellerId) => ({ reportAttemptSeq: currentAttemptSeq(db, sellerId) });

/** Ruling 5: the one-shot human authorization of a retry after an unknown outcome. Valid by default; override fields to test refusals. */
export async function authorizeRetry(db, sellerId, eventKey, over = {}) {
  const { authorizeUnknownRetry } = await import('../../src/repair.js');
  const num = JSON.parse(db.prepare('SELECT suggestion FROM repairs WHERE seller_id=? AND event_key=?').get(sellerId, eventKey).suggestion).number;
  const bf = db.prepare('SELECT blocked_feed_id b FROM invoices WHERE seller_id=? AND number=?').get(sellerId, num)?.b ?? null;
  return authorizeUnknownRetry(db, sellerId, eventKey, { checkedBy: 'Reviewer A', checkedAt: new Date().toISOString(), result: 'document_not_found', reason: 'Checked Seller Central, no such document', feedId: bf ?? undefined, feedStatus: bf ? 'FATAL' : undefined, acknowledgeRisk: true, ...over }, 'owner-test');
}
